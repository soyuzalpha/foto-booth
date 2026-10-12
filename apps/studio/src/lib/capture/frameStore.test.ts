/**
 * Tes penyimpanan frame.
 *
 * Yang penting di sini bukan "bisa menyimpan", tapi **janji offline-first**-nya:
 * frame harus sudah ada di penyimpanan sebelum sesi selesai, dan tetap bisa
 * dibaca lagi untuk sesi yang sama setelah refresh — tanpa tercampur frame
 * sesi lain.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MemoryFrameStore,
  createFrameStore,
  type StoredFrame,
} from "./frameStore.ts";

function frame(overrides: Partial<StoredFrame> & { id: string }): StoredFrame {
  return {
    sessionId: "sesi-1",
    shotIndex: 0,
    blob: new Blob(["x"], { type: "image/jpeg" }),
    width: 1920,
    height: 1080,
    source: "capture-card",
    strategy: "canvas",
    capturedAt: 0,
    ...overrides,
  };
}

test("put lalu get mengembalikan frame yang sama", async () => {
  const store = new MemoryFrameStore();
  const saved = frame({ id: "f1", shotIndex: 2 });

  await store.put(saved);

  const loaded = await store.get("f1");
  assert.equal(loaded?.id, "f1");
  assert.equal(loaded?.shotIndex, 2);
  assert.equal(loaded?.source, "capture-card");
  assert.equal(loaded?.blob.size, 1, "blob disimpan apa adanya, bukan base64");
});

test("get untuk id yang tidak ada → null, bukan melempar", async () => {
  const store = new MemoryFrameStore();

  assert.equal(await store.get("tidak-ada"), null);
});

test("all() mengembalikan frame urut waktu jepret, bukan urut penyimpanan", async () => {
  const store = new MemoryFrameStore();

  // Sengaja disimpan tidak berurutan — urutan simpan tidak boleh menentukan.
  await store.put(frame({ id: "c", shotIndex: 2, capturedAt: 3000 }));
  await store.put(frame({ id: "a", shotIndex: 0, capturedAt: 1000 }));
  await store.put(frame({ id: "b", shotIndex: 1, capturedAt: 2000 }));

  const all = await store.all();

  assert.deepEqual(all.map((entry) => entry.id), ["a", "b", "c"]);
});

test("all(sessionId) menyaring per sesi — sesi lama tidak bocor ke sesi baru", async () => {
  const store = new MemoryFrameStore();

  await store.put(frame({ id: "lama-1", sessionId: "sesi-lama", capturedAt: 1000 }));
  await store.put(frame({ id: "baru-1", sessionId: "sesi-baru", capturedAt: 2000 }));
  await store.put(frame({ id: "lama-2", sessionId: "sesi-lama", capturedAt: 1500 }));

  const sesiBaru = await store.all("sesi-baru");

  assert.deepEqual(sesiBaru.map((entry) => entry.id), ["baru-1"]);
  assert.equal((await store.all("sesi-lama")).length, 2);
  assert.equal((await store.all()).length, 3, "tanpa filter → semua");
});

test("put ulang dengan id sama menimpa, bukan menduplikasi", async () => {
  const store = new MemoryFrameStore();

  await store.put(frame({ id: "f1", width: 1280 }));
  await store.put(frame({ id: "f1", width: 1920 }));

  assert.equal(store.size, 1);
  assert.equal((await store.get("f1"))?.width, 1920);
});

test("remove dan clear", async () => {
  const store = new MemoryFrameStore();
  await store.put(frame({ id: "a" }));
  await store.put(frame({ id: "b" }));

  await store.remove("a");
  assert.equal(await store.get("a"), null);
  assert.equal(store.size, 1);

  await store.clear();
  assert.equal(store.size, 0);
});

test("createFrameStore memakai memori kalau IndexedDB tidak ada", () => {
  // Mode privat Safari lama / iframe terkunci. Fitur tidak boleh dimatikan —
  // UI hanya perlu tahu supaya bisa memperingatkan soal refresh.
  const { store, kind } = createFrameStore({});

  assert.equal(kind, "memory");
  assert.ok(store instanceof MemoryFrameStore);
});

test("createFrameStore memilih IndexedDB kalau tersedia", () => {
  const { store, kind } = createFrameStore({ indexedDB: {} as IDBFactory });

  assert.equal(kind, "indexeddb");
  assert.equal(store instanceof MemoryFrameStore, false);
});
