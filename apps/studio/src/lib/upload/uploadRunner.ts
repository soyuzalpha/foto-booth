/**
 * Runner antrian upload: yang benar-benar menyentuh jaringan.
 *
 * Semua keputusan (kapan boleh coba, berapa lama menunggu, kapan menyerah) ada
 * di `@foto-booth/shared/uploadQueue` — murni dan sudah diuji. Modul ini cuma
 * menjalankan keputusan itu: ambil batch, tandatangani, PUT, lapor, simpan
 * status. Jadi tidak ada aturan retry yang ditulis dua kali.
 *
 * Dua hal yang gampang salah dan sengaja ditangani di sini:
 *
 *   · **Status `uploading` harus tersimpan sebelum request jalan.** Kalau tab
 *     ditutup di tengah upload, item yang tersimpan sebagai `uploading` akan
 *     dikembalikan ke `queued` saat runner berikutnya bangun — kalau statusnya
 *     tidak pernah ditulis, item itu terlihat `queued` padahal sudah dikirim,
 *     dan terkirim dua kali.
 *   · **Satu item gagal tidak menghentikan batch.** Foto lain di antrian tidak
 *     boleh ikut tertahan gara-gara satu file rusak.
 */

import {
  nextBatch,
  reduceUpload,
  UPLOAD_CONCURRENCY,
  type UploadItem,
} from "@foto-booth/shared";

import type { UploadClient } from "./uploadClient.ts";
import type { UploadStore } from "./uploadStore.ts";

export interface UploadRunnerDeps {
  store: UploadStore;
  client: UploadClient;
  now: () => Date;
  concurrency?: number;
  /** Dipanggil setiap kali satu item berubah status, supaya UI bisa menyegarkan. */
  onItem?: (item: UploadItem) => void;
  /**
   * Hapus blob lokal setelah upload sukses. Default `true`: galeri di bucket
   * sudah jadi salinan durabelnya, dan menyimpan dua kali bikin kuota kiosk
   * cepat penuh. Set `false` kalau foto masih dibutuhkan lokal (mis. cetak
   * ulang setelah kiosk restart).
   */
  deleteLocalAfterUpload?: boolean;
}

