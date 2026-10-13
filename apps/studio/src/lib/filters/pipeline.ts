/**
 * Keputusan "apa yang perlu dikerjakan" dari `FilterSettings`.
 *
 * Ini inti Fase 6: satu fungsi murni yang menerjemahkan pengaturan UI menjadi
 * rencana berurutan. Adapter DOM (`applyFilters.ts`) hanya menjalankan rencana
 * ini — ia tidak tahu-menahu soal aturan. Jadi aturan bisa diuji tanpa browser,
 * dan tidak ada dua tempat yang memutuskan urutan tahap.
 *
 * Kalau tidak ada yang perlu dikerjakan (`isIdentity`), adapter **wajib**
 * mengembalikan blob asli tanpa decode/encode ulang — re-encode JPEG selalu
 * menurunkan kualitas, dan itu merugikan kalau filternya netral.
 */

import { isNeutralAdjustments } from "./adjustments.ts";
import type { FilterSettings, QualityPresetId, RotationDegrees } from "./types.ts";

export type FilterStage =
  | "rotation"
  | "chromaKey"
  | "background"
  | "adjustments"
  | "faceEnhance";

export interface FilterPlan {
  /** Urutan tahap yang harus dijalankan; kosong = tidak ada kerja. */
  stages: FilterStage[];
  rotation: RotationDegrees;
  quality: QualityPresetId;
  /** Butuh mask subjek dari segmenter (karena latar diganti tanpa chroma key). */
  needsSegmenter: boolean;
  needsFaceEnhance: boolean;
  needsChromaKey: boolean;
  needsBackground: boolean;
  needsAdjust: boolean;
  /** `true` = tidak ada yang berubah; adapter boleh lewatkan pemrosesan. */
  isIdentity: boolean;
}

/**
 * Susun rencana dari pengaturan. Urutannya punya alasan:
 *
 *  1. `rotation`    — geometri dulu, supaya tahap berikut bekerja di orientasi
 *                     final (segmenter tidak menyukai gambar miring).
 *  2. `chromaKey`   — hasilkan alpha dari latar hijau.
 *  3. `background`  — pakai alpha itu untuk menimpa latar (warna/blur/ai).
 *  4. `adjustments` — warna dikoreksi setelah komposisi, jadi tidak ada warna
 *                     latar palsu yang ikut terkoreksi.
 *  5. `faceEnhance` — terakhir, bekerja pada gambar final yang sudah bersih.
 *
 * Mask latar diambil dari chroma key kalau aktif; kalau tidak, dari segmenter.
 * Itu sebabnya `needsSegmenter` = latar diganti **dan** chroma key mati.
 */
export function resolveFilterPlan(settings: FilterSettings): FilterPlan {
  const needsChromaKey = settings.chromaKey.enabled;
  const needsBackground = settings.background.mode !== "none";
  const needsAdjust = !isNeutralAdjustments(settings.adjustments);
  const needsFaceEnhance = settings.faceEnhance;
  const needsSegmenter = needsBackground && !needsChromaKey;

  const stages: FilterStage[] = [];
  if (settings.rotation !== 0) stages.push("rotation");
  if (needsChromaKey) stages.push("chromaKey");
  if (needsBackground) stages.push("background");
  if (needsAdjust) stages.push("adjustments");
  if (needsFaceEnhance) stages.push("faceEnhance");

  return {
    stages,
    rotation: settings.rotation,
    quality: settings.quality,
    needsSegmenter,
    needsFaceEnhance,
    needsChromaKey,
    needsBackground,
    needsAdjust,
    isIdentity: stages.length === 0,
  };
}

/** Ringkasan satu baris untuk panel debug / log. */
export function describePlan(plan: FilterPlan): string {
  if (plan.isIdentity) return "tanpa filter";
  return plan.stages.join(" → ");
}
