/**
 * Preset latar & warna kunci — murni.
 *
 * Warna latar yang sering dipakai studio dikumpulkan di sini supaya operator
 * memilih satu klik, bukan memutar color picker tiap sesi. Preset-nya data
 * biasa, jadi bisa ditambah tanpa menyentuh logika pipeline.
 */

import { clamp255 } from "./util.ts";
import { CHROMA_BLUE, CHROMA_GREEN, type Rgb } from "./types.ts";

export interface BackgroundColorPreset {
  id: string;
  label: string;
  color: Rgb;
}

export const BACKGROUND_COLORS: readonly BackgroundColorPreset[] = [
  { id: "putih", label: "Putih", color: { r: 255, g: 255, b: 255 } },
  { id: "hitam", label: "Hitam", color: { r: 0, g: 0, b: 0 } },
  { id: "biru", label: "Biru", color: { r: 30, g: 90, b: 200 } },
  { id: "merah", label: "Merah", color: { r: 190, g: 40, b: 50 } },
  { id: "hijau", label: "Hijau", color: { r: 40, g: 160, b: 90 } },
  { id: "krem", label: "Krem", color: { r: 245, g: 236, b: 214 } },
];

export interface ChromaPreset {
  id: string;
  label: string;
  color: Rgb;
}

export const CHROMA_PRESETS: readonly ChromaPreset[] = [
  { id: "green", label: "Hijau (green screen)", color: { ...CHROMA_GREEN } },
  { id: "blue", label: "Biru (blue screen)", color: { ...CHROMA_BLUE } },
];

/** Warna RGB → string CSS, dengan clamping supaya tidak pernah keluar rentang. */
export function rgbToCss({ r, g, b }: Rgb): string {
  return `rgb(${clamp255(r)}, ${clamp255(g)}, ${clamp255(b)})`;
}
