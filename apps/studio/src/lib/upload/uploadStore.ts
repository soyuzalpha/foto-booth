/**
 * Penyimpanan antrian upload: metadata item + biner fotonya.
 *
 * Kenapa blob dipisah dari item: saat mengantre, yang dibaca-tulis terus adalah
 * metadata (status, percobaan, jadwal). Kalau blob besar ikut dalam record yang
 * sama, setiap perubahan status memaksa IndexedDB menulis ulang puluhan MB.
 *
 * Aturan yang tidak boleh dilanggar: **blob ditulis SEBELUM item**. Kalau
 * urutannya dibalik dan penulisan blob gagal (kuota penuh), kita punya item
 * antrian yang menunjuk blob yang tidak ada — dan runner akan gagal selamanya
 * dengan error yang membingungkan. Urutan yang benar membuat kegagalan blob
 * terjadi sebelum ada jejak apa pun.
 */

import type { UploadContentType, UploadItem } from "@foto-booth/shared";

import {
  openDatabase,
  promisify,
  STORE_UPLOAD_BLOBS,
  STORE_UPLOAD_ITEMS,
} from "../idb.ts";

export interface UploadStore {
  putBlob(key: string, blob: Blob): Promise<void>;
  getBlob(key: string): Promise<Blob | null>;
  deleteBlob(key: string): Promise<void>;

  putItem(item: UploadItem): Promise<void>;
  getItem(id: string): Promise<UploadItem | null>;
  allItems(): Promise<UploadItem[]>;
  itemsForGallery(galleryId: string): Promise<UploadItem[]>;
  deleteItem(id: string): Promise<void>;
}

/** Versi memori — dipakai tes dan sebagai fallback kalau IndexedDB tidak ada. */
export class MemoryUploadStore implements UploadStore {
  private readonly blobs = new Map<string, Blob>();
  private readonly items = new Map<string, UploadItem>();

  async putBlob(key: string, blob: Blob): Promise<void> {
    this.blobs.set(key, blob);
  }

  async getBlob(key: string): Promise<Blob | null> {
    return this.blobs.get(key) ?? null;
  }

  async deleteBlob(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async putItem(item: UploadItem): Promise<void> {
    this.items.set(item.id, item);
  }

  async getItem(id: string): Promise<UploadItem | null> {
    return this.items.get(id) ?? null;
  }

  async allItems(): Promise<UploadItem[]> {
    return [...this.items.values()];
  }

  async itemsForGallery(galleryId: string): Promise<UploadItem[]> {
    return [...this.items.values()].filter((item) => item.galleryId === galleryId);
  }

  async deleteItem(id: string): Promise<void> {
    this.items.delete(id);
  }
}

export class IdbUploadStore implements UploadStore {
  private db: IDBDatabase | null = null;
  private readonly factory: IDBFactory;

  constructor(factory: IDBFactory) {
    this.factory = factory;
  }

  private async handle(): Promise<IDBDatabase> {
    if (this.db === null) this.db = await openDatabase(this.factory);
    return this.db;
  }

  private async blobStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.handle();
    return db.transaction(STORE_UPLOAD_BLOBS, mode).objectStore(STORE_UPLOAD_BLOBS);
  }

  private async itemStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.handle();
    return db.transaction(STORE_UPLOAD_ITEMS, mode).objectStore(STORE_UPLOAD_ITEMS);
  }

  async putBlob(key: string, blob: Blob): Promise<void> {
    const store = await this.blobStore("readwrite");
    await promisify(store.put({ key, blob }));
  }

  async getBlob(key: string): Promise<Blob | null> {
    const store = await this.blobStore("readonly");
    const raw = await promisify<{ key: string; blob: Blob } | undefined>(store.get(key));
    return raw?.blob ?? null;
  }

  async deleteBlob(key: string): Promise<void> {
    const store = await this.blobStore("readwrite");
    await promisify(store.delete(key));
  }

  async putItem(item: UploadItem): Promise<void> {
    const store = await this.itemStore("readwrite");
    await promisify(store.put(item));
  }

  async getItem(id: string): Promise<UploadItem | null> {
    const store = await this.itemStore("readonly");
    const raw = await promisify<UploadItem | undefined>(store.get(id));
    return raw ?? null;
  }

  async allItems(): Promise<UploadItem[]> {
    const store = await this.itemStore("readonly");
    return promisify<UploadItem[]>(store.getAll());
  }

  async itemsForGallery(galleryId: string): Promise<UploadItem[]> {
    const store = await this.itemStore("readonly");
    const index = store.index("galleryId");
    return promisify<UploadItem[]>(index.getAll(galleryId));
  }

  async deleteItem(id: string): Promise<void> {
    const store = await this.itemStore("readwrite");
    await promisify(store.delete(id));
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export function createUploadStore(
  global: { indexedDB?: IDBFactory } = globalThis as { indexedDB?: IDBFactory },
): { store: UploadStore; kind: "indexeddb" | "memory" } {
  if (global.indexedDB !== undefined) {
    return { store: new IdbUploadStore(global.indexedDB), kind: "indexeddb" };
  }
  return { store: new MemoryUploadStore(), kind: "memory" };
}

/** Id lokal unik untuk satu item antrian. */
export function newUploadId(prefix = "up"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Satu foto siap diantre: byte asli + pratinjau, plus metadata tampilan. */
export interface NewUpload {
  galleryId: string;
  blob: Blob;
  thumb: Blob | null;
  contentType: UploadContentType;
  width: number;
  height: number;
  filename: string;
}

/**
 * Masukkan satu foto ke antrian. Mengembalikan item yang sudah tersimpan.
 *
 * Urutannya sengaja tidak bisa dibalik: **blob dulu, item terakhir**. Kalau
 * blob gagal ditulis (kuota penuh) dan item sudah terlanjur ada, kita punya
 * antrian yang menunjuk blob hantu — runner akan menganggapnya `orphaned` dan
 * membuang item tanpa pesan yang jelas. Dengan urutan ini, kegagalan blob
 * terjadi sebelum ada jejak apa pun, dan `putBlob` melempar ke pemanggil.
 *
 * Item masuk sebagai `queued` (bukan `local-only`): `enqueue` = "siap ikut
 * antrian sekarang". Status `local-only` dipakai capture sebelum byte-nya
 * selesai ditulis.
 */
export async function enqueueUpload(
  store: UploadStore,
  photo: NewUpload,
  options: { now?: Date; id?: string } = {},
): Promise<UploadItem> {
  const now = options.now ?? new Date();
  const id = options.id ?? newUploadId();
  const blobKey = `blob:${id}`;
  const thumbBlobKey = `thumb:${id}`;

  await store.putBlob(blobKey, photo.blob);
  if (photo.thumb !== null) await store.putBlob(thumbBlobKey, photo.thumb);

  const item: UploadItem = {
    id,
    galleryId: photo.galleryId,
    blobKey,
    thumbBlobKey,
    filename: photo.filename,
    contentType: photo.contentType,
    bytes: photo.blob.size,
    width: photo.width,
    height: photo.height,
    state: "queued",
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    remotePhotoId: null,
    createdAt: now.toISOString(),
    uploadedAt: null,
  };

  await store.putItem(item);
  return item;
}

/**
 * Buang item beserta blob-nya. Dipakai saat operator membatalkan foto atau
 * saat item ditandai `orphaned`.
 */
export async function discardUpload(store: UploadStore, id: string): Promise<void> {
  const item = await store.getItem(id);
  await store.deleteItem(id);
  if (item === null) return;
  await store.deleteBlob(item.blobKey);
  await store.deleteBlob(item.thumbBlobKey);
}
