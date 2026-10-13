/**
 * Utilitas kecil bersama untuk modul filter — murni, tanpa DOM.
 *
 * Dikumpulkan di satu tempat supaya clamping tidak ditulis ulang dengan
 * aturan yang sedikit berbeda di tiap modul (itu cara paling gampang bikin
 * bug "kadang-kadang" yang susah dilacak).
 */

/** Batasi ke rentang 0..1. `NaN`/`Infinity` dianggap 0. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Batasi ke rentang 0..255 (kanal warna). */
export function clamp255(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

/** Bulatkan ke 3 desimal — cukup untuk string CSS, menghindari `1.2000000000000002`. */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
