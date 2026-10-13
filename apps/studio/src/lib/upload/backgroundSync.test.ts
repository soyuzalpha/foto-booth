/**
 * Tes Background Sync.
 *
 * Fitur ini **tidak** boleh jadi syarat apa pun: di Safari/Firefox API-nya
 * tidak ada, dan di Chromium pun gagal kalau tidak ada tab yang hidup. Yang
 * diuji di sini adalah bahwa setiap ketiadaan/gagal itu dilaporkan sebagai
 * status — bukan lemparan yang menjatuhkan hook pemanggil.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  registerUploadSync,
  UPLOAD_SYNC_TAG,
  type SyncCapableRegistration,
} from "./backgroundSync.ts";

test("registrasi null → supported:false, bukan lemparan", async () => {
  const result = await registerUploadSync(null);
  assert.deepEqual(result, { supported: false, registered: false, reason: "service worker belum siap" });
});

test("registrasi tanpa .sync → supported:false (Safari/Firefox)", async () => {
  const result = await registerUploadSync({} as SyncCapableRegistration);
  assert.equal(result.supported, false);
  assert.equal(result.registered, false);
  assert.match(result.reason ?? "", /tidak didukung/i);
});

test("registrasi sukses mendaftarkan tag yang benar", async () => {
  const tags: string[] = [];
  const result = await registerUploadSync({
    sync: {
      async register(tag: string) {
        tags.push(tag);
      },
    },
  });

  assert.deepEqual(tags, [UPLOAD_SYNC_TAG]);
  assert.deepEqual(result, { supported: true, registered: true, reason: null });
});

test("register yang melempar → dilaporkan sebagai status, tidak dilempar ulang", async () => {
  const result = await registerUploadSync({
    sync: {
      async register() {
        throw new Error("no permission");
      },
    },
  });

  assert.equal(result.supported, true);
  assert.equal(result.registered, false);
  assert.equal(result.reason, "no permission");
});

test("tag sync sesuai dengan yang didengarkan service worker", () => {
  // Nilai ini harus sama dengan literal di `public/sync-sw.js`; kalau salah,
  // SW membangunkan halaman untuk tag yang tidak pernah dikenali.
  assert.equal(UPLOAD_SYNC_TAG, "foto-booth-upload");
});
