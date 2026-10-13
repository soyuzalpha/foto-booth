/**
 * Kekuatan blur latar — murni.
 *
 * Blur diukur dalam **piksel**, bukan persen, karena efek visualnya bergantung
 * pada ukuran gambar: radius 8 px terlihat sangat kabur di foto 640 px, tapi
 * hampir tidak terasa di foto 4000 px. Karena itu radius dihitung dari lebar
 * gambar, bukan dari slider saja — supaya slider yang sama memberi kesan yang
 * sama di resolusi apa pun.
 */

import { clamp01 } from "./util.ts";

/** Radius maksimum relatif terhadap lebar gambar (8% lebar). */
export const MAX_BLUR_FRACTION = 0.08;

/**
 * Radius blur dalam piksel untuk `strength` (0..100) pada gambar selebar
 * `width`. Selalu bilangan bulat ≥ 1 kalau blur diminta, karena radius 0 =
 * tidak ada blur sama sekali (dan itu menipu operator).
 */
export function blurRadiusPx(strength: number, width: number): number {
  const s = clamp01(strength / 100);
  if (s === 0 || width <= 0) return 0;

  const max = width * MAX_BLUR_FRACTION;
  return Math.max(1, Math.round(max * s));
}
