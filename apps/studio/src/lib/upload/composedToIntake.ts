/**
 * Jembatan dari hasil capture ke jalur simpan (arsip lokal + antrian upload).
 *
 * Capture menghasilkan `Frame[]` (punya `blob`), sedangkan jalur simpan
 * mengharapkan `IntakePhoto`. Pemisahan ini disengaja: `Frame` adalah bahasa
 * mesin capture (source, strategy, shotIndex), `IntakePhoto` bahasa
 * penyimpanan (nama berkas, tipe konten, thumbnail). Menerjemahkan di sini
 * berarti keduanya bisa berubah tanpa saling menyeret.
 *
 * Thumbnail dibuat lewat `makeThumb` yang bisa disuntik. Di browser, pembuatnya
 * memakai `<canvas>`; di tes, tidak ada canvas — dan itu tidak masalah, karena
 * kegagalan thumbnail **tidak boleh** menggagalkan foto besar. `null` selalu
 * jawaban yang sah.
 */

import type { Frame } from "../transports/types.ts";
import type { IntakePhoto } from "./photoIntake.ts";

/** Tipe konten yang dipakai untuk JPEG — satu-satunya format yang kita simpan. */
export const CAPTURE_CONTENT_TYPE = "image/jpeg" as const;

/**
 * Nama berkas foto.
 *
 * Polanya `urut` yang di-`padStart` supaya berkas terurut benar di file manager
 * (`10.jpg` harus datang setelah `9.jpg`, bukan setelah `1.jpg`).
 */
export function captureFilename(shotIndex: number, extension = "jpg"): string {
  return `${String(shotIndex + 1).padStart(2, "0")}.${extension}`;
}

export interface ToIntakeOptions {
  /** Sumber thumbnail. `null` = tidak ada thumbnail; itu bukan kegagalan. */
  makeThumb?: (blob: Blob) => Promise<Blob | null>;
}

/**
 * Ubah frame hasil capture menjadi foto siap-simpan.
 *
 * Urut berdasarkan `shotIndex`, bukan urutan array: `frames()` dijamin urut,
 * tapi jembatan ini tidak boleh bergantung pada jaminan itu — kalau urutannya
 * bergeser, tamu akan melihat halaman galeri dengan urutan tertukar.
 */
export async function framesToIntake(
  frames: readonly Frame[],
  options: ToIntakeOptions = {},
): Promise<IntakePhoto[]> {
  const ordered = [...frames].sort((a, b) => a.shotIndex - b.shotIndex);

  const photos: IntakePhoto[] = [];
  for (const frame of ordered) {
    let thumb: Blob | null = null;
    if (options.makeThumb !== undefined) {
      // Thumbnail best-effort: pembuatnya boleh melempar (canvas tidak ada,
      // gambar rusak), dan foto besarnya tetap harus ikut.
      try {
        thumb = await options.makeThumb(frame.blob);
      } catch {
        thumb = null;
      }
    }

    photos.push({
      blob: frame.blob,
      thumb,
      contentType: CAPTURE_CONTENT_TYPE,
      width: frame.width,
      height: frame.height,
      filename: captureFilename(frame.shotIndex),
      index: frame.shotIndex,
    });
  }

  return photos;
}
