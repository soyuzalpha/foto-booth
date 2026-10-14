/**
 * Branding / white-label (Fase 9, FEATURE-MATRIX #61).
 *
 * Operator bisa mengganti logo, judul, dan subjudul yang tampil di halaman
 * galeri tamu — supaya klien melihat nama acara/penyewanya, bukan nama
 * aplikasi. Semua aturan (batas panjang, URL yang boleh dipakai) tinggal di
 * sini supaya studio dan API tidak menghitung sendiri: kalau studio mengizinkan
 * 200 karakter dan API memotong di 80, operator melihat judulnya berubah
 * setelah disimpan — kegagalan yang cuma kelihatan di lapangan.
 *
 * Logo disimpan sebagai **URL**, bukan byte yang diunggah: halaman galeri
 * dirender dari server, dan satu URL (CDN/Drive/`data:`) cukup untuk kasus
 * nyata tanpa menambah jalur upload baru yang harus dijaga keamanannya.
 */

import { APP_NAME } from "./constants.ts";

export const BRANDING_HEADING_MAX = 80;
export const BRANDING_SUBHEADING_MAX = 160;
export const BRANDING_FOOTER_MAX = 200;
export const BRANDING_LOGO_URL_MAX = 2000;

export interface Branding {
  /** URL logo, atau `null` kalau operator belum memasangnya. */
  logoUrl: string | null;
  /** Judul besar di halaman tamu. Kosong = pakai nama acara. */
  heading: string;
  /** Kalimat di bawah judul. Kosong = tidak ditampilkan. */
  subheading: string;
  /** Catatan kecil di bawah galeri (mis. ucapan terima kasih). */
  footer: string;
}

export const DEFAULT_BRANDING: Branding = {
  logoUrl: null,
  heading: "",
  subheading: "",
  footer: "",
};

/**
 * URL logo yang boleh dipakai.
 *
 * Hanya `https:` (dan `http:` untuk pengembangan lokal) serta `data:image/`
 * yang diterima. `javascript:` dan `data:text/html` **ditolak**: nilainya
 * dirender ke HTML halaman tamu, dan satu URL jahat yang lolos berarti skrip
 * jalan di browser semua tamu.
 */
export function normalizeLogoUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > BRANDING_LOGO_URL_MAX) return null;

  if (/^data:image\/(png|jpe?g|webp|gif|svg\+xml);/i.test(trimmed)) return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return trimmed;
}

/** Buang karakter kontrol & rapikan spasi; kosong → string kosong. */
function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  // `\u0000-\u001f` (kecuali tidak ada yang perlu) dibuang: teks ini masuk
  // `<title>` dan `<meta content>`, dan baris baru di situ memutus atribut.
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return stripped.slice(0, max);
}

/** Nilai apa pun → `Branding` yang valid. Nilai rusak jadi default, bukan error. */
export function normalizeBranding(input: unknown): Branding {
  if (input === null || typeof input !== "object") return { ...DEFAULT_BRANDING };
  const raw = input as Record<string, unknown>;
  return {
    logoUrl: normalizeLogoUrl(raw.logoUrl),
    heading: cleanText(raw.heading, BRANDING_HEADING_MAX),
    subheading: cleanText(raw.subheading, BRANDING_SUBHEADING_MAX),
    footer: cleanText(raw.footer, BRANDING_FOOTER_MAX),
  };
}

/** `true` kalau tidak ada satu pun bidang yang diisi operator. */
export function brandingIsDefault(branding: Branding): boolean {
  return (
    branding.logoUrl === null &&
    branding.heading === "" &&
    branding.subheading === "" &&
    branding.footer === ""
  );
}

/**
 * Judul yang benar-benar ditampilkan.
 *
 * Urutan: heading operator → nama acara → nama aplikasi. Heading kosong
 * **tidak** berarti judul kosong; halaman tamu tanpa judul terlihat seperti
 * halaman error.
 */
export function resolvedHeading(branding: Branding, eventName: string | null): string {
  if (branding.heading !== "") return branding.heading;
  if (eventName !== null && eventName.trim() !== "") return eventName.trim();
  return APP_NAME;
}

/** Subjudul default kalau operator tidak mengisinya: nama acara + tanggal. */
export function resolvedSubheading(
  branding: Branding,
  event: { name: string; date: string; hashtag: string | null } | null,
): string {
  if (branding.subheading !== "") return branding.subheading;
  if (event === null) return "";
  const parts = [event.name, event.date];
  if (event.hashtag !== null && event.hashtag.trim() !== "") parts.push(event.hashtag);
  return parts.join(" · ");
}
