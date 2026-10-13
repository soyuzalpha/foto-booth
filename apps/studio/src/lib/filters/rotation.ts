/**
 * Rotasi 0/90/180/270 — murni.
 *
 * Rotasi 90/270 **menukar** lebar & tinggi. Lupa menukar adalah sumber bug
 * klasik: gambar terpotong atau ada bilah hitam di sisi. Karena itu ukuran
 * keluaran dihitung di sini dan diuji angkanya, bukan diserahkan ke canvas
 * sambil berharap.
 */

import type { RotationDegrees } from "./types.ts";

/** Snap sudut apa pun ke 0/90/180/270 terdekat (mis. 450 → 90, -90 → 270). */
export function normalizeRotation(deg: number): RotationDegrees {
  if (!Number.isFinite(deg)) return 0;
  const snapped = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return snapped as RotationDegrees;
}

export interface FrameSize {
  width: number;
  height: number;
}

/** Ukuran setelah rotasi — 90/270 menukar sisi, 0/180 tidak. */
export function rotatedSize(width: number, height: number, deg: number): FrameSize {
  const r = normalizeRotation(deg);
  if (r === 90 || r === 270) return { width: height, height: width };
  return { width, height };
}

/** Matriks affine 2D (format `setTransform(a,b,c,d,e,f)`). */
export interface CanvasTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/**
 * Matriks transform untuk `ctx.setTransform`, sudah termasuk translasi supaya
 * hasil tidak terpotong: setelah rotasi, kanvas berukuran (w', h') dan titik
 * asal digeser ke sudut yang benar.
 */
export function rotationTransform(deg: number, width: number, height: number): CanvasTransform {
  const r = normalizeRotation(deg);
  const out = rotatedSize(width, height, r);

  switch (r) {
    case 90:
      return { a: 0, b: 1, c: -1, d: 0, e: out.width, f: 0 };
    case 180:
      return { a: -1, b: 0, c: 0, d: -1, e: out.width, f: out.height };
    case 270:
      return { a: 0, b: -1, c: 1, d: 0, e: 0, f: out.height };
    default:
      return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }
}
