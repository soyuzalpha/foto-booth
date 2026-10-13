/**
 * Gabung mask subjek ke kanal alpha gambar — murni.
 *
 * Mask datang dari segmenter (MediaPipe) dan berbentuk satu byte per piksel:
 * `255` = subjek, `0` = latar. Mask yang lebih kecil dari gambar di-*scale*
 * sendiri, bukan ditarik ulang oleh segmenter — supaya satu mask bisa dipakai
 * untuk gambar apa pun ukurannya.
 *
 * Semua fungsi di sini bekerja pada `Uint8ClampedArray` RGBA, jadi bisa diuji
 * di Node tanpa canvas sama sekali.
 */

/**
 * Kalikan alpha gambar dengan mask. Piksel yang mask-nya 0 jadi tembus;
 * piksel yang mask-nya 255 tidak berubah.
 *
 * **Mask yang salah ukuran tidak menebak**: kalau panjangnya tidak cocok,
 * gambar dibiarkan apa adanya (lebih baik subjek tanpa latar baru daripada
 * subjek terpotong separuh karena mask salah petakan).
 */
export function applyMaskToImageData(data: Uint8ClampedArray, mask: Uint8ClampedArray): boolean {
  const pixels = data.length / 4;
  if (mask.length !== pixels) return false;

  for (let p = 0, i = 0; i < data.length; i += 4, p += 1) {
    const m = mask[p] ?? 0;
    if (m === 255) continue;
    data[i + 3] = Math.round(((data[i + 3] ?? 0) * m) / 255);
  }
  return true;
}

/**
 * Perbesar/perkecil mask ke ukuran baru dengan *nearest neighbor*.
 *
 * Nearest dipilih (bukan bilinear) karena mask itu keputusan biner per piksel:
 * interpolasi akan menciptakan nilai antara yang membuat tepi subjek jadi
 * setengah tembus di tempat yang tidak diminta.
 */
export function resizeMaskNearest(
  mask: Uint8ClampedArray,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Uint8ClampedArray {
  if (srcWidth === dstWidth && srcHeight === dstHeight) return mask;
  if (srcWidth <= 0 || srcHeight <= 0 || dstWidth <= 0 || dstHeight <= 0) {
    return new Uint8ClampedArray(0);
  }

  const out = new Uint8ClampedArray(dstWidth * dstHeight);
  for (let y = 0; y < dstHeight; y += 1) {
    const sy = Math.min(srcHeight - 1, Math.floor((y * srcHeight) / dstHeight));
    for (let x = 0; x < dstWidth; x += 1) {
      const sx = Math.min(srcWidth - 1, Math.floor((x * srcWidth) / dstWidth));
      out[y * dstWidth + x] = mask[sy * srcWidth + sx] ?? 0;
    }
  }
  return out;
}
