/**
 * Tata letak key objek di bucket.
 *
 * Bucket ini milik server sendiri (S3-compatible, lihat `docs/SYSTEM-DESIGN.md`),
 * jadi **kita** yang menentukan namanya — bukan penyedia cloud. Karena itu
 * aturannya ditulis di satu tempat dan dipakai dua sisi:
 *
 *   · API   — waktu menandatangani URL upload & waktu menghapus objek kedaluwarsa.
 *   · Studio — waktu melaporkan metadata setelah upload selesai.
 *
 * Kalau dua sisi menghitung key sendiri-sendiri, foto akan "hilang" tanpa error:
 * upload sukses ke satu key, API mencatat key lain. Jadi jangan duplikat.
 *
 * Bentuk key (semuanya di bawah album, supaya menghapus satu galeri = menghapus
 * satu prefix):
 *
 *   photos/<albumHash>/<photoId>.<ext>   ← berkas asli yang diunduh tamu
 *   thumbs/<albumHash>/<photoId>.<ext>   ← pratinjau di halaman galeri
 *   og/<albumHash>.png                   ← gambar meta OG saat link dibagikan
 */

export const STORAGE_PREFIX = {
  photos: "photos",
  thumbs: "thumbs",
  og: "og",
} as const;

/** Ekstensi kanonik per MIME. MIME tak dikenal → `bin` (tidak pernah ditebak). */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? "bin";
}

export function mimeForExt(ext: string): string {
  const found = Object.entries(EXT_BY_MIME).find(([, value]) => value === ext.toLowerCase());
  return found?.[0] ?? "application/octet-stream";
}

/** Key berkas asli. `photoId` sudah dibuat API, jadi tidak perlu sanitasi. */
export function photoKey(albumHash: string, photoId: string, mime: string): string {
  return `${STORAGE_PREFIX.photos}/${albumHash}/${photoId}.${extForMime(mime)}`;
}

export function thumbKey(albumHash: string, photoId: string, mime: string): string {
  return `${STORAGE_PREFIX.thumbs}/${albumHash}/${photoId}.${extForMime(mime)}`;
}

export function ogKey(albumHash: string): string {
  return `${STORAGE_PREFIX.og}/${albumHash}.png`;
}

/** Prefix album — dipakai untuk menghapus seluruh isi satu galeri sekaligus. */
export function albumPrefixes(albumHash: string): string[] {
  return [
    `${STORAGE_PREFIX.photos}/${albumHash}/`,
    `${STORAGE_PREFIX.thumbs}/${albumHash}/`,
    `${STORAGE_PREFIX.og}/${albumHash}.png`,
  ];
}

/**
 * Cek key benar-benar milik album ini.
 *
 * Dipakai waktu `POST /v1/galleries/:id/photos` — studio melaporkan key yang
 * katanya sudah dia upload. Tanpa cek ini, satu klien bisa mendaftarkan objek
 * milik album orang lain ke galerinya sendiri.
 *
 * `..` dan karakter kontrol ditolak eksplisit: bucket S3 memperlakukan key
 * sebagai string apa adanya, jadi `photos/ab12/../../og/x.png` BUKAN traversal
 * — tapi kalau nanti ada backend berbasis filesystem, key seperti itu berubah
 * jadi tulisan di luar direktori. Lebih murah ditolak di sini.
 */
export function keyBelongsToAlbum(key: string, albumHash: string): boolean {
  // Karakter kontrol (0x00–0x1f) ditolak sengaja: regex-nya memang menyasar
  // rentang itu, jadi aturan lint ini dimatikan khusus di baris ini.
  // eslint-disable-next-line no-control-regex
  if (key.includes("..") || /[\u0000-\u001f]/.test(key)) return false;
  return (
    key.startsWith(`${STORAGE_PREFIX.photos}/${albumHash}/`) ||
    key.startsWith(`${STORAGE_PREFIX.thumbs}/${albumHash}/`)
  );
}
