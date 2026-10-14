/**
 * Pembungkus `MediaRecorder` — adapter DOM dengan ketergantungan yang disuntik.
 *
 * `MediaRecorder` tidak ada di Node, jadi seluruh logika yang bisa diuji
 * dipisah ke sini sebagai kontrak kecil (`RecorderLike`) yang bisa dipalsukan
 * di tes. Yang diuji lewat adapter ini: kapan mulai, kapan berhenti, apa yang
 * terjadi kalau `stop()` dipanggil dua kali, apa yang terjadi kalau perekam
 * melempar, dan apakah batas durasi benar-benar menghentikan rekaman.
 *
 * Aturan yang dijaga:
 *
 *   · **`stop()` selalu mengembalikan `Blob`** — mungkin kosong, tapi tidak
 *     pernah melempar. Pemanggil tidak perlu membungkusnya try/catch.
 *   · **Data yang sudah terkumpul tidak dibuang** kalau perekam gagal di
 *     tengah jalan; yang ada tetap dikembalikan.
 *   · **Batas durasi dihormati** tanpa bergantung pada UI (kiosk bisa ditinggal
 *     tamu; rekaman tidak boleh jalan sampai disk penuh).
 */

/** Subset `MediaRecorder` yang dipakai. */
export interface RecorderLike {
  readonly state: string;
  start(timesliceMs?: number): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: ((event?: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RecorderOptions {
  mimeType?: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
}

export interface RecorderDeps {
  createRecorder(stream: MediaStream, options: RecorderOptions): RecorderLike;
  /** Penjadwal untuk batas durasi; disuntik supaya tes bebas timer nyata. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface VideoRecorderOptions {
  stream: MediaStream;
  mimeType: string | null;
  bitrateBps: number;
  audioBitrateBps: number;
  /** Batas durasi rekaman, milidetik. `0` = tanpa batas. */
  maxDurationMs?: number;
  /** Potongan data tiap X ms. `0`/tidak diisi = satu blob di akhir. */
  timesliceMs?: number;
}

export interface VideoRecorder {
  /** Mulai merekam. Idempoten: panggilan kedua diabaikan. */
  start(): void;
  /**
   * Hentikan dan ambil hasilnya. Selalu mengembalikan `Blob` (mungkin kosong).
   * Aman dipanggil berkali-kali dan sebelum `start()`.
   */
  stop(): Promise<Blob>;
  /** Sedang merekam? */
  readonly recording: boolean;
  /** Jumlah potongan data yang sudah diterima (untuk panel debug). */
  readonly chunkCount: number;
}

const EMPTY = () => new Blob([], { type: "video/webm" });

/**
 * Dependensi browser untuk `createVideoRecorder`.
 *
 * `MediaRecorder` bisa menolak `mimeType` yang tidak dikenal — itu ditangani
 * `createVideoRecorder` (hasilnya klip kosong, bukan lemparan), dan itulah
 * kenapa `pickMimeType` memeriksa dukungan lebih dulu.
 */
export function browserRecorderDeps(): RecorderDeps {
  return {
    createRecorder: (stream, options) => new MediaRecorder(stream, options) as unknown as RecorderLike,
  };
}

export function createVideoRecorder(deps: RecorderDeps, options: VideoRecorderOptions): VideoRecorder {
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    });

  const chunks: Blob[] = [];
  let recorder: RecorderLike | null = null;
  let cancelLimit: (() => void) | null = null;
  let settle: ((blob: Blob) => void) | null = null;
  let stopped = false;
  let failed = false;
  let state = "inactive";
  /**
   * Hasil akhir, disimpan supaya `stop()` yang dipanggil lagi (mis. UI
   * menutup panel setelah unggah gagal) mengembalikan rekaman yang sama —
   * bukan `Blob` kosong. `chunks` sudah dikosongkan saat `finish()`.
   */
  let result: Blob | null = null;

  function finish(): void {
    const blob = chunks.length === 0 ? EMPTY() : new Blob(chunks, { type: options.mimeType ?? "video/webm" });
    chunks.length = 0;
    state = "inactive";
    result = blob;
    const resolve = settle;
    settle = null;
    if (resolve !== null) resolve(blob);
  }

  function teardown(): void {
    cancelLimit?.();
    cancelLimit = null;
    if (recorder !== null) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
    }
  }

  return {
    start() {
      if (recorder !== null || stopped) return;

      const recorderOptions: RecorderOptions = {
        videoBitsPerSecond: options.bitrateBps,
      };
      if (options.mimeType !== null) recorderOptions.mimeType = options.mimeType;
      if (options.audioBitrateBps > 0) recorderOptions.audioBitsPerSecond = options.audioBitrateBps;

      let created: RecorderLike;
      try {
        created = deps.createRecorder(options.stream, recorderOptions);
      } catch {
        // Format ditolak / device hilang. Tidak ada rekaman — tapi juga tidak
        // ada exception yang menjalar ke UI.
        failed = true;
        state = "inactive";
        return;
      }

      recorder = created;
      recorder.ondataavailable = (event) => {
        if (event.data !== undefined && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        failed = true;
        // Jangan tunggu `onstop`: sebagian browser tidak memanggilnya setelah
        // error. Selesaikan sekarang dengan apa yang sudah ada.
        teardown();
        finish();
      };
      recorder.onstop = () => {
        teardown();
        finish();
      };

      try {
        if (options.timesliceMs !== undefined && options.timesliceMs > 0) {
          recorder.start(options.timesliceMs);
        } else {
          recorder.start();
        }
        state = "recording";
      } catch {
        failed = true;
        teardown();
        finish();
        return;
      }

      const limit = options.maxDurationMs ?? 0;
      if (limit > 0) {
        cancelLimit = schedule(() => {
          void this.stop();
        }, limit);
      }
    },

    async stop(): Promise<Blob> {
      stopped = true;

      // Sudah selesai sebelumnya: kembalikan rekaman yang sama, bukan kosong.
      if (result !== null) return result;

      if (recorder === null || settle !== null) {
        // Belum pernah mulai, atau `stop()` sedang berjalan: kalau ada yang
        // menunggu, cukup kembalikan apa yang sudah terkumpul.
        if (settle !== null) {
          return new Promise<Blob>((resolve) => {
            const previous = settle;
            settle = (blob) => {
              previous?.(blob);
              resolve(blob);
            };
          });
        }
        teardown();
        return chunks.length === 0 ? EMPTY() : new Blob(chunks, { type: options.mimeType ?? "video/webm" });
      }

      const pending = new Promise<Blob>((resolve) => {
        settle = resolve;
      });

      if (state === "recording") {
        try {
          recorder.stop();
        } catch {
          failed = true;
          teardown();
          finish();
        }
      } else {
        // Sudah tidak merekam (mis. `onerror` baru saja jalan).
        teardown();
        finish();
      }

      const blob = await pending;
      // Kalau gagal tanpa satu byte pun, jangan pura-pura ada hasil.
      return failed && blob.size === 0 ? EMPTY() : blob;
    },

    get recording(): boolean {
      return state === "recording";
    },

    get chunkCount(): number {
      return chunks.length;
    },
  };
}
