import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseArchiveBackend,
  describeArchiveBackend,
  isAbortError,
  pickArchiveTarget,
  safeArchiveName,
  writeArchiveFile,
  type DirHandleLike,
} from "./directoryPicker.ts";

/** Direktori palsu in-memory yang bisa disuruh gagal. */
function fakeDirectory(options: { failWrite?: boolean; entries?: string[] } = {}): DirHandleLike & {
  files: Map<string, unknown>;
} {
  const files = new Map<string, unknown>();
  for (const name of options.entries ?? []) files.set(name, "x");

  return {
    name: "palsu",
    files,
    async getFileHandle(name: string) {
      return {
        async createWritable() {
          if (options.failWrite === true) throw new Error("kuota penuh");
          return {
            async write(data: unknown) {
              files.set(name, data);
            },
            async close() {},
          };
        },
      };
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
    async *values() {
      for (const name of files.keys()) yield { kind: "file", name };
    },
  };
}

test("safeArchiveName menolak nama yang bisa keluar folder", () => {
  assert.equal(safeArchiveName("foto-001.jpg"), "foto-001.jpg");
  for (const bad of ["../evil", "a/b.jpg", "a\\b.jpg", "", "..", "nul\0x"]) {
    assert.equal(safeArchiveName(bad), null, `harus ditolak: ${JSON.stringify(bad)}`);
  }
});

test("isAbortError hanya mengenali AbortError", () => {
  assert.equal(isAbortError({ name: "AbortError" }), true);
  assert.equal(isAbortError(new Error("lain")), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError("AbortError"), false);
});

test("chooseArchiveBackend memprioritaskan folder pilihan", () => {
  assert.equal(chooseArchiveBackend({ showDirectoryPicker: async () => fakeDirectory() }), "fs-access");
  assert.equal(
    chooseArchiveBackend({
      showDirectoryPicker: async () => fakeDirectory(),
      storage: { getDirectory: async () => fakeDirectory() },
    }),
    "fs-access",
  );
  assert.equal(chooseArchiveBackend({ storage: { getDirectory: async () => fakeDirectory() } }), "opfs");
  assert.equal(chooseArchiveBackend({}), "none");
});

test("describeArchiveBackend memberi label yang bisa dibaca", () => {
  assert.equal(describeArchiveBackend("fs-access"), "Folder pilihan");
  assert.equal(describeArchiveBackend("opfs"), "Arsip aplikasi (OPFS)");
  assert.equal(describeArchiveBackend("none"), "Tidak ada arsip lokal");
});

test("writeArchiveFile menulis berkas & menolak nama tidak aman", async () => {
  const dir = fakeDirectory();
  assert.equal(await writeArchiveFile(dir, "foto-1.jpg", new Blob(["a"])), true);
  assert.equal(dir.files.has("foto-1.jpg"), true);
  assert.equal(await writeArchiveFile(dir, "../evil", new Blob(["a"])), false);
});

test("writeArchiveFile: kegagalan tulis → false, tidak melempar", async () => {
  const dir = fakeDirectory({ failWrite: true });
  assert.equal(await writeArchiveFile(dir, "foto.jpg", new Blob(["a"])), false);
});

test("pickArchiveTarget memakai picker & menulis ke folder itu", async () => {
  const dir = fakeDirectory();
  const t = await pickArchiveTarget({ showDirectoryPicker: async () => dir });
  assert.ok(t !== null);
  assert.equal(t.backend, "fs-access");
  assert.equal(t.label, "Folder pilihan");
  assert.equal(await t.save("a.jpg", new Uint8Array([1, 2, 3])), true);
  assert.equal(dir.files.has("a.jpg"), true);
});

test("operator membatalkan dialog (AbortError) → null, tidak jatuh ke OPFS", async () => {
  let opfsUsed = false;
  const t = await pickArchiveTarget({
    showDirectoryPicker: async () => {
      const err = new Error("dibatalkan");
      err.name = "AbortError";
      throw err;
    },
    storage: {
      getDirectory: async () => {
        opfsUsed = true;
        return fakeDirectory();
      },
    },
  });
  assert.equal(t, null);
  assert.equal(opfsUsed, false, "pembatalan bukan alasan diam-diam pakai OPFS");
});

test("izin ditolak (non-abort) → fallback OPFS", async () => {
  const dir = fakeDirectory();
  const t = await pickArchiveTarget({
    showDirectoryPicker: async () => {
      throw new Error("SecurityError");
    },
    storage: { getDirectory: async () => dir },
  });
  assert.ok(t !== null);
  assert.equal(t.backend, "opfs");
  assert.equal(await t.save("b.jpg", new Blob(["x"])), true);
});

test("tanpa API apa pun → null", async () => {
  assert.equal(await pickArchiveTarget({}), null);
});

test("OPFS gagal dibuka → null, tidak melempar", async () => {
  const t = await pickArchiveTarget({
    storage: {
      getDirectory: async () => {
        throw new Error("tidak didukung");
      },
    },
  });
  assert.equal(t, null);
});

test("list mengembalikan nama berkas di folder", async () => {
  const dir = fakeDirectory({ entries: ["b.jpg", "a.jpg"] });
  const t = await pickArchiveTarget({ showDirectoryPicker: async () => dir });
  assert.ok(t !== null);
  assert.deepEqual(await t.list(), ["a.jpg", "b.jpg"]);
});
