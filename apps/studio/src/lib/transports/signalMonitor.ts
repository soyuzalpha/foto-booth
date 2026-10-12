/**
 * Deteksi sinyal hilang.
 *
 * Capture card bisa berhenti mengirim gambar tanpa memberi tahu siapa pun:
 * kabel HDMI dicabut, kamera tidur, baterai habis. `MediaStreamTrack` tetap
 * `live` dan `<video>` tetap "memutar" — cuma gambarnya membeku atau hitam.
 * Tanpa deteksi ini, operator baru sadar setelah tamu selesai pose.
 *
 * Cara kerjanya sengaja sederhana dan murah: sampel frame ke grid kecil,
 * hitung luma rata-rata (deteksi hitam) dan selisih antar sampel (deteksi
 * beku). Dua-duanya fungsi murni, jadi bisa diuji tanpa kamera.
 */

export type SignalState = "unknown" | "ok" | "no-signal";

/** Hasil sampel satu frame. `luma` = grid 0..255, bukan RGBA. */
export interface LumaGrid {
  data: Uint8ClampedArray;
  /** Jumlah sel; dipakai untuk rata-rata. */
  length: number;
}

export interface SignalThresholds {
  /** Di bawah ini dianggap layar hitam (0..255). */
  blackLuma: number;
  /** Selisih rata-rata di bawah ini dianggap gambar beku (0..255). */
  frozenDelta: number;
  /** Berapa sampel beku berturut-turut sebelum dinyatakan hilang. */
  frozenStreak: number;
}

export const DEFAULT_THRESHOLDS: SignalThresholds = {
  blackLuma: 8,
  frozenDelta: 1.2,
  frozenStreak: 4,
};

/**
 * Konversi RGBA (hasil `getImageData`) ke grid luma.
 * Memakai koefisien Rec. 601 — cukup akurat untuk mendeteksi hitam/beku.
 */
export function rgbaToLuma(rgba: Uint8ClampedArray): LumaGrid {
  const cells = rgba.length / 4;
  const data = new Uint8ClampedArray(cells);

  for (let i = 0; i < cells; i += 1) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    data[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  return { data, length: cells };
}

export function meanLuma(grid: LumaGrid): number {
  if (grid.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < grid.length; i += 1) sum += grid.data[i] ?? 0;

  return sum / grid.length;
}

/** Rata-rata selisih absolut antar dua grid. Ukuran "gambar ini berubah atau tidak". */
export function meanDelta(a: LumaGrid, b: LumaGrid): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;

  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));

  return sum / n;
}

/** Klasifikasi satu sampel, tanpa state. */
export function classifySample(
  current: LumaGrid,
  previous: LumaGrid | null,
  thresholds: SignalThresholds = DEFAULT_THRESHOLDS,
): { verdict: "ok" | "frozen" | "black"; luma: number; delta: number } {
  const luma = meanLuma(current);
  const delta = previous === null ? Number.POSITIVE_INFINITY : meanDelta(previous, current);

  // Hitam pekat = tidak ada sinyal. Dicek dulu karena frame hitam juga "beku"
  // (delta 0), dan "layar hitam" lebih informatif buat operator daripada "beku".
  if (luma <= thresholds.blackLuma) return { verdict: "black", luma, delta };
  if (delta <= thresholds.frozenDelta) return { verdict: "frozen", luma, delta };

  return { verdict: "ok", luma, delta };
}

export interface SignalMonitorOptions {
  /** Ambil sampel frame sekarang, atau `null` kalau video belum siap. */
  sample: () => LumaGrid | null;
  /** Dipanggil hanya saat status berubah — bukan tiap sampel. */
  onChange: (state: SignalState, detail: SignalDetail) => void;
  intervalMs?: number;
  thresholds?: SignalThresholds;
  /** Timer yang bisa disuntik, supaya tes tidak perlu menunggu detik nyata. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface SignalDetail {
  luma: number;
  delta: number;
  frozenStreak: number;
  verdict: "ok" | "frozen" | "black" | "waiting";
}

/**
 * Pemantau sinyal berbasis interval.
 *
 * `onChange` sengaja hanya dipanggil saat status **berubah** supaya React tidak
 * re-render 10× per detik. Detail per sampel tetap dikirim lewat argumen kedua.
 */
export class SignalMonitor {
  private readonly options: SignalMonitorOptions;
  private readonly thresholds: SignalThresholds;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly intervalMs: number;

  private cancel: (() => void) | null = null;
  private previous: LumaGrid | null = null;
  private streak = 0;
  private state: SignalState = "unknown";

  constructor(options: SignalMonitorOptions) {
    this.options = options;
    this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
    this.intervalMs = options.intervalMs ?? 500;
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      });
  }

  get current(): SignalState {
    return this.state;
  }

  start(): void {
    if (this.cancel !== null) return;
    this.tick();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
    this.previous = null;
    this.streak = 0;
  }

  /** Kembalikan ke `unknown` — dipakai saat ganti device atau sambung ulang. */
  reset(): void {
    this.stop();
    this.setState("unknown", { luma: 0, delta: 0, frozenStreak: 0, verdict: "waiting" });
  }

  /** Satu langkah analisis. Publik supaya tes bisa memanggilnya tanpa timer. */
  tick(): void {
    const grid = this.options.sample();

    if (grid === null) {
      this.previous = null;
      this.streak = 0;
      // Video belum siap — jangan langsung bilang hilang, tapi juga jangan
      // bilang ok. `unknown` = belum ada pendapat.
      this.setState("unknown", { luma: 0, delta: 0, frozenStreak: 0, verdict: "waiting" });
    } else {
      const { verdict, luma, delta } = classifySample(grid, this.previous, this.thresholds);

      if (verdict === "ok") {
        this.streak = 0;
        this.setState("ok", { luma, delta, frozenStreak: 0, verdict });
      } else {
        this.streak += 1;
        // Frame hitam langsung hilang (tidak perlu menunggu streak): layar
        // hitam tidak ambigu. Frame beku menunggu beberapa sampel supaya
        // adegan yang memang diam tidak salah tuduh.
        const lost = verdict === "black" || this.streak >= this.thresholds.frozenStreak;
        this.setState(lost ? "no-signal" : this.state, {
          luma,
          delta,
          frozenStreak: this.streak,
          verdict,
        });
      }

      this.previous = grid;
    }

    this.cancel = this.schedule(() => {
      this.cancel = null;
      this.tick();
    }, this.intervalMs);
  }

  private setState(next: SignalState, detail: SignalDetail): void {
    const changed = next !== this.state;
    this.state = next;
    if (changed) this.options.onChange(next, detail);
  }
}
