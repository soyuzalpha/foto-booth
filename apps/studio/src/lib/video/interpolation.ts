/**
 * Interpolasi antar-frame — kontrak + perencanaan, murni.
 *
 * Slow-mo memperbanyak frame; frame tambahan itu harus **dibuat**. Dua cara:
 *
 *   1. **RIFE** (model ONNX, `/models/*`) — menyintesis frame baru yang tajam.
 *      Berat: butuh `onnxruntime-web` + model ratusan MB, sama seperti GFPGAN
 *      di Fase 6. Kalau modelnya belum ada, kita tidak boleh mati.
 *   2. **Pencampuran** dua frame tetangga — murah, selalu ada, hasilnya agak
 *      kabur di bagian bergerak. Ini **fallback**, bukan tujuan.
 *
 * Berkas ini hanya mendefinisikan kontraknya dan menghitung frame mana yang
 * perlu disintesis. Pikselnya disentuh adapter di `rife.ts`.
 */

import type { RetimedStep } from "./slowMotion.ts";

/** Satu frame yang harus disintesis dari dua frame sumber. */
export interface SyntheticFrame {
  /** Posisi di timeline keluaran. */
  outputIndex: number;
  fromIndex: number;
  toIndex: number;
  /** 0..1 — bobot ke arah `toIndex`. */
  mix: number;
}

/**
 * Satu frame sumber yang siap dipakai (sudah punya piksel).
 *
 * `image` sengaja `unknown` di lapisan murni: di browser isinya `ImageBitmap`
 * atau kanvas, di tes cukup objek apa saja. Adapter yang tahu tipe sebenarnya.
 */
export interface SourceFrame {
  index: number;
  image: unknown;
  width: number;
  height: number;
}

/**
 * Penyedia interpolasi. Implementasi RIFE dan implementasi pencampuran
 * memenuhi kontrak yang sama, jadi pemanggil tidak perlu tahu mana yang aktif.
 */
export interface FrameInterpolator {
  readonly kind: "rife" | "blend";
  /** Apakah siap dipakai (model termuat). `false` → pemanggil pakai fallback. */
  ready(): boolean;
  /**
   * Sintesis satu frame antara `a` dan `b` dengan bobot `mix` (0..1).
   * `null` = gagal; pemanggil memakai `a` apa adanya.
   */
  interpolate(a: SourceFrame, b: SourceFrame, mix: number): Promise<unknown | null>;
}

/** Pilih langkah yang benar-benar butuh sintesis (bukan frame asli). */
export function syntheticFrames(steps: readonly RetimedStep[]): SyntheticFrame[] {
  const out: SyntheticFrame[] = [];
  for (const step of steps) {
    if (step.mix > 0) {
      out.push({
        outputIndex: step.outputIndex,
        fromIndex: step.fromIndex,
        toIndex: step.toIndex,
        mix: step.mix,
      });
    }
  }
  return out;
}

/**
 * Bobot pencampuran yang dipakai fallback.
 *
 * Sama dengan `mix` — sengaja tidak diberi kurva tambahan, supaya hasil RIFE
 * dan hasil fallback berada di timeline yang sama dan bisa dibandingkan.
 */
export function blendWeight(mix: number): number {
  if (!Number.isFinite(mix)) return 0;
  return Math.min(1, Math.max(0, mix));
}

/**
 * Jalankan interpolasi untuk semua frame sintetis.
 *
 * `provider` boleh `null` atau belum siap — dalam hal itu frame yang gagal
 * dikembalikan sebagai `null` di slotnya, dan pemanggil memakai frame `from`
 * apa adanya. **Kegagalan interpolasi tidak boleh membatalkan video**; video
 * yang sedikit patah jauh lebih baik daripada tidak ada video.
 */
export async function interpolateFrames(
  provider: FrameInterpolator | null,
  frames: readonly SourceFrame[],
  steps: readonly RetimedStep[],
): Promise<(unknown | null)[]> {
  const byIndex = new Map<number, SourceFrame>();
  for (const frame of frames) byIndex.set(frame.index, frame);

  const results: (unknown | null)[] = [];
  const jobs = syntheticFrames(steps);

  for (const job of jobs) {
    const a = byIndex.get(job.fromIndex);
    const b = byIndex.get(job.toIndex);
    if (a === undefined || b === undefined) {
      results.push(null);
      continue;
    }
    if (provider === null || !provider.ready()) {
      results.push(null);
      continue;
    }
    try {
      results.push(await provider.interpolate(a, b, blendWeight(job.mix)));
    } catch {
      results.push(null);
    }
  }

  return results;
}
