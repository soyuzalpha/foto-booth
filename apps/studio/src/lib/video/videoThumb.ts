/**
 * Thumbnail untuk klip video.
 *
 * `makeThumb` (foto) tidak bisa dipakai di sini: `createImageBitmap` menolak
 * `Blob` video — yang bisa dibaca cuma gambar. Jadi jalur videonya lain: taruh
 * blob di `<video>`, cari satu waktu, gambar elemen itu ke kanvas.
 *
 * Dua keputusan yang membuat hasilnya tidak hitam:
 *
 *   · **Jangan ambil frame ke-0.** Sebagian kamera & encoder menulis frame
 *     pembuka yang gelap (eksposur belum turun, atau keyframe kosong). Karena
 *     itu waktu cari dihitung dari durasi, bukan `0`.
 *   · **Kegagalan = `null`, bukan lempar.** Video tanpa thumbnail tetap harus
 *     terkirim; halaman galeri sudah punya fallback `<video>` tanpa poster.
 *
 * Sama seperti `makeThumb`: modul ini **selalu boleh gagal**.
 */

/** Sisi panjang maksimum thumbnail video — sama dengan thumbnail foto. */
export const VIDEO_THUMB_MAX_EDGE = 512;

export const VIDEO_THUMB_CONTENT_TYPE = "image/jpeg" as const;
export const VIDEO_THUMB_QUALITY = 0.8;

/**
 * Waktu yang dicari untuk mengambil frame thumbnail, detik.
 *
 * `min(1, durasi × 0,1)`: klip 15 detik → 1 detik (lewat frame pembuka), klip
 * 2 detik → 0,2 detik (masih di dalam berkas). Durasi yang tidak diketahui
 * (`NaN`/`0`) jatuh ke `0` — video yang belum selesai menulis metadata tetap
 * dicoba, dan kalau gagal hasilnya `null`.
 */
export function thumbSeekTime(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.min(1, durationSec * 0.1);
}

/** Hitung ukuran thumbnail video, sisi panjang dibatasi `maxEdge`. */
export function videoThumbSize(
  width: number,
  height: number,
  maxEdge: number = VIDEO_THUMB_MAX_EDGE,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Elemen video minimal yang dipakai — dibuat sendiri supaya bisa dipalsukan. */
export interface ThumbVideoElement {
  src: string;
  muted: boolean;
  preload: string;
  currentTime: number;
  readonly duration: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  /** Siap dipakai? `>= 1` sama dengan `HAVE_METADATA`. */
  readonly readyState: number;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
  load(): void;
  remove(): void;
}

/** Kanvas minimal yang dipakai. */
export interface ThumbCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): {
    drawImage(image: unknown, x: number, y: number, w: number, h: number): void;
  } | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

export interface VideoThumbDeps {
  createVideo(): ThumbVideoElement;
  createCanvas(width: number, height: number): ThumbCanvas;
  /** URL objek untuk blob; dipasangkan `revoke`. */
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** Batas tunggu satu tahap, milidetik. Disuntik supaya tes bebas timer nyata. */
  timeoutMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Tunggu satu event, dengan batas waktu; `false` = lewat batas. */
function waitForEvent(
  target: ThumbVideoElement,
  type: string,
  schedule: (fn: () => void, ms: number) => () => void,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onEvent = (): void => done(true);
    const cancel = schedule(() => done(false), timeoutMs);

    function done(ok: boolean): void {
      if (settled) return;
      settled = true;
      cancel();
      target.removeEventListener(type, onEvent);
      resolve(ok);
    }

    target.addEventListener(type, onEvent, { once: true });
  });
}

/**
 * Buat thumbnail JPEG dari sebuah klip.
 *
 * Mengembalikan `null` kalau lingkungan tidak mendukung, metadata tidak pernah
 * siap, atau kanvas menolak menggambar. **Tidak pernah melempar.**
 */
export async function makeVideoThumb(
  blob: Blob,
  deps: VideoThumbDeps,
  maxEdge: number = VIDEO_THUMB_MAX_EDGE,
): Promise<Blob | null> {
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    });
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let video: ThumbVideoElement | null = null;
  let url: string | null = null;

  try {
    video = deps.createVideo();
    url = deps.createObjectURL(blob);
    video.src = url;
    // `muted` bukan kosmetik: sebagian browser menolak memuat/men-decode video
    // yang tidak di-mute kalau tidak ada interaksi user.
    video.muted = true;
    video.preload = "metadata";

    if (video.readyState < 1) {
      const meta = waitForEvent(video, "loadedmetadata", schedule, timeoutMs);
      video.load();
      if (!(await meta)) return null;
    }

    const size = videoThumbSize(video.videoWidth, video.videoHeight, maxEdge);
    if (size.width === 0 || size.height === 0) return null;

    // Lewati frame pembuka: cari ke titik yang dihitung dari durasi.
    //
    // Pendengar `seeked` dipasang **sebelum** `currentTime` diubah. Kalau
    // dibalik, seek yang selesai sangat cepat (berkas kecil, sudah di cache)
    // bisa memicu event sebelum pendengarnya ada — lalu kita menunggu batas
    // waktu penuh untuk sesuatu yang sudah terjadi.
    const seeked = waitForEvent(video, "seeked", schedule, timeoutMs);
    video.currentTime = thumbSeekTime(video.duration);
    // `seeked` tidak selalu datang kalau waktunya sudah sama dengan posisi kini
    // (klip yang sangat pendek, atau durasi tak diketahui → cari ke 0). Karena
    // itu penantiannya dibatasi waktu, bukan digantung.
    await seeked;

    const canvas = deps.createCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(video, 0, 0, size.width, size.height);

    return await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((result) => resolve(result), VIDEO_THUMB_CONTENT_TYPE, VIDEO_THUMB_QUALITY);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  } finally {
    try {
      video?.remove();
    } catch {
      // Elemen sudah lepas — tidak ada yang perlu dibereskan.
    }
    if (url !== null) deps.revokeObjectURL(url);
  }
}

/** Dependensi browser sungguhan untuk `makeVideoThumb`. */
export function browserVideoThumbDeps(): VideoThumbDeps {
  return {
    createVideo: () => {
      const element = document.createElement("video");
      element.setAttribute("playsinline", "");
      return element as unknown as ThumbVideoElement;
    },
    createCanvas: (width, height) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas as unknown as ThumbCanvas;
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
}
