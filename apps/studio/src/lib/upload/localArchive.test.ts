/**
 * Tes arsip lokal (OPFS).
 *
 * Aturan yang menentukan bentuk tes ini: **arsip lokal tidak pernah jadi
 * syarat upload.** Jadi yang diuji adalah bahwa setiap kegagalan OPFS
 * (tidak tersedia, kuota, browser mode privat) mengembalikan `null`/`[]`,
 * bukan melempar ke alur utama.
 *
 * OPFS dipalsukan dengan `Map` nama→Blob supaya bisa diuji tanpa browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createLocalArchive, LocalArchive, type OpfsDirectory } from "./localArchive.ts";

/** OPFS palsu: folder satu tingkat, berkas disimpan sebagai `folder/nama`. */
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

test("save menulis berkas dengan nama berurutan dan mengembalikan entri", async () => {
  const { root, files } = fakeRoot();
  const archive = new LocalArchive(async () => root, "album-1");

  const entry = await archive.save("p1", 3, new Blob(["isi"]), "image/jpeg");

  assert.deepEqual(entry, { name: "003-p1.jpg", bytes: 3 });
  assert.equal(files.get("album-1/003-p1.jpg")?.size, 3);
});

test("save memakai ekstensi sesuai contentType", async () => {
  const { root, files } = fakeRoot();
  const archive = new LocalArchive(async () => root, "album-1");

  await archive.save("p1", 0, new Blob(["x"]), "image/png");
  await archive.save("p2", 1, new Blob(["x"]), "image/webp");
  await archive.save("p3", 2, new Blob(["x"]), "image/jpeg");

  assert.deepEqual([...files.keys()].sort(), [
    "album-1/000-p1.png",
    "album-1/001-p2.webp",
    "album-1/002-p3.jpg",
  ]);
});

test("save mengembalikan null kalau OPFS tidak tersedia, bukan melempar", async () => {
  const archive = new LocalArchive(async () => {
    throw new Error("OPFS tidak tersedia");
  }, "album-1");

  assert.equal(await archive.save("p1", 0, new Blob(["x"]), "image/jpeg"), null);
});

test("save mengembalikan null kalau penulisan gagal (kuota)", async () => {
  const { root } = fakeRoot();
  const failing: OpfsDirectory = {
    ...root,
    getDirectoryHandle: async () => ({
      getDirectoryHandle: async () => {
        throw new Error("NotFound");
      },
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: async () => {
            throw new Error("QuotaExceeded");
          },
          close: async () => {},
        }),
        getFile: async () => new File([], "x"),
      }),
      removeEntry: async () => {},
    }),
  };
  const archive = new LocalArchive(async () => failing, "album-1");

  assert.equal(await archive.save("p1", 0, new Blob(["x"]), "image/jpeg"), null);
});

test("list mengembalikan nama berkas terurut, dan kosong kalau gagal", async () => {
  const withEntries: OpfsDirectory = {
    getDirectoryHandle: async () => ({
      getDirectoryHandle: async () => {
        throw new Error("NotFound");
      },
      getFileHandle: async () => {
        throw new Error("NotFound");
      },
      removeEntry: async () => {},
      async *entries() {
        yield ["002-p3.jpg", null] as [string, unknown];
        yield ["000-p1.jpg", null] as [string, unknown];
      },
    }),
    getFileHandle: async () => {
      throw new Error("NotFound");
    },
    removeEntry: async () => {},
  };

  const archive = new LocalArchive(async () => withEntries, "album-1");
  assert.deepEqual(await archive.list(), ["000-p1.jpg", "002-p3.jpg"]);

  const broken = new LocalArchive(async () => {
    throw new Error("OPFS tidak tersedia");
  }, "album-1");
  assert.deepEqual(await broken.list(), []);
});

test("clear tidak melempar saat folder belum ada", async () => {
  const archive = new LocalArchive(async () => {
    throw new Error("tidak ada");
  }, "album-1");

  await assert.doesNotReject(() => archive.clear());
});

test("createLocalArchive mengembalikan arsip yang save-nya aman tanpa OPFS", async () => {
  // Di Node tidak ada navigator.storage.getDirectory → jalur fallback.
  const archive = createLocalArchive("album-1");
  assert.equal(await archive.save("p1", 0, new Blob(["x"]), "image/jpeg"), null);
  assert.deepEqual(await archive.list(), []);
});
