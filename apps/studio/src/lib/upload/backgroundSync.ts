/**
 * Background Sync — "kerjakan antrian walau tab tidak aktif".
 *
 * Kenyataan yang membentuk modul ini: Background Sync **tidak ada di Safari dan
 * Firefox**, dan di Chromium pun hanya jalan kalau service worker aktif. Jadi
 * ini bukan mekanisme utama, cuma percepatan. Mekanisme utamanya tetap: coba
 * lagi saat halaman hidup (event `online` + timer).
 *
 * Rancangan yang dipilih: service worker **tidak** mengirim foto sendiri. Dia
 * cuma membangunkan halaman. Alasannya token sesi operator ada di
 * `localStorage` — tidak bisa dibaca service worker. Memindahkan token ke SW
 * berarti menaruh kredensial di tempat yang cakupannya lebih luas, dan itu
 * harga yang terlalu mahal untuk fitur ini.
 *
 * Kalau tidak ada tab yang terbuka, sync ditandai gagal oleh browser dan akan
 * dicoba lagi saat halaman berikutnya dibuka. Itu perilaku yang benar: tidak
 * ada yang hilang, foto tetap di antrian.
 */

export const UPLOAD_SYNC_TAG = "foto-booth-upload";

/** Bagian dari `ServiceWorkerRegistration` yang kita pakai. */
export interface SyncCapableRegistration {
  sync?: { register(tag: string): Promise<void> };
}

export interface SyncSupport {
  /** Browser punya API-nya. */
  supported: boolean;
  /** Registrasi ke browser berhasil. */
  registered: boolean;
  /** Kenapa tidak terdaftar — ditampilkan sebagai diagnostik, bukan error. */
  reason: string | null;
}

/**
 * Minta browser menjalankan sync `UPLOAD_SYNC_TAG` begitu ada jaringan.
 * Tidak pernah melempar: pemanggil selalu bisa jatuh ke fallback.
 */
export async function registerUploadSync(
  registration: SyncCapableRegistration | null,
): Promise<SyncSupport> {
  if (registration === null) {
    return { supported: false, registered: false, reason: "service worker belum siap" };
  }
  if (registration.sync === undefined) {
    return { supported: false, registered: false, reason: "Background Sync tidak didukung" };
  }

  try {
    await registration.sync.register(UPLOAD_SYNC_TAG);
    return { supported: true, registered: true, reason: null };
  } catch (error) {
    return {
      supported: true,
      registered: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Dengarkan permintaan dari service worker.
 *
 * Service worker mengirim `{ type: "foto-booth:sync", tag }`; kita jalankan
 * `handler` untuk tag upload. Pesan lain diabaikan supaya penambahan fitur lain
 * di SW tidak diam-diam memicu upload.
 */
export function listenForSyncRequests(handler: () => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return () => {};
  }

  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; tag?: unknown } | null;
    if (data === null || typeof data !== "object") return;
    if (data.type !== "foto-booth:sync") return;
    if (data.tag !== UPLOAD_SYNC_TAG) return;
    handler();
  };

  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}
