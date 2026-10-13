/**
 * Job pembersihan: galeri yang lewat masa simpan + kode OTP basi.
 *
 * Ini yang membuat janji "galeri dihapus otomatis 30 hari" jadi benar. Karena
 * itu urutannya penting dan disengaja:
 *
 *   objek bucket → baris foto → baris galeri
 *
 * Kalau dibalik (hapus baris dulu), kegagalan di tengah meninggalkan objek di
 * bucket yang **tidak ada lagi yang tahu** cara menemukannya — sampah permanen
 * yang memakan storage. Dengan urutan ini, kegagalan apa pun menyisakan galeri
 * yang masih terdaftar, dan jalan berikutnya mencoba lagi.
 *
 * Job ini idempoten: menjalankannya dua kali untuk galeri yang sama tidak
 * merusak apa pun (menghapus objek yang tidak ada tetap sukses).
 */

import { albumPrefixes } from "@foto-booth/shared";

import type { ServerContext } from "../context.ts";
import { deletePrefix } from "../objectStore.ts";
import {
  deleteExpiredOtps,
  deleteGallery,
  deletePhotos,
  listExpiredGalleries,
} from "../store.ts";

export interface TtlReport {
  galleriesScanned: number;
  galleriesDeleted: number;
  photosDeleted: number;
  objectsDeleted: number;
  otpsDeleted: number;
  /** Galeri yang gagal dibersihkan; akan dicoba lagi di jalan berikutnya. */
  failures: { galleryId: string; hash: string; message: string }[];
}

export interface TtlOptions {
  /** Batas galeri per jalan, supaya satu jalan tidak mengunci DB lama. */
  limit?: number;
  logger?: { error: (payload: object, message: string) => void };
}

export async function runTtlCleanup(ctx: ServerContext, options: TtlOptions = {}): Promise<TtlReport> {
  const now = ctx.now();
  const nowIso = now.toISOString();
  const expired = listExpiredGalleries(ctx.db, nowIso, options.limit ?? 200);

  const report: TtlReport = {
    galleriesScanned: expired.length,
    galleriesDeleted: 0,
    photosDeleted: 0,
    objectsDeleted: 0,
    otpsDeleted: 0,
    failures: [],
  };

  for (const gallery of expired) {
    try {
      // 1. Objek dulu.
      for (const prefix of albumPrefixes(gallery.hash)) {
        report.objectsDeleted += await deletePrefix(ctx.s3, prefix, {
          fetch: ctx.fetch,
          now: ctx.now,
        });
      }
      // 2. Baru baris.
      report.photosDeleted += deletePhotos(ctx.db, gallery.id);
      deleteGallery(ctx.db, gallery.id);
      report.galleriesDeleted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failures.push({ galleryId: gallery.id, hash: gallery.hash, message });
      options.logger?.error({ err: error, galleryId: gallery.id }, "gagal membersihkan galeri kedaluwarsa");
    }
  }

  report.otpsDeleted = deleteExpiredOtps(ctx.db, nowIso);
  return report;
}

/** Interval default: sekali sehari. TTL dihitung hari, jadi lebih sering sia-sia. */
export const TTL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Jalankan pembersihan berkala. Mengembalikan fungsi untuk menghentikannya.
 *
 * Timer-nya `unref()`-ed: job ini tidak boleh menahan proses hidup saat server
 * sedang dimatikan.
 */
export function scheduleTtlCleanup(ctx: ServerContext, options: TtlOptions & { intervalMs?: number } = {}): () => void {
  const interval = options.intervalMs ?? TTL_INTERVAL_MS;

  const tick = () => {
    void runTtlCleanup(ctx, options).catch((error: unknown) => {
      options.logger?.error({ err: error }, "job TTL gagal");
    });
  };

  const timer = setInterval(tick, interval);
  timer.unref();
  // Satu jalan saat start: kalau server sempat mati beberapa hari, jangan
  // menunggu 24 jam untuk membersihkan yang sudah basi.
  tick();

  return () => clearInterval(timer);
}
