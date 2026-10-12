/**
 * Tes pemuat pratinjau.
 *
 * Yang penting di sini bukan "kelihatan benar", tapi angka: sesi mana yang
 * dipilih, berapa frame, dan apakah object URL benar-benar dilepas. Object URL
 * yang bocor di kiosk yang jalan 8 jam itu nyata — memori naik terus.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryFrameStore, type StoredFrame } from "../capture/frameStore.ts";
import { loadLatestSessionFrames, type DecodableImage } from "./previewFrames.ts";

function frame(overrides: Partial<StoredFrame> & { id: string; sessionId: string }): StoredFrame {
  return {
    shotIndex: 0,
    blob: new Blob([overrides.id], { type: "image/jpeg" }),
    width: 640,
    height: 480,
    source: "webcam",
    strategy: "canvas",
    capturedAt: 1_000,
    ...overrides,
  };
}

/** Dek yang mencatat URL yang dibuat/dilepas, plus gambar palsu yang bisa gagal. */
function makeDeps(options: { failIndexes?: number[] } = {}) {
  const created: string[] = [];
  const revoked: string[] = [];
  const failIndexes = new Set(options.failIndexes ?? []);
  let imageCount = 0;

  const deps = {
    createUrl(blob: Blob): string {
      const url = `blob:fake/${created.length + 1}-${blob.size}`;
      created.push(url);
      return url;
    },
    revokeUrl(url: string): void {
      revoked.push(url);
    },
    createImage(): DecodableImage {
      imageCount += 1;
      const index = imageCount - 1;
      return {
        src: "",
        naturalWidth: 800,
        naturalHeight: 600,
        async decode(): Promise<void> {
          if (failIndexes.has(index)) throw new Error("gambar rusak");
        },
      };
    },
  };

  return { deps, created, revoked };
}

test("memilih sesi terakhir, bukan sesi pertama", async () => {
  const store = new MemoryFrameStore();
  await store.put(frame({ id: "a", sessionId: "lama", capturedAt: 1_000 }));
  await store.put(frame({ id: "b", sessionId: "baru", capturedAt: 5_000 }));

  const { deps } = makeDeps();
  const loaded = await loadLatestSessionFrames(store, deps);

  assert.equal(loaded.sessionId, "baru");
  assert.equal(loaded.count, 1);
  assert.equal(loaded.frames.length, 1);
});

test("frame diurutkan menurut shotIndex, bukan urutan simpan", async () => {
  const store = new MemoryFrameStore();
  await store.put(frame({ id: "slot2", sessionId: "s", shotIndex: 2, capturedAt: 3_000 }));
  await store.put(frame({ id: "slot0", sessionId: "s", shotIndex: 0, capturedAt: 1_000 }));
  await store.put(frame({ id: "slot1", sessionId: "s", shotIndex: 1, capturedAt: 2_000 }));

  const { deps } = makeDeps();
  const loaded = await loadLatestSessionFrames(store, deps);

  assert.equal(loaded.frames.length, 3);
  for (const slot of loaded.frames) {
    assert.equal(slot?.width, 800);
    assert.equal(slot?.height, 600);
  }
});

test("penyimpanan kosong tidak melempar dan tidak membuat URL", async () => {
  const store = new MemoryFrameStore();
  const spy = makeDeps();

  const loaded = await loadLatestSessionFrames(store, spy.deps);

  assert.equal(loaded.sessionId, null);
  assert.deepEqual(loaded.frames, []);
  assert.equal(spy.created.length, 0, "tidak ada object URL yang dibuat");
});

test("release melepas semua object URL, sekali saja", async () => {
  const store = new MemoryFrameStore();
  await store.put(frame({ id: "a", sessionId: "s", shotIndex: 0, capturedAt: 1_000 }));
  await store.put(frame({ id: "b", sessionId: "s", shotIndex: 1, capturedAt: 2_000 }));

  const spy = makeDeps();
  const loaded = await loadLatestSessionFrames(store, spy.deps);
  assert.equal(spy.created.length, 2);

  loaded.release();
  assert.deepEqual(spy.revoked, spy.created);

  loaded.release();
  assert.equal(spy.revoked.length, 2, "release kedua tidak melepas ulang");
});

test("satu foto rusak jadi slot kosong, bukan gagal total", async () => {
  const store = new MemoryFrameStore();
  await store.put(frame({ id: "a", sessionId: "s", shotIndex: 0, capturedAt: 1_000 }));
  await store.put(frame({ id: "b", sessionId: "s", shotIndex: 1, capturedAt: 2_000 }));

  const spy = makeDeps({ failIndexes: [0] });
  const loaded = await loadLatestSessionFrames(store, spy.deps);

  assert.equal(loaded.frames.length, 2);
  assert.equal(loaded.frames[0], null, "foto pertama gagal");
  assert.ok(loaded.frames[1] !== null, "foto kedua tetap tampil");
  assert.equal(loaded.count, 2, "yang dihitung tetap frame mentah sesi itu");
});

test("blob asli ikut terbawa, sejajar indeks dengan frames", async () => {
  const store = new MemoryFrameStore();
  await store.put(frame({ id: "a", sessionId: "s", shotIndex: 0, capturedAt: 1_000 }));
  await store.put(frame({ id: "b", sessionId: "s", shotIndex: 1, capturedAt: 2_000 }));

  const spy = makeDeps({ failIndexes: [1] });
  const loaded = await loadLatestSessionFrames(store, spy.deps);

  assert.equal(loaded.blobs.length, loaded.frames.length, "indeks blob sejajar dengan frames");
  assert.ok(loaded.blobs[0] !== null, "slot 0 berhasil → blob ada");
  assert.equal(loaded.blobs[1], null, "slot 1 gagal → blob null, bukan blob yang tidak bisa dipakai");
});

test("penyimpanan kosong juga mengosongkan blobs", async () => {
  const store = new MemoryFrameStore();
  const spy = makeDeps();

  const loaded = await loadLatestSessionFrames(store, spy.deps);
  assert.deepEqual(loaded.blobs, []);
});
