/**
 * Mesin antrian upload — MURNI, tanpa I/O.
 *
 * Kenapa murni: antrian ini yang menentukan "foto saya hilang atau tidak".
 * Kalau aturan retry/statusnya tersebar di dalam hook React atau di dalam
 * IndexedDB, satu-satunya cara menguji "jaringan putus 3× lalu nyambung" adalah
 * membuka browser sungguhan. Di sini keputusannya cuma fungsi dari
 * `(item, sekarang) → item`, jadi bisa diuji ribuan kali tanpa jaringan.
 *
 * Siklus hidup satu foto:
 *
 *   local-only → queued → uploading → uploaded
 *                            ↑   ↓
 *                            └ failed ┘  (balik ke queued setelah backoff)
 *
 *   · `local-only` — blob ada di perangkat, belum pernah dicoba. Ini keadaan
 *     yang WAJIB selamat dari "tutup tab" (syarat Fase 5).
 *   · `uploaded`   — terminal. Tidak pernah diupload ulang.
 *   · `failed`     — sudah kehabisan percobaan; tetap ada di daftar supaya user
 *     bisa mencoba manual, tapi auto-sync tidak menyentuhnya lagi.
 */

import { UPLOAD_MAX_ATTEMPTS } from "./constants.ts";
import type { UploadContentType } from "./schemas.ts";

export const UPLOAD_STATES = [
  "local-only",
  "queued",
  "uploading",
  "uploaded",
  "failed",
] as const;
export type UploadState = (typeof UPLOAD_STATES)[number];

/** Satu foto dalam antrian. Semua field-nya serializable → aman di IndexedDB. */
export interface UploadItem {
  /** Id lokal, dibuat studio. Kunci IndexedDB. */
  id: string;
  galleryId: string;
  /** Kunci blob lokal di IndexedDB (`STORE_UPLOAD_BLOBS`). */
  blobKey: string;
  thumbBlobKey: string;
  filename: string;
  contentType: UploadContentType;
  bytes: number;
  width: number;
  height: number;
  state: UploadState;
  /** Berapa kali sudah dicoba (gagal maupun tidak). */
  attempts: number;
  /** ISO — jangan coba sebelum jam ini. `null` = boleh sekarang. */
  nextAttemptAt: string | null;
  /** Pesan error terakhir, buat ditampilkan ke operator. */
  lastError: string | null;
  /** Diisi API setelah `register` sukses. */
  remotePhotoId: string | null;
  /** ISO. */
  createdAt: string;
  /** ISO. `null` selama belum sukses. */
  uploadedAt: string | null;
}

export type UploadEvent =
  /** Blob sudah tersimpan lokal → foto siap ikut antrian. */
  | { type: "enqueue" }
  /** Runner mulai mengerjakan item ini. */
  | { type: "start" }
  /** Dua PUT + register sukses. */
  | { type: "success"; remotePhotoId: string; at: Date }
  /** Percobaan gagal; `at` dipakai menghitung backoff berikutnya. */
  | { type: "failure"; error: string; at: Date }
  /** User menekan "coba lagi" — reset percobaan & jadwal. */
  | { type: "retry-now"; at: Date };

/**
 * Backoff eksponensial dengan jitter **deterministik**.
 *
 * Jitter harus deterministik (diturunkan dari id, bukan `Math.random`) supaya
 * tes bisa meng-assert angka pastinya. Efeknya sama: 20 foto yang gagal
 * bersamaan tidak menabrak server di milidetik yang sama.
 *
 * 1→2 s, 2→4 s, 3→8 s, 4→16 s, 5→32 s (maks 60 s).
 */
export function backoffMs(attempt: number, id: string): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  const jitter = deterministicJitter(id, attempt);
  // Jitter ±20% supaya dua foto tidak pernah punya jadwal identik.
  const factor = 0.8 + 0.4 * jitter;
  return Math.round(base * factor);
}

/** Angka 0..1 dari hash id+attempt — pengganti `Math.random` yang bisa diuji. */
function deterministicJitter(id: string, attempt: number): number {
  let hash = 2166136261 ^ attempt;
  const seed = `${id}#${attempt}`;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

/** Reducer murni: satu event → keadaan berikutnya. Tidak pernah melempar. */
export function reduceUpload(item: UploadItem, event: UploadEvent): UploadItem {
  switch (event.type) {
    case "enqueue":
      // Sudah pernah diupload → jangan mundur jadi `queued`.
      if (item.state === "uploaded") return item;
      return { ...item, state: "queued", nextAttemptAt: null, lastError: null };

    case "start":
      // Hanya yang benar-benar siap yang boleh jalan.
      if (item.state !== "queued" && item.state !== "failed") return item;
      return { ...item, state: "uploading", attempts: item.attempts + 1 };

    case "success":
      return {
        ...item,
        state: "uploaded",
        remotePhotoId: event.remotePhotoId,
        uploadedAt: event.at.toISOString(),
        nextAttemptAt: null,
        lastError: null,
      };

    case "failure": {
      // `attempts` sudah dinaikkan di `start`.
      if (item.attempts >= UPLOAD_MAX_ATTEMPTS) {
        return { ...item, state: "failed", lastError: event.error, nextAttemptAt: null };
      }
      const wait = backoffMs(item.attempts, item.id);
      return {
        ...item,
        state: "queued",
        lastError: event.error,
        nextAttemptAt: new Date(event.at.getTime() + wait).toISOString(),
      };
    }

    case "retry-now":
      return {
        ...item,
        state: "queued",
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
      };
  }
}

/** Item ini boleh dikerjakan sekarang? */
export function isReady(item: UploadItem, now: Date): boolean {
  if (item.state !== "queued") return false;
  if (item.nextAttemptAt === null) return true;
  return new Date(item.nextAttemptAt).getTime() <= now.getTime();
}

/**
 * Ambil sampai `concurrency` item yang siap dikerjakan.
 *
 * Urut `createdAt` supaya foto yang diambil lebih dulu ikut terkirim lebih dulu
 * — tamu yang menunggu di depan kiosk mengharapkan urutan itu.
 */
export function nextBatch(
  items: readonly UploadItem[],
  now: Date,
  concurrency: number,
): UploadItem[] {
  if (concurrency <= 0) return [];
  return items
    .filter((item) => isReady(item, now))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(0, concurrency);
}

export interface QueueCounts {
  "local-only": number;
  queued: number;
  uploading: number;
  uploaded: number;
  failed: number;
  /** Yang masih harus dikerjakan (belum `uploaded`). */
  pending: number;
  total: number;
}

export function countByState(items: readonly UploadItem[]): QueueCounts {
  const counts: QueueCounts = {
    "local-only": 0,
    queued: 0,
    uploading: 0,
    uploaded: 0,
    failed: 0,
    pending: 0,
    total: items.length,
  };
  for (const item of items) counts[item.state] += 1;
  counts.pending = counts.total - counts.uploaded;
  return counts;
}

/** Ada kerjaan yang bisa jalan sekarang? Dipakai auto-sync memutuskan bangun. */
export function hasWork(items: readonly UploadItem[], now: Date): boolean {
  return items.some((item) => isReady(item, now));
}
