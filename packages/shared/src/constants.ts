/**
 * Konstanta yang dipakai bersama studio app & API.
 * Satu sumber — jangan duplikat di sisi FE atau BE.
 */

export const APP_NAME = "Foto Booth";
export const APP_VERSION = "0.1.0";

/** Semua route API di-prefix ini. */
export const API_PREFIX = "/v1";

/** Studio app (SPA) di-serve di path ini oleh API. */
export const STUDIO_BASE_PATH = "/studio/";

/** Halaman galeri tamu. */
export const GALLERY_BASE_PATH = "/a/";

/** TTL galeri tamu: foto & objek S3 dihapus otomatis setelah ini. */
export const GALLERY_TTL_DAYS = 30;

/** Batas ukuran satu foto (byte). 25 MB cukup untuk JPEG 6000×4000. */
export const PHOTO_MAX_BYTES = 25 * 1024 * 1024;

/** Umur URL presigned (detik). Cukup lama untuk upload di 4G, pendek untuk aman. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Umur kode OTP (menit). */
export const OTP_TTL_MINUTES = 10;

/** Berapa kali salah kode sebelum OTP dibuang. */
export const OTP_MAX_ATTEMPTS = 5;

/** Umur token sesi (jam). */
export const SESSION_TTL_HOURS = 24 * 7;

/** Batas percobaan upload satu foto sebelum menyerah. */
export const UPLOAD_MAX_ATTEMPTS = 5;

/** Berapa foto diupload paralel. Kiosk sering di jaringan lemah. */
export const UPLOAD_CONCURRENCY = 2;

/** Kategori konten yang bisa diunduh/di-cache studio app. */
export const CONTENT_KINDS = [
  "starters",
  "frames",
  "backgrounds",
  "stickers",
] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

/** Locale yang didukung studio app. Struktur siap ditambah sampai 19 bahasa. */
export const LOCALES = ["id", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "id";

export function isContentKind(value: string): value is ContentKind {
  return (CONTENT_KINDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Booking (Fase 11)
 * ------------------------------------------------------------------ */

/** Halaman form booking publik & halaman status token. */
export const BOOKING_BASE_PATH = "/booking";

/** Halaman status satu booking: `/booking/s/<token>`. */
export const BOOKING_STATUS_PATH = `${BOOKING_BASE_PATH}/s/`;

/**
 * Panjang token status, dalam byte acak (base64url → 22 karakter).
 *
 * 16 byte = 128 bit. Token ini satu-satunya yang melindungi data pemesan, dan
 * URL-nya dikirim lewat WhatsApp — jadi harus tidak bisa ditebak, tapi tetap
 * cukup pendek untuk diketik ulang kalau perlu.
 */
export const BOOKING_TOKEN_BYTES = 16;

/** Bentuk token yang diterima route — menolak apa pun yang bukan base64url. */
export const BOOKING_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Batas permintaan booking dari satu IP. */
export const BOOKING_RATE_LIMIT = 5;

/** Jendela pembatas booking (milidetik) — satu jam. */
export const BOOKING_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Panjang maksimum alasan tolak/batal yang ditampilkan ke tamu. */
export const BOOKING_REASON_MAX = 500;

/* ------------------------------------------------------------------ *
 * Leads & analytics (Fase 9)
 * ------------------------------------------------------------------ */

/** Batas kiriman lead dari satu IP (per jendela di bawah). */
export const LEAD_RATE_LIMIT = 10;

/** Jendela pembatas kiriman lead (milidetik) — satu jam. */
export const LEAD_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Batas jumlah field yang boleh dikonfigurasi operator (global + per event). */
export const LEAD_MAX_FIELDS = 40;

/** Batas baris CSV yang diunduh sekaligus. */
export const LEAD_EXPORT_LIMIT = 5000;
