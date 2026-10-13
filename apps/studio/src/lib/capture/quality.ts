/**
 * Preset kualitas foto — murni.
 *
 * Satu tombol mengatur dua hal sekaligus: **lebar maksimum** (supaya kiosk
 * tidak menghabiskan kuota & waktu upload untuk foto 50 MP) dan **kualitas
 * JPEG**. Dipisah dari UI supaya "apa arti hemat/standar/maks" ada di satu
 * tempat dan bisa diuji, bukan tersebar di beberapa slider.
 */

import type { QualityPresetId } from "../filters/types.ts";

export interface QualityPreset {
  id: QualityPresetId;
  label: string;
  /** Lebar maksimum hasil; `0` = ikut resolusi asli (tanpa diperkecil). */
  maxWidth: number;
  /** Kualitas JPEG, 0..1. */
  jpegQuality: number;
}

export const QUALITY_PRESETS: readonly QualityPreset[] = [
  { id: "hemat", label: "Hemat", maxWidth: 1600, jpegQuality: 0.8 },
  { id: "standar", label: "Standar", maxWidth: 2400, jpegQuality: 0.9 },
  { id: "maks", label: "Maksimal", maxWidth: 0, jpegQuality: 0.95 },
];

const FALLBACK = QUALITY_PRESETS[1] as QualityPreset;

export function qualityPresetById(id: QualityPresetId): QualityPreset {
  return QUALITY_PRESETS.find((preset) => preset.id === id) ?? FALLBACK;
}

export interface FrameSize {
  width: number;
  height: number;
}

/**
 * Ukuran keluaran setelah dibatasi preset. **Tidak pernah memperbesar** —
 * menaikkan resolusi foto yang sudah kecil hanya menambah berat berkas tanpa
 * menambah detail.
 */
export function fitToQualityPreset(width: number, height: number, preset: QualityPreset): FrameSize {
  if (preset.maxWidth <= 0 || width <= preset.maxWidth || width <= 0) {
    return { width, height };
  }
  const factor = preset.maxWidth / width;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}
