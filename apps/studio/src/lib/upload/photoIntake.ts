/**
 * Jalur masuk satu foto: **arsip lokal dulu, lalu antrian upload.**
 *
 * Ini titik di mana aturan Fase 5 bertemu kenyataan di kiosk:
 *
 *   · **Arsip lokal tidak pernah jadi syarat.** OPFS bisa tidak ada (browser
 *     lama, mode privat) atau kehabisan kuota. `LocalArchive.save` sengaja
 *     tidak melempar — ia mengembalikan `null`. Kalau arsip gagal, foto tetap
 *     masuk antrian dan tetap sampai ke tamu; yang hilang cuma salinan
 *     cetak-ulang.
 *   · **Urutan arsip-dulu penting justru karena itu.** Kalau antrian ditulis
 *     lebih dulu dan blob-nya gagal (kuota IndexedDB penuh), tidak ada apa pun
 *     yang tersisa. Dengan arsip lebih dulu, foto masih ada di disk.
 *   · **Kegagalan antrian dilaporkan, bukan disembunyikan.** Kalau `enqueue`
 *     melempar, pemanggil harus tahu — kalau tidak, UI menampilkan "tersimpan"
 *     untuk foto yang sebenarnya tidak akan pernah terkirim.
 *
 * Yang **tidak** dilakukan di sini: menyentuh jaringan. Upload adalah kerja
 * `uploadRunner`, dan memisahkannya bikin fungsi ini bisa diuji tanpa server.
 */

import type { UploadContentType, UploadItem } from "@foto-booth/shared";

import type { ArchiveEntry, LocalArchive } from "./localArchive.ts";
import { enqueueUpload, type UploadStore } from "./uploadStore.ts";

/** Satu foto siap disimpan. Byte-nya sudah jadi `Blob` — capture yang mengurus itu. */
export interface IntakePhoto {
  blob: Blob;
  /** Pratinjau; `null` = tidak ada. Kegagalannya terpisah dari foto besar. */
  thumb: Blob | null;
  contentType: UploadContentType;
  width: number;
  height: number;
  filename: string;
  /** Nomor urut dalam sesi — dipakai untuk penamaan berkas arsip. */
  index: number;
}

export interface IntakeDeps {
  store: UploadStore;
  /** `null` = arsip lokal tidak tersedia; bukan kesalahan. */
  archive: LocalArchive | null;
  galleryId: string;
  now?: () => Date;
}

export interface IntakeResult {
  /** Item antrian; `null` kalau penulisan antrian gagal. */
  item: UploadItem | null;
  /** Entri arsip; `null` kalau OPFS tidak ada atau gagal. */
  archived: ArchiveEntry | null;
  /** Pesan kalau foto **tidak** masuk antrian. `null` = aman. */
  queueError: string | null;
}

/**
 * Simpan satu foto ke arsip lokal lalu masukkan ke antrian upload.
 *
 * Tidak pernah melempar. Pemanggil memeriksa `queueError` untuk tahu apakah
 * fotonya benar-benar akan terkirim.
 */
export async function intakePhoto(deps: IntakeDeps, photo: IntakePhoto): Promise<IntakeResult> {
  // 1. Arsip lokal. Best-effort: `LocalArchive.save` sudah mengembalikan `null`
  //    alih-alih melempar, tapi kontrak "tidak pernah melempar" berlaku juga
  //    untuk implementasi arsip lain (dan untuk bug di dalamnya). Kegagalan
  //    arsip tidak boleh menyeret antrian.
  let archived: ArchiveEntry | null = null;
  if (deps.archive !== null) {
    try {
      archived = await deps.archive.save(`local-${photo.index}`, photo.index, photo.blob, photo.contentType);
    } catch {
      archived = null;
    }
  }

  // 2. Antrian upload. Bisa melempar (kuota) — dan itu harus terlihat.
  try {
    const item = await enqueueUpload(
      deps.store,
      {
        galleryId: deps.galleryId,
        blob: photo.blob,
        thumb: photo.thumb,
        contentType: photo.contentType,
        width: photo.width,
        height: photo.height,
        filename: photo.filename,
      },
      deps.now === undefined ? {} : { now: deps.now() },
    );
    return { item, archived, queueError: null };
  } catch (error) {
    return {
      item: null,
      archived,
      queueError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Ringkasan hasil beberapa foto — dipakai UI untuk menampilkan satu pesan. */
export interface IntakeSummary {
  queued: number;
  archived: number;
  failed: number;
  /** Pesan pertama yang gagal, kalau ada. */
  error: string | null;
}

export function summarizeIntake(results: readonly IntakeResult[]): IntakeSummary {
  let queued = 0;
  let archived = 0;
  let failed = 0;
  let error: string | null = null;

  for (const result of results) {
    if (result.item !== null) queued += 1;
    if (result.archived !== null) archived += 1;
    if (result.queueError !== null) {
      failed += 1;
      error ??= result.queueError;
    }
  }

  return { queued, archived, failed, error };
}
