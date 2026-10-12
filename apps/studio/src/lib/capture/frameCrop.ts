/**
 * Crop `Blob` foto ke rasio tertentu.
 *
 * Dipisah dari `aspectRatio.ts` (yang murni) karena file ini menyentuh DOM:
 * `createImageBitmap` + `<canvas>`. Pemisahan itu membuat matematika crop bisa
 * diuji di Node, sementara jalur gambar nyata hanya berjalan di browser.
 */

import { computeCrop, type AspectRatioId, aspectRatioById } from "./aspectRatio.ts";

export interface CroppedBlob {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Crop blob ke rasio `id`. `original` (atau rasio tak dikenal) mengembalikan
 * blob apa adanya — jangan decode ulang hanya untuk tidak mengubah apa pun.
 */
export async function cropBlobToRatio(
  blob: Blob,
  id: AspectRatioId,
  quality = 0.92,
): Promise<CroppedBlob> {
  const option = aspectRatioById(id);

  if (option === null || option.ratio === null) {
    const size = await blobSize(blob);
    return { blob, width: size.width, height: size.height };
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const crop = computeCrop({ width: bitmap.width, height: bitmap.height }, option.ratio);

    const canvas = document.createElement("canvas");
    canvas.width = crop.sw;
    canvas.height = crop.sh;

    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("canvas 2d context tidak tersedia");

    ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);

    const out = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", quality);
    });

    if (out === null) throw new Error("canvas.toBlob() mengembalikan null");

    return { blob: out, width: crop.sw, height: crop.sh };
  } finally {
    bitmap.close();
  }
}

async function blobSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
