/**
 * Brightness / contrast / saturation — murni.
 *
 * Dua wajah dari perhitungan yang sama:
 *
 *   · `adjustmentsToCssFilter()` menghasilkan string untuk `ctx.filter` /
 *     properti `filter:` CSS. Ini jalur cepat di browser (dikerjakan GPU) dan
 *     yang dipakai adapter DOM.
 *   · `applyAdjustmentsToPixel()` mengerjakan matematika yang sama per piksel,
 *     supaya "janji"-nya bisa diuji di Node tanpa canvas — sekaligus fallback
 *     kalau `ctx.filter` tidak didukung.
 *
 * Urutan operasi sengaja mengikuti urutan fungsi di string CSS
 * (`brightness` → `contrast` → `saturate`), karena CSS menerapkannya
 * kiri-ke-kanan. Kalau urutannya beda, hasil di canvas dan hasil tes akan
 * berbeda dan tidak ada yang tahu mana yang benar.
 */

import { clamp255, round3 } from "./util.ts";
import type { Adjustments } from "./types.ts";

/** Batasi slider ke rentangnya; nilai aneh (NaN, di luar rentang) jadi 0. */
export function clampAdjustment(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < -100) return -100;
  if (value > 100) return 100;
  return value;
}

export function isNeutralAdjustments(a: Adjustments): boolean {
  return a.brightness === 0 && a.contrast === 0 && a.saturation === 0;
}

/** Faktor pengali: -100 → 0, 0 → 1, +100 → 2. */
function factor(value: number): number {
  return 1 + clampAdjustment(value) / 100;
}

/** String untuk `ctx.filter`; `"none"` kalau netral (tanpa kerja sama sekali). */
export function adjustmentsToCssFilter(a: Adjustments): string {
  if (isNeutralAdjustments(a)) return "none";

  const parts: string[] = [];
  if (a.brightness !== 0) parts.push(`brightness(${round3(factor(a.brightness))})`);
  if (a.contrast !== 0) parts.push(`contrast(${round3(factor(a.contrast))})`);
  if (a.saturation !== 0) parts.push(`saturate(${round3(factor(a.saturation))})`);

  return parts.join(" ");
}

export interface RgbPixel {
  r: number;
  g: number;
  b: number;
}

/** Bobot luma standar (Rec. 709) — sama dengan yang dipakai `saturate()` CSS. */
const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

/** Titik tengah kontras — kontras CSS memutar nilai di sekitar abu-abu ini. */
const MID = 128;

/**
 * Terapkan ketiga penyesuaian ke satu piksel (0..255). Hasil di-clamp 0..255.
 * Urutan: brightness → contrast (di sekitar 128) → saturation (di sekitar luma).
 */
export function applyAdjustmentsToPixel(px: RgbPixel, a: Adjustments): RgbPixel {
  const fb = factor(a.brightness);
  const fc = factor(a.contrast);
  const fs = factor(a.saturation);

  let r = px.r * fb;
  let g = px.g * fb;
  let b = px.b * fb;

  r = (r - MID) * fc + MID;
  g = (g - MID) * fc + MID;
  b = (b - MID) * fc + MID;

  const luma = LUMA.r * r + LUMA.g * g + LUMA.b * b;
  r = luma + (r - luma) * fs;
  g = luma + (g - luma) * fs;
  b = luma + (b - luma) * fs;

  return { r: clamp255(r), g: clamp255(g), b: clamp255(b) };
}

/**
 * Terapkan penyesuaian ke seluruh buffer RGBA — jalur fallback untuk browser
 * yang `ctx.filter`-nya tidak jalan (Safari lama). Hasilnya harus sama dengan
 * `adjustmentsToCssFilter`, karena keduanya menggambarkan janji yang sama;
 * kalau berbeda, satu browser akan menampilkan foto yang lain.
 *
 * Alpha tidak disentuh: penyesuaian warna tidak mengubah mana yang tembus.
 */
export function applyAdjustmentsToImageData(data: Uint8ClampedArray, a: Adjustments): void {
  if (isNeutralAdjustments(a)) return;

  for (let i = 0; i < data.length; i += 4) {
    const out = applyAdjustmentsToPixel(
      { r: data[i] ?? 0, g: data[i + 1] ?? 0, b: data[i + 2] ?? 0 },
      a,
    );
    data[i] = out.r;
    data[i + 1] = out.g;
    data[i + 2] = out.b;
  }
}
