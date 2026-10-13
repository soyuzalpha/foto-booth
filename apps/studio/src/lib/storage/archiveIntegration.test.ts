/**
 * Integrasi folder arsip: **pilihan operator benar-benar dipakai menulis.**
 *
 * `directoryPicker.test.ts` menguji picker-nya sendiri; `localArchive` menguji
 * penulisan OPFS. Yang belum terjaga adalah sambungan antar keduanya — dan itu
 * justru bagian yang paling gampang salah: picker mengembalikan handle, tapi
 * kalau `asArchiveRoot` salah menyambung, arsip tetap "sukses" menulis ke OPFS
 * sementara operator mengira fotonya ada di folder yang ia pilih.
 *
 * Karena itu tes di sini memakai **folder pilihan sebagai akar** lalu memeriksa
 * berkasnya benar-benar mendarat di subfolder album di dalam folder itu —
 * bukan di akar lain.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { asArchiveRoot, pickArchiveTarget, type DirHandleLike } from "./directoryPicker.ts";
import { createLocalArchive } from "../upload/localArchive.ts";

/** Pohon direktori palsu: `nama → isi`. Cukup untuk satu tingkat album. */
function fakeTree(): { root: DirHandleLike; tree: Map<string, Map<string, Blob>> } {
  const tree = new Map<string, Map<string, Blob>>();

  const dir = (name: string): DirHandleLike => ({
    name,
    async getDirectoryHandle(child: string, options?: { create?: boolean }) {
      const existing = tree.get(child);
      if (existing !== undefined) return dir(child);
      if (options?.create !== true) throw new Error("tidak ada");
      tree.set(child, new Map());
      return dir(child);
    },
    async getFileHandle(file: string) {
      const bucket = tree.get(name);
      if (bucket === undefined) throw new Error("tidak ada");
      return {
        async createWritable() {
          return {
            async write(data: unknown) {
              bucket.set(file, data as Blob);
            },
            async close() {},
          };
        },
      };
    },
    async removeEntry(child: string) {
      tree.delete(child);
    },
  });

  return { root: dir(""), tree };
}

test("pilih folder → arsip ditulis ke folder itu, di subfolder album", async () => {
  const { root, tree } = fakeTree();
  const target = await pickArchiveTarget({ showDirectoryPicker: async () => root });
  assert.ok(target !== null);
  assert.equal(target.backend, "fs-access");

  const archive = createLocalArchive("album-hash", asArchiveRoot(target.handle));
  const entry = await archive.save("p1", 1, new Blob(["foto"]), "image/jpeg");

  assert.deepEqual(entry, { name: "001-p1.jpg", bytes: 4 });
  assert.equal(tree.has("album-hash"), true, "album harus jadi subfolder di folder pilihan");
  assert.equal(tree.get("album-hash")?.get("001-p1.jpg") !== undefined, true);
});

test("tanpa API arsip → pickArchiveTarget null, dan arsip tetap aman dipanggil", async () => {
  assert.equal(await pickArchiveTarget({}), null);

  // Tanpa root yang disuntik, `LocalArchive` jatuh ke OPFS — yang di Node juga
  // tidak ada. Kontraknya: `save` mengembalikan `null`, bukan melempar.
  const archive = createLocalArchive("album-hash");
  assert.equal(await archive.save("p1", 1, new Blob(["foto"]), "image/jpeg"), null);
  assert.deepEqual(await archive.list(), []);
});

test("tulis arsip gagal → null, upload tidak ikut gagal", async () => {
  const broken: DirHandleLike = {
    name: "rusak",
    async getDirectoryHandle() {
      throw new Error("izin dicabut");
    },
    async getFileHandle() {
      throw new Error("izin dicabut");
    },
  };

  const archive = createLocalArchive("album-hash", asArchiveRoot(broken));
  assert.equal(await archive.save("p1", 1, new Blob(["foto"]), "image/jpeg"), null);
});