export interface RunReport {
  /** Item yang benar-benar dicoba di putaran ini. */
  attempted: number;
  uploaded: number;
  failed: number;
  /** Item yang dilewati karena blob lokalnya hilang — bukan kegagalan jaringan. */
  orphaned: number;
  /** Item yang balik ke `queued` (masih ada sisa percobaan). */
  rescheduled: number;
  errors: { id: string; error: string }[];
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Simpan perubahan item + kabari UI. Satu tempat, supaya tidak ada yang lupa. */
async function persist(deps: UploadRunnerDeps, item: UploadItem): Promise<UploadItem> {
  await deps.store.putItem(item);
  deps.onItem?.(item);
  return item;
}

/**
 * Kerjakan satu item dari awal sampai selesai/gagal.
 * Melempar hanya kalau penyimpanan gagal; kegagalan jaringan jadi status.
 */
async function processItem(deps: UploadRunnerDeps, item: UploadItem): Promise<"uploaded" | "failed" | "rescheduled" | "orphaned"> {
  const now = deps.now();

  const started = await persist(deps, reduceUpload(item, { type: "start" }));

  const blob = await deps.store.getBlob(started.blobKey);
  const thumb = await deps.store.getBlob(started.thumbBlobKey);

  if (blob === null) {
    // Blob-nya hilang (kuota dibersihkan browser). Item ini tidak akan pernah
    // bisa dikirim, jadi jangan dibiarkan menggantung di antrian.
    await deps.store.deleteItem(started.id);
    deps.onItem?.(started);
    return "orphaned";
  }

  try {
    const signed = await deps.client.signUpload(started.galleryId, {
      contentType: started.contentType,
      bytes: started.bytes,
      width: started.width,
      height: started.height,
      filename: started.filename,
    });

    await deps.client.putBytes(signed.uploadUrl, blob, started.contentType);

    // Thumbnail boleh gagal sendiri: halaman galeri tetap jalan tanpa
    // pratinjau, dan menandai upload gagal hanya karena thumbnail akan
    // mengirim ulang foto besar berkali-kali. Karena itu PUT thumb tidak
    // boleh berada di `try` yang sama dengan PUT berkas asli.
    //
    // Tapi kalau thumb-nya **tidak jadi** terkirim, kita tidak boleh
    // mendaftarkan `thumbKey` yang menunjuk objek tidak ada: halaman tamu
    // akan menampilkan `<img>` rusak (API membalas 502 karena objeknya tidak
    // ditemukan di bucket). Jatuhkan saja ke berkas asli — tamu melihat foto
    // penuh, sedikit lebih berat, tapi tidak pernah ada gambar pecah.
    let thumbKey = signed.key;
    if (thumb !== null) {
      try {
        await deps.client.putBytes(signed.thumbUploadUrl, thumb, started.contentType);
        thumbKey = signed.thumbKey;
      } catch {
        // Sengaja ditelan: foto besar sudah masuk bucket dan itu yang penting.
      }
    }

    const registered = await deps.client.registerPhoto(started.galleryId, {
      photoId: signed.photoId,
      key: signed.key,
      thumbKey,
      width: started.width,
      height: started.height,
      bytes: started.bytes,
      filename: started.filename,
    });

    await persist(deps, reduceUpload(started, {
      type: "success",
      remotePhotoId: registered.id,
      at: deps.now(),
    }));

    if (deps.deleteLocalAfterUpload !== false) {
      await deps.store.deleteBlob(started.blobKey);
      await deps.store.deleteBlob(started.thumbBlobKey);
    }

    return "uploaded";
  } catch (error) {
    const next = await persist(deps, reduceUpload(started, {
      type: "failure",
      error: message(error),
      at: now,
    }));
    return next.state === "failed" ? "failed" : "rescheduled";
  }
}

/**
 * Satu putaran antrian: ambil sebanyak `concurrency` item yang siap, kerjakan
 * paralel, lalu berhenti. Tidak pernah melempar karena kegagalan jaringan.
 */
export async function runUploadQueue(deps: UploadRunnerDeps): Promise<RunReport> {
  const concurrency = deps.concurrency ?? UPLOAD_CONCURRENCY;
  const all = await deps.store.allItems();

  // Item yang tertinggal di `uploading` (tab ditutup di tengah jalan) dianggap
  // `queued` lagi: tidak ada upload yang benar-benar berjalan saat ini. Yang
  // dikembalikan juga **disimpan**, supaya state di IndexedDB tidak terus
  // berbohong kalau runner berikutnya tidak sempat jalan.
  const recovered: UploadItem[] = [];
  for (const item of all) {
    if (item.state !== "uploading") {
      recovered.push(item);
      continue;
    }
    const requeued: UploadItem = { ...item, state: "queued" };
    await deps.store.putItem(requeued);
    deps.onItem?.(requeued);
    recovered.push(requeued);
  }

  const batch = nextBatch(recovered, deps.now(), concurrency);
  const report: RunReport = {
    attempted: batch.length,
    uploaded: 0,
    failed: 0,
    orphaned: 0,
    rescheduled: 0,
    errors: [],
  };

  // Paralel terbatas: `batch` sudah dipotong sebesar concurrency.
  const results = await Promise.all(
    batch.map(async (item) => {
      try {
        return { item, outcome: await processItem(deps, item) };
      } catch (error) {
        return { item, outcome: "rescheduled" as const, error: message(error) };
      }
    }),
  );

  for (const { item, outcome, error } of results) {
    if (outcome === "uploaded") report.uploaded += 1;
    else if (outcome === "failed") report.failed += 1;
    else if (outcome === "orphaned") report.orphaned += 1;
    else report.rescheduled += 1;

    if (error !== undefined) report.errors.push({ id: item.id, error });
  }

  return report;
}

/** Jumlah item yang masih menunggu — dipakai UI untuk badge. */
export async function pendingCount(store: UploadStore): Promise<number> {
  const items = await store.allItems();
  return items.filter((item) => item.state !== "uploaded").length;
}
