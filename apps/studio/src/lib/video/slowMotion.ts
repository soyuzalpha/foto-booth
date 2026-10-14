/**
 * Perhitungan perlambatan (slow-mo) — murni.
 *
 * Perlambatan **bukan** "putar video pelan-pelan": berkasnya sama, pemutarnya
 * yang mengubah kecepatan. Yang kita hasilkan adalah berkas **baru** dengan
 * durasi lebih panjang, karena hasilnya dikirim ke tamu sebagai berkas biasa
 * (dan sebagian pemutar ponsel mengabaikan metadata kecepatan).
 *
 * Jadi timeline keluaran dihitung ulang:
 *
 *   · outputDuration = sourceDuration / factor
 *   · outputFrameCount = sourceFrameCount / factor
 *   · frame keluaran ke-`k` diambil dari posisi sumber `k * factor`
 *
 * Kalau `k * factor` bukan bilangan bulat, frame keluaran itu **tidak punya
 * pasangan asli** dan harus disintesis — itulah yang dilakukan interpolasi
 * (RIFE) atau, kalau modelnya tidak ada, pencampuran dua frame tetangga
 * (`blendFallback` di `rife.ts`). Fungsi di berkas ini hanya menghitung
 * *apa yang perlu disintesis*; ia tidak menyentuh piksel.
 */

import type { SlowMoFactor } from "./types.ts";

/** Kecepatan pemutaran untuk faktor tertentu. `0,5` → diputar separuh kecepatan. */
export function playbackRateFor(factor: SlowMoFactor): number {
  return factor >= 1 ? 1 : factor;
}

/** Durasi keluaran setelah diperlambat, detik. */
export function outputDurationSec(sourceDurationSec: number, factor: SlowMoFactor): number {
  const safe = Math.max(0, sourceDurationSec);
  return factor >= 1 ? safe : safe / factor;
}

/** Jumlah frame keluaran setelah diperlambat. */
export function outputFrameCount(sourceFrameCount: number, factor: SlowMoFactor): number {
  const safe = Math.max(0, Math.round(sourceFrameCount));
  if (factor >= 1) return safe;
  return Math.round(safe / factor);
}

/**
 * Satu langkah timeline keluaran.
 *
 * `mix = 0` → pakai frame `fromIndex` apa adanya (tidak perlu interpolasi).
 * `mix > 0` → campur `fromIndex` dan `toIndex` dengan bobot `mix` (0..1).
 */
export interface RetimedStep {
  outputIndex: number;
  fromIndex: number;
  toIndex: number;
  mix: number;
  /** Waktu keluaran langkah ini, detik. */
  atSec: number;
}

/**
 * Timeline keluaran penuh.
 *
 * Frame terakhir sumber dipakai sebagai batas: kalau `k * factor` melewatinya,
 * `toIndex` dijepit ke frame terakhir (tidak ada frame "setelah akhir").
 */
export function retimeTimeline(
  sourceFrameCount: number,
  factor: SlowMoFactor,
  outputFps: number,
): RetimedStep[] {
  const count = Math.max(0, Math.round(sourceFrameCount));
  if (count === 0) return [];

  const last = count - 1;
  const steps = outputFrameCount(count, factor);
  const fps = outputFps > 0 ? outputFps : 30;
  const out: RetimedStep[] = [];

  for (let k = 0; k < steps; k += 1) {
    const position = factor >= 1 ? k : k * factor;
    const fromIndex = Math.min(Math.floor(position), last);
    const toIndex = Math.min(fromIndex + 1, last);
    // `from === to` berarti tidak ada frame "berikutnya" (akhir berkas, atau
    // sumber satu frame): frame keluaran ini cuma menahan frame yang sama, jadi
    // tidak ada yang perlu disintesis. Tanpa penjagaan ini, tiap frame terakhir
    // memicu satu interpolasi sia-sia.
    const mix = toIndex === fromIndex ? 0 : Math.min(1, Math.max(0, position - fromIndex));
    out.push({
      outputIndex: k,
      fromIndex,
      toIndex,
      mix,
      atSec: k / fps,
    });
  }

  return out;
}

/** Berapa frame keluaran yang perlu disintesis (tidak punya pasangan asli). */
export function syntheticFrameCount(steps: readonly RetimedStep[]): number {
  let n = 0;
  for (const step of steps) if (step.mix > 0) n += 1;
  return n;
}

/**
 * Apakah perlambatan ini butuh interpolasi supaya tidak patah-patah.
 *
 * Faktor `1` jelas tidak. Untuk faktor lain, kalau `1/factor` bilangan bulat
 * (mis. 0,5 → 2), tiap frame keluaran jatuh tepat di antara dua frame sumber,
 * jadi selalu butuh interpolasi. Kalau tidak bulat (0,25 → 4; tetap bulat,
 * tapi 0,5 dengan fps ganjil bisa tidak) hasilnya tetap dihitung dari timeline.
 */
export function needsInterpolation(steps: readonly RetimedStep[]): boolean {
  return syntheticFrameCount(steps) > 0;
}
