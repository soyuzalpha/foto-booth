/**
 * Tes antrian upload di sisi penyimpanan.
 *
 * Dua janji yang diuji di sini, bukan sekadar "bisa menyimpan":
 *
 *   1. **Urutan tulis.** Blob harus tersimpan sebelum item. Kalau tidak,
 *      kegagalan kuota meninggalkan item yang menunjuk blob hantu.
 *   2. **Tidak bocor.** Membuang item harus ikut membuang blob-nya, kalau
 *      tidak kuota kiosk habis oleh foto yang sudah tidak ada di antrian.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { UploadItem } from "@foto-booth/shared";

import {
  createUploadStore,
  discardUpload,
  enqueueUpload,
  MemoryUploadStore,
  newUploadId,
  type NewUpload,
  type UploadStore,
} from "./uploadStore.ts";

function photo(overrides: Partial<NewUpload> = {}): NewUpload {
  return {
    galleryId: "gal-1",
    blob: new Blob(["asli"], { type: "image/jpeg" }),
    thumb: new Blob(["thumb"], { type: "image/jpeg" }),
    contentType: "image/jpeg",
    width: 1920,
    height: 1080,
    filename: "IMG_0001.jpg",
    ...overrides,
  };
}

test("createUploadStore memilih indexeddb kalau ada, memory kalau tidak", () => {
  const memory = createUploadStore({ indexedDB: undefined });
  assert.equal(memory.kind, "memory");
  assert.ok(memory.store instanceof MemoryUploadStore);

  const idb = createUploadStore({ indexedDB: {} as IDBFactory });
  assert.equal(idb.kind, "indexeddb");
});

test("put lalu get mengembalikan blob yang sama", async () => {
  const store = new MemoryUploadStore();
  const blob = new Blob(["isi"], { type: "image/png" });

  await store.putBlob("k1", blob);

  const loaded = await store.getBlob("k1");
  assert.equal(loaded?.size, blob.size);
  assert.equal(await store.getBlob("tidak-ada"), null);
});

/**
 * Store yang mendelegasikan ke `inner`, dengan hook sebelum `putBlob`/`putItem`.
 * Ditulis eksplisit (bukan spread) karena spread pada instance class tidak
 * menyalin method prototype — hasilnya objek kosong.
 */
function spyStore(inner: UploadStore, onCall: (label: string) => void): UploadStore {
  return {
    putBlob: async (k, b) => {
      onCall(`blob:${k}`);
      return inner.putBlob(k, b);
    },
    getBlob: (k) => inner.getBlob(k),
    deleteBlob: (k) => inner.deleteBlob(k),
    putItem: async (i) => {
      onCall(`item:${i.id}`);
      return inner.putItem(i);
    },
    getItem: (id) => inner.getItem(id),
    allItems: () => inner.allItems(),
    itemsForGallery: (g) => inner.itemsForGallery(g),
    deleteItem: (id) => inner.deleteItem(id),
  };
}

test("enqueueUpload menyimpan blob SEBELUM item", async () => {
  const order: string[] = [];
  const inner = new MemoryUploadStore();
  const spy = spyStore(inner, (label) => order.push(label));

  const item = await enqueueUpload(spy, photo(), { id: "up-1", now: new Date("2026-01-01T00:00:00Z") });

  assert.deepEqual(order, ["blob:blob:up-1", "blob:thumb:up-1", "item:up-1"]);
  assert.equal(item.state, "queued");
  assert.equal(item.id, "up-1");
  assert.equal(item.bytes, 4); // panjang "asli"
  assert.equal(item.attempts, 0);
  assert.equal(item.nextAttemptAt, null);
  assert.equal(item.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(await inner.getBlob(item.blobKey) !== null, true);
  assert.equal(await inner.getBlob(item.thumbBlobKey) !== null, true);
});

test("enqueueUpload tanpa thumb tidak menulis blob thumb", async () => {
  const store = new MemoryUploadStore();
  const item = await enqueueUpload(store, photo({ thumb: null }), { id: "up-2" });
  assert.equal(await store.getBlob(item.thumbBlobKey), null);
  assert.notEqual(await store.getBlob(item.blobKey), null);
});

test("enqueueUpload meneruskan error putBlob ke pemanggil (tidak ada item setengah jadi)", async () => {
  const store = new MemoryUploadStore();
  const failing: UploadStore = {
    ...spyStore(store, () => {}),
    putBlob: async () => {
      throw new Error("kuota penuh");
    },
  };

  await assert.rejects(() => enqueueUpload(failing, photo(), { id: "up-3" }), /kuota penuh/);
  assert.deepEqual(await store.allItems(), []);
});

test("discardUpload membuang item dan kedua blob-nya", async () => {
  const store = new MemoryUploadStore();
  const item = await enqueueUpload(store, photo(), { id: "up-4" });

  await discardUpload(store, "up-4");

  assert.deepEqual(await store.allItems(), []);
  assert.equal(await store.getBlob(item.blobKey), null);
  assert.equal(await store.getBlob(item.thumbBlobKey), null);
});

test("itemsForGallery memisahkan item antar galeri", async () => {
  const store = new MemoryUploadStore();
  await enqueueUpload(store, photo({ galleryId: "gal-A" }), { id: "a1" });
  await enqueueUpload(store, photo({ galleryId: "gal-A" }), { id: "a2" });
  await enqueueUpload(store, photo({ galleryId: "gal-B" }), { id: "b1" });

  const onlyA = await store.itemsForGallery("gal-A");
  assert.deepEqual(onlyA.map((i) => i.id).sort(), ["a1", "a2"]);
});

test("newUploadId menghasilkan id unik berawalan", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newUploadId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^up_/);
});

test("UploadItem tersimpan apa adanya — tidak ada field yang hilang saat round-trip", async () => {
  const store = new MemoryUploadStore();
  const item = await enqueueUpload(store, photo(), { id: "up-5" });
  const loaded = await store.getItem("up-5");
  assert.deepEqual<UploadItem | null>(loaded, item);
});
