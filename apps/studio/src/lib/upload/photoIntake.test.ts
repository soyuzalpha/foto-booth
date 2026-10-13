/**
 * Tes jalur masuk foto: **arsip lokal dulu, lalu antrian upload.**
 *
 * Aturan Fase 5 yang bertemu kenyataan kiosk:
 *
 *   1. **Arsip lokal tidak pernah jadi syarat.** OPFS bisa tidak ada atau
 *      kehabisan kuota; foto tetap harus masuk antrian dan tetap sampai tamu.
 *   2. **Urutan arsip-dulu penting justru karena itu.** Kalau antrian ditulis
 *      lebih dulu dan blob-nya gagal, tidak ada apa pun yang tersisa.
 *   3. **Kegagalan antrian dilaporkan.** Kalau `enqueue` melempar, pemanggil
 *      harus tahu — kalau tidak, UI menulis "tersimpan" untuk foto yang tidak
 *      akan pernah terkirim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { LocalArchive, type ArchiveEntry, type OpfsDirectory } from "./localArchive.ts";
import { intakePhoto, summarizeIntake, type IntakePhoto, type IntakeResult } from "./photoIntake.ts";
import { MemoryUploadStore, type UploadStore } from "./uploadStore.ts";

const NOW = new Date("2026-01-01T00:00:00Z");

/** OPFS palsu: berkas disimpan sebagai `folder/nama`. */
function fakeRoot(): { root: OpfsDirectory; files: Map<string, Blob> } {
  const files = new Map<string, Blob>();
  const dirs = new Set<string>();

  function makeDir(folder: string): OpfsDirectory {
    return {
      async getDirectoryHandle(name, options) {
        if (!dirs.has(name)) {
          if (options?.create !== true) throw new Error("NotFound");
          dirs.add(name);
        }
        return makeDir(name);
      },
      async getFileHandle(name, options) {
        const key = `${folder}/${name}`;
        if (!files.has(key) && options?.create !== true) throw new Error("NotFound");
        return {
          async createWritable() {
            return {
              async write(data) {
                files.set(key, data as Blob);
              },
              async close() {},
            };
          },
          async getFile() {
            return new File([files.get(key) ?? new Blob()], name);
          },
        };
      },
      async removeEntry(name) {
        for (const key of [...files.keys()]) {
          if (key.startsWith(`${folder}/${name}/`)) files.delete(key);
        }
        dirs.delete(name);
      },
    };
  }

  return { root: makeDir(""), files };
}

/** Arsip yang meledak — membuktikan kontrak "tidak pernah menyeret antrian". */
class ExplodingArchive extends LocalArchive {
  override async save(): Promise<ArchiveEntry | null> {
    throw new Error("arsip meledak");
  }
}

function photo(overrides: Partial<IntakePhoto> = {}): IntakePhoto {
  return {
    blob: new Blob(["foto-asli"], { type: "image/jpeg" }),
    thumb: new Blob(["thumb"], { type: "image/jpeg" }),
    contentType: "image/jpeg",
    width: 4000,
    height: 3000,
    filename: "01.jpg",
    index: 0,
    ...overrides,
  };
}

/** Store yang mencatat urutan pemanggilan, mendelegasikan ke store memori. */
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

test("arsip lokal ditulis SEBELUM antrian upload", async () => {
  const order: string[] = [];
  const inner = new MemoryUploadStore();
  const { root } = fakeRoot();
  const archive = new LocalArchive(async () => {
    order.push("arsip");
    return root;
  }, "album-1");

  const result = await intakePhoto(
    { store: spyStore(inner, (label) => order.push(label)), archive, galleryId: "gal-1", now: () => NOW },
    photo(),
  );

  assert.equal(order[0], "arsip");
  assert.ok(order.some((label) => label.startsWith("blob:blob:up_")));
  assert.equal(result.queueError, null);
  assert.equal(result.item?.state, "queued");
  assert.equal(result.archived?.name, "000-local-0.jpg");
});

test("arsip gagal (meledak) tidak menghalangi foto masuk antrian", async () => {
  const store = new MemoryUploadStore();
  const result = await intakePhoto(
    { store, archive: new ExplodingArchive(async () => fakeRoot().root, "album-1"), galleryId: "gal-1" },
    photo(),
  );

  assert.equal(result.archived, null);
  assert.notEqual(result.item, null);
  assert.equal(result.queueError, null);
  assert.equal((await store.allItems()).length, 1);
});

test("tanpa OPFS (archive null) foto tetap masuk antrian", async () => {
  const store = new MemoryUploadStore();
  const result = await intakePhoto({ store, archive: null, galleryId: "gal-1" }, photo());

  assert.equal(result.archived, null);
  assert.notEqual(result.item, null);
  assert.equal(result.queueError, null);
});

test("kegagalan antrian dilaporkan dan arsipnya tetap ada", async () => {
  const store = new MemoryUploadStore();
  const failing: UploadStore = {
    ...spyStore(store, () => {}),
    putBlob: async () => {
      throw new Error("kuota penuh");
    },
  };
  const { root } = fakeRoot();

  const result = await intakePhoto(
    { store: failing, archive: new LocalArchive(async () => root, "album-1"), galleryId: "gal-1" },
    photo(),
  );

  assert.equal(result.item, null);
  assert.equal(result.queueError, "kuota penuh");
  // Inilah alasan arsip ditulis lebih dulu: masih ada salinan di disk.
  assert.equal(result.archived?.name, "000-local-0.jpg");
});

test("intakePhoto tidak pernah melempar, apa pun yang gagal", async () => {
  const failing: UploadStore = {
    ...spyStore(new MemoryUploadStore(), () => {}),
    putBlob: async () => {
      throw new Error("gagal");
    },
  };

  await assert.doesNotReject(() =>
    intakePhoto(
      { store: failing, archive: new ExplodingArchive(async () => fakeRoot().root, "album-1"), galleryId: "gal-1" },
      photo(),
    ),
  );
});

test("foto masuk ke galeri yang diminta, lengkap dengan metadatanya", async () => {
  const store = new MemoryUploadStore();
  const result = await intakePhoto(
    { store, archive: null, galleryId: "gal-7" },
    photo({ width: 6000, height: 4000, filename: "03.jpg", index: 2 }),
  );

  assert.equal(result.item?.galleryId, "gal-7");
  assert.equal(result.item?.width, 6000);
  assert.equal(result.item?.filename, "03.jpg");
  assert.equal(result.item?.bytes, 9); // "foto-asli"
});

/* ------------------------------------------------------------------ *
 * Ringkasan
 * ------------------------------------------------------------------ */

function result(overrides: Partial<IntakeResult> = {}): IntakeResult {
  return { item: null, archived: null, queueError: null, ...overrides };
}

test("summarizeIntake menghitung antrian, arsip, dan kegagalan secara terpisah", () => {
  const summary = summarizeIntake([
    result({ item: {} as never, archived: { name: "a.jpg", bytes: 1 } }),
    result({ item: {} as never, queueError: "kuota penuh" }),
    result({ archived: { name: "c.jpg", bytes: 1 } }),
    result({ queueError: "jaringan putus" }),
  ]);

  assert.deepEqual(summary, { queued: 2, archived: 2, failed: 2, error: "kuota penuh" });
});

test("summarizeIntake memakai pesan gagal pertama, dan null kalau semua aman", () => {
  assert.equal(summarizeIntake([]).error, null);
  assert.equal(summarizeIntake([result({ item: {} as never })]).error, null);
});
