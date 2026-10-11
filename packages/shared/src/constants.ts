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
