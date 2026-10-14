/**
 * Bantu gambar untuk AI (Fase 8) — murni, tanpa DOM.
 *
 * Semua yang di sini bisa diuji di Node: yang menentukan apakah sebuah gambar
 * boleh dikirim, dan bagaimana bentuk data-URL yang sah. Yang **tidak** ada di
 * sini adalah menggambar ke kanvas — itu urusan adapter DOM, karena satu-satunya
 * cara menguji kanvas adalah dengan kanvas.
 *
 * Bentuk yang dipilih: **base64 polos** di body permintaan, bukan data-URL.
 * Alasannya ada di `ai.ts` (satu bentuk sah untuk satu hal), dan di sini
 * konsekuensinya: awalan `data:` **dibuang** sebelum dikirim, lalu dipasang
 * kembali saat hasilnya dipakai sebagai `src`.
 */

import {
  AI_IMAGE_MIME_TYPES,
  AI_MAX_INPUT_BYTES,
  base64Bytes,
  isAiImageMime,
  type AiImageMimeType,
} from "@foto-booth/shared";

export interface DecodedImage {
  mimeType: AiImageMimeType;
  /** Base64 tanpa awalan data-URL. */
  base64: string;
  /** Ukuran biner perkiraan dari panjang base64. */
  bytes: number;
}

/**
 * Baca data-URL menjadi bagian-bagiannya.
 *
 * `null` kalau bukan gambar yang didukung, base64-nya kosong, atau ukurannya
 * melewati batas. Sengaja **tidak** mendekode base64: ukuran dihitung dari
 * panjangnya, jadi gambar 40 MB tidak pernah dialokasikan hanya untuk ditolak.
 */
export function decodeDataUrl(dataUrl: string): DecodedImage | null {
  const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.*)$/is.exec(dataUrl.trim());
  if (match === null) return null;

  const mime = (match[1] ?? "").toLowerCase();
  if (!isAiImageMime(mime)) return null;

  const base64 = (match[2] ?? "").replace(/\s+/g, "");
  if (base64 === "") return null;

  const bytes = base64Bytes(base64);
  if (bytes > AI_MAX_INPUT_BYTES) return null;

  return { mimeType: mime, base64, bytes };
}

/** Pasang kembali awalan data-URL dari hasil server. */
export function toDataUrl(mimeType: string, base64: string): string {
  const mime = isAiImageMime(mimeType) ? mimeType : "image/png";
  return `data:${mime};base64,${base64}`;
}

/** MIME yang boleh masuk pipeline AI (dipakai UI untuk menyaring pilihan). */
export function aiEligibleMimeTypes(): readonly string[] {
  return AI_IMAGE_MIME_TYPES;
}

/**
 * Nama berkas hasil, memakai ekstensi yang cocok dengan MIME-nya.
 *
 * Dipakai saat operator menyimpan hasil AI ke arsip; ekstensi yang salah bikin
 * berkas tidak bisa dibuka aplikasi lain meski isinya benar.
 */
export function extensionForAiMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}
