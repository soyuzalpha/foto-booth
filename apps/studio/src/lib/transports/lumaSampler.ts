/**
 * Sampel luma dari elemen `<video>`.
 *
 * Digambar ke canvas kecil (64×36 = 2.304 piksel) — cukup untuk tahu "gambar
 * berubah atau tidak", dan cukup murah untuk jalan tiap 500 ms tanpa membuat
 * fan menyala. Memakai `willReadFrequently` karena `getImageData` dipanggil
 * berulang; tanpa itu Chrome memindahkan canvas ke GPU dan readback-nya mahal.
 */

import { isVideoReady } from "./stillCapture.ts";
import { rgbaToLuma, type LumaGrid } from "./signalMonitor.ts";

export interface SamplerSize {
  width: number;
  height: number;
}

export const DEFAULT_SAMPLER_SIZE: SamplerSize = { width: 64, height: 36 };

export function createLumaSampler(
  video: HTMLVideoElement,
  size: SamplerSize = DEFAULT_SAMPLER_SIZE,
): () => LumaGrid | null {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  return (): LumaGrid | null => {
    if (ctx === null || !isVideoReady(video)) return null;

    try {
      ctx.drawImage(video, 0, 0, size.width, size.height);
      const image = ctx.getImageData(0, 0, size.width, size.height);
      return rgbaToLuma(image.data);
    } catch {
      // Canvas "ternoda" (mis. stream lintas-origin) atau device hilang di
      // tengah readback. `null` = belum ada pendapat, bukan "sinyal hilang".
      return null;
    }
  };
}
