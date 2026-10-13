/**
 * Pembuat thumbnail di browser.
 *
 * Thumbnail dipakai halaman galeri supaya tamu tidak mengunduh foto 8 MB hanya
 * untuk melihat 20 kotak kecil. Sisi panjang dibatasi 512 px — cukup tajam di
 * retina, cukup kecil untuk dikirim puluhan sekaligus.
 *
 * Modul ini **selalu boleh gagal.** `createImageBitmap` dan `<canvas>` tidak
 * ada di semua lingkungan (jsdom di tes, browser tua, mode hemat memori), dan
 * kegagalannya tidak berarti apa-apa bagi foto aslinya. Karena itu fungsinya
 * mengembalikan `null`, bukan melempar.
 */

/** Sisi panjang maksimum thumbnail. */
export const THUMB_MAX_EDGE = 512;

export const THUMB_CONTENT_TYPE = "image/jpeg" as const;
export const THUMB_QUALITY = 0.8;

/** Hitung ukuran thumbnail dengan sisi panjang dibatasi `maxEdge`. */
export function thumbSize(
  width: number,
  height: number,
  maxEdge: number = THUMB_MAX_EDGE,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Perkecil `blob` jadi JPEG kecil. `null` kalau lingkungan tidak mendukung
 * atau gambar tidak bisa dibaca.
 */
export async function makeThumb(
  blob: Blob,
  maxEdge: number = THUMB_MAX_EDGE,
): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    const size = thumbSize(bitmap.width, bitmap.height, maxEdge);
    if (size.width === 0 || size.height === 0) return null;

    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;

    const context = canvas.getContext("2d");
    if (context === null) return null;

    context.drawImage(bitmap, 0, 0, size.width, size.height);

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), THUMB_CONTENT_TYPE, THUMB_QUALITY);
    });
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
