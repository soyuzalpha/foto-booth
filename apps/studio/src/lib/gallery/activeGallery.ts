/**
 * Galeri yang sedang dilayani kiosk.
 *
 * Kiosk melayani **satu acara pada satu waktu**, jadi studio menyimpan satu
 * pilihan galeri aktif — bukan daftar. Pilihan ini yang dipakai antrian upload
 * sebagai tujuan, dan yang QR-nya ditampilkan ke tamu.
 *
 * Disimpan di `localStorage` supaya tahan refresh: kiosk yang ke-reload di
 * tengah acara tidak boleh lupa sedang mengunggah ke galeri mana. Kalau
 * pilihan itu hilang, foto-foto berikutnya masuk ke antrian tanpa tujuan.
 *
 * Galeri yang **sudah kedaluwarsa diperlakukan sebagai tidak ada.** TTL 30 hari
 * berarti galeri lama tetap ada di daftar API sampai job cleanup berjalan;
 * mengarahkan upload ke situ cuma menghasilkan 404 beruntun.
 */

import type { StorageLike } from "../session/operatorSession.ts";

export interface ActiveGallery {
  id: string;
  hash: string;
  /** URL publik lengkap — sudah termasuk origin yang dipakai saat dipilih. */
  url: string;
  /** Nama acara, murni untuk ditampilkan. */
  label: string;
  expiresAt: string;
}

export const ACTIVE_GALLERY_KEY = "foto-booth:active-gallery";

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function parseActiveGallery(raw: unknown): ActiveGallery | null {
  if (typeof raw !== "object" || raw === null) return null;

  const { id, hash, url, label, expiresAt } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (typeof hash !== "string" || hash === "") return null;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;

  return {
    id,
    hash,
    url: typeof url === "string" ? url : "",
    label: typeof label === "string" ? label : "",
    expiresAt,
  };
}

export function isGalleryExpired(gallery: ActiveGallery, now: Date): boolean {
  return Date.parse(gallery.expiresAt) <= now.getTime();
}

export function loadActiveGallery(
  now: Date = new Date(),
  storage: StorageLike | null = defaultStorage(),
): ActiveGallery | null {
  if (storage === null) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(ACTIVE_GALLERY_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const gallery = parseActiveGallery(parsed);
  if (gallery === null) return null;

  if (isGalleryExpired(gallery, now)) {
    clearActiveGallery(storage);
    return null;
  }
  return gallery;
}

export function saveActiveGallery(
  gallery: ActiveGallery,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(ACTIVE_GALLERY_KEY, JSON.stringify(gallery));
    return true;
  } catch {
    return false;
  }
}

export function clearActiveGallery(storage: StorageLike | null = defaultStorage()): void {
  if (storage === null) return;
  try {
    storage.removeItem(ACTIVE_GALLERY_KEY);
  } catch {
    // Penyimpanan tidak bisa diakses — tidak ada yang bisa dibereskan.
  }
}

/** Bentuk dari API → bentuk tersimpan. */
export function activeFromSummary(
  gallery: { id: string; hash: string; expiresAt: string; url: string },
  label: string,
): ActiveGallery {
  return {
    id: gallery.id,
    hash: gallery.hash,
    url: gallery.url,
    label,
    expiresAt: gallery.expiresAt,
  };
}
