/**
 * Tes runner antrian upload.
 *
 * Yang diuji bukan "bisa upload", tapi janji-janji Fase 5 yang gampang rusak
 * tanpa ketahuan:
 *
 *   · **Tidak terkirim dua kali.** Kalau `uploading` tidak tersimpan sebelum
 *     request, tab yang ditutup di tengah upload akan mengirim ulang foto yang
 *     sudah masuk bucket.
 *   · **Satu foto rusak tidak menahan yang lain.** Kegagalan harus jadi status
 *     item, bukan menghentikan batch.
 *   · **Blob hilang ≠ gagal jaringan.** Item tanpa blob dibuang, bukan diulang
 *     sampai batas percobaan habis.
 *   · **Thumbnail gagal ≠ upload gagal.** Foto besar sudah masuk; menandai
 *     gagal berarti mengirim ulang puluhan MB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { UploadItem } from "@foto-booth/shared";

import { MemoryUploadStore, enqueueUpload, type NewUpload } from "./uploadStore.ts";
import type { UploadClient } from "./uploadClient.ts";
import { runUploadQueue } from "./uploadRunner.ts";

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

/** Client palsu: mencatat panggilan, bisa disuruh gagal per tahap. */
function fakeClient(options: {
  failPut?: boolean;
  failThumb?: boolean;
  failSign?: boolean;
  failRegister?: boolean;
  log?: string[];
} = {}): UploadClient & {
  puts: string[];
  signed: number;
  registered: number;
  registeredBodies: Array<{ photoId: string; key: string; thumbKey: string }>;
} {
  const log = options.log ?? [];
  const client = {
    puts: [] as string[],
    signed: 0,
    registered: 0,
    registeredBodies: [] as Array<{ photoId: string; key: string; thumbKey: string }>,
    async signUpload(galleryId: string, _request: { contentType: string; bytes: number }) {
      log.push(`sign:${galleryId}`);
      client.signed += 1;
      if (options.failSign === true) throw new Error("sign 500");
      return {
        photoId: "remote-1",
        uploadUrl: "https://bucket/asli",
        thumbUploadUrl: "https://bucket/thumb",
        key: `photos/${galleryId}/remote-1.jpg`,
        thumbKey: `thumbs/${galleryId}/remote-1.jpg`,
        expiresAt: "2026-01-01T00:15:00.000Z",
      };
    },
    async putBytes(url: string) {
      log.push(`put:${url}`);
      client.puts.push(url);
      if (options.failPut === true && url.endsWith("/asli")) throw new Error("put 500");
      if (options.failThumb === true && url.endsWith("/thumb")) throw new Error("thumb 500");
    },
    async registerPhoto(galleryId: string, body: { photoId: string; key: string; thumbKey: string }) {
      log.push(`register:${galleryId}`);
      client.registered += 1;
      client.registeredBodies.push({ photoId: body.photoId, key: body.key, thumbKey: body.thumbKey });
      if (options.failRegister === true) throw new Error("register 409");
      return {
        id: body.photoId,
        galleryId,
        key: "k",
        thumbKey: "tk",
        width: 1920,
        height: 1080,
        bytes: 4,
        createdAt: "2026-01-01T00:00:00.000Z",
      } as never;
    },
  };
  return client;
}

const NOW = () => new Date("2026-01-01T00:00:00Z");

test("putaran sukses: sign → 2 PUT → register → uploaded, blob lokal dibuang", async () => {
  const store = new MemoryUploadStore();
  const log: string[] = [];
  const client = fakeClient({ log });
  const item = await enqueueUpload(store, photo(), { id: "up-1", now: NOW() });

  const report = await runUploadQueue({ store, client, now: NOW });

  assert.equal(report.uploaded, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.attempted, 1);
  assert.deepEqual(log, ["sign:gal-1", "put:https://bucket/asli", "put:https://bucket/thumb", "register:gal-1"]);

  const saved = await store.getItem("up-1");
  assert.equal(saved?.state, "uploaded");
  assert.equal(saved?.remotePhotoId, "remote-1");
  assert.equal(saved?.uploadedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(saved?.attempts, 1);

  // Default `deleteLocalAfterUpload` = true: kuota kiosk tidak boleh diisi
  // salinan yang sudah ada di bucket.
  assert.equal(await store.getBlob(item.blobKey), null);
  assert.equal(await store.getBlob(item.thumbBlobKey), null);
});

test("status `uploading` tersimpan SEBELUM request jaringan jalan", async () => {
  const store = new MemoryUploadStore();
  await enqueueUpload(store, photo(), { id: "up-2", now: NOW() });

  const seen: (string | undefined)[] = [];
  const client = fakeClient();
  const originalSign = client.signUpload;
  client.signUpload = async (g, r) => {
    // Saat sign dipanggil, state di penyimpanan harus sudah `uploading`.
    seen.push((await store.getItem("up-2"))?.state);
    return originalSign(g, r);
  };

  await runUploadQueue({ store, client, now: NOW });
  assert.deepEqual(seen, ["uploading"]);
});

test("kegagalan PUT → item kembali queued dengan jadwal backoff, bukan hilang", async () => {
  const store = new MemoryUploadStore();
  const client = fakeClient({ failPut: true });
  await enqueueUpload(store, photo(), { id: "up-3", now: NOW() });

  const report = await runUploadQueue({ store, client, now: NOW });

  assert.equal(report.uploaded, 0);
  assert.equal(report.rescheduled, 1);
  assert.equal(report.failed, 0);

  const saved = await store.getItem("up-3");
  assert.equal(saved?.state, "queued");
  assert.equal(saved?.attempts, 1);
  assert.match(saved?.lastError ?? "", /put 500/);
  assert.ok(saved?.nextAttemptAt !== null && saved.nextAttemptAt !== undefined);
  assert.ok(new Date(saved.nextAttemptAt).getTime() > NOW().getTime());
  // Blob tetap ada — harus bisa dicoba lagi.
  assert.notEqual(await store.getBlob(saved.blobKey), null);
});

test("percobaan habis → failed, dan tidak diambil lagi oleh batch berikutnya", async () => {
  const store = new MemoryUploadStore();
  const client = fakeClient({ failPut: true });
  await enqueueUpload(store, photo(), { id: "up-4", now: NOW() });

  // UPLOAD_MAX_ATTEMPTS = 5. Jadwal backoff dipercepat dengan memajukan `now`.
  let clock = new Date("2026-01-01T00:00:00Z");
  for (let i = 0; i < 5; i += 1) {
    await runUploadQueue({ store, client, now: () => clock });
    clock = new Date(clock.getTime() + 5 * 60_000);
  }

  const saved = await store.getItem("up-4");
  assert.equal(saved?.state, "failed");
  assert.equal(saved?.attempts, 5);
  assert.equal(saved?.nextAttemptAt, null);

  const after = await runUploadQueue({ store, client, now: () => clock });
  assert.equal(after.attempted, 0);
});

test("satu item gagal tidak menghentikan item lain di batch yang sama", async () => {
  const store = new MemoryUploadStore();
  // Item pertama blob-nya dihapus → orphaned; kedua normal.
  const broken = await enqueueUpload(store, photo(), { id: "up-broken", now: NOW() });
  await store.deleteBlob(broken.blobKey);
  await enqueueUpload(store, photo(), { id: "up-ok", now: new Date("2026-01-01T00:00:01Z") });

  const report = await runUploadQueue({ store, client: fakeClient(), now: NOW, concurrency: 2 });

  assert.equal(report.orphaned, 1);
  assert.equal(report.uploaded, 1);
  assert.equal((await store.getItem("up-ok"))?.state, "uploaded");
  // Item tanpa blob dibuang, bukan menunggu selamanya di antrian.
  assert.equal(await store.getItem("up-broken"), null);
});

test("thumbnail gagal tidak menggagalkan upload foto besar", async () => {
  const store = new MemoryUploadStore();
  const client = fakeClient({ failThumb: true });
  await enqueueUpload(store, photo(), { id: "up-5", now: NOW() });

  const report = await runUploadQueue({ store, client, now: NOW });

  assert.equal(report.uploaded, 1);
  assert.equal(report.failed, 0);
  assert.equal((await store.getItem("up-5"))?.state, "uploaded");
});

test("thumbnail gagal → yang didaftarkan berkas asli, bukan objek yang tidak ada", async () => {
  // Kalau thumb tidak jadi terkirim tapi `thumbKey` tetap didaftarkan, halaman
  // tamu menunjuk objek yang tidak ada di bucket → API membalas 502 dan
  // gambarnya pecah. Janji yang diuji: yang didaftarkan selalu objek nyata.
  const store = new MemoryUploadStore();
  const client = fakeClient({ failThumb: true });
  await enqueueUpload(store, photo(), { id: "up-5b", now: NOW() });

  await runUploadQueue({ store, client, now: NOW });

  assert.deepEqual(client.registeredBodies, [
    { photoId: "remote-1", key: "photos/gal-1/remote-1.jpg", thumbKey: "photos/gal-1/remote-1.jpg" },
  ]);
});

test("foto tanpa thumbnail sama sekali tetap mendaftarkan objek yang ada", async () => {
  const store = new MemoryUploadStore();
  const client = fakeClient();
  await enqueueUpload(store, photo({ thumb: null }), { id: "up-5c", now: NOW() });

  await runUploadQueue({ store, client, now: NOW });

  assert.deepEqual(client.puts, ["https://bucket/asli"]);
  assert.equal(client.registeredBodies[0]?.thumbKey, "photos/gal-1/remote-1.jpg");
});

test("thumbnail terkirim → thumbKey sungguhan yang didaftarkan", async () => {
  const store = new MemoryUploadStore();
  const client = fakeClient();
  await enqueueUpload(store, photo(), { id: "up-5d", now: NOW() });

  await runUploadQueue({ store, client, now: NOW });

  assert.equal(client.registeredBodies[0]?.thumbKey, "thumbs/gal-1/remote-1.jpg");
});

test("kegagalan register tidak menghapus blob lokal (foto masih bisa diselamatkan)", async () => {
  const store = new MemoryUploadStore();
  const client = fakeClient({ failRegister: true });
  const item = await enqueueUpload(store, photo(), { id: "up-6", now: NOW() });

  const report = await runUploadQueue({ store, client, now: NOW });

  assert.equal(report.rescheduled, 1);
  assert.notEqual(await store.getBlob(item.blobKey), null);
  assert.equal((await store.getItem("up-6"))?.state, "queued");
});

test("item `uploading` yang tertinggal (tab ditutup) dipulihkan dan tetap terkirim", async () => {
  const store = new MemoryUploadStore();
  const item = await enqueueUpload(store, photo(), { id: "up-7", now: NOW() });
  // Simulasi: tab mati setelah status `uploading` tersimpan, sebelum selesai.
  await store.putItem({ ...item, state: "uploading", attempts: 1 });

  const client = fakeClient();
  const report = await runUploadQueue({ store, client, now: NOW });

  assert.equal(report.uploaded, 1);
  assert.equal(client.registered, 1);
  assert.equal((await store.getItem("up-7"))?.state, "uploaded");
});

test("deleteLocalAfterUpload=false menyimpan blob untuk cetak ulang", async () => {
  const store = new MemoryUploadStore();
  const item = await enqueueUpload(store, photo(), { id: "up-8", now: NOW() });

  await runUploadQueue({ store, client: fakeClient(), now: NOW, deleteLocalAfterUpload: false });

  assert.notEqual(await store.getBlob(item.blobKey), null);
});

test("antrian kosong → laporan nol, tanpa melempar", async () => {
  const store = new MemoryUploadStore();
  const report = await runUploadQueue({ store, client: fakeClient(), now: NOW });
  assert.deepEqual(report, { attempted: 0, uploaded: 0, failed: 0, orphaned: 0, rescheduled: 0, errors: [] });
});

test("concurrency membatasi jumlah item per putaran", async () => {
  const store = new MemoryUploadStore();
  for (let i = 0; i < 5; i += 1) {
    await enqueueUpload(store, photo(), { id: `up-c${i}`, now: new Date(2026, 0, 1, 0, 0, i) });
  }

  const report = await runUploadQueue({ store, client: fakeClient(), now: NOW, concurrency: 2 });
  assert.equal(report.attempted, 2);
  assert.equal(report.uploaded, 2);
});

test("kegagalan jaringan jadi status item, bukan error laporan", async () => {
  const store = new MemoryUploadStore();
  const client = fakeClient({ failPut: true });
  await enqueueUpload(store, photo(), { id: "up-9", now: NOW() });

  const report = await runUploadQueue({ store, client, now: NOW });
  assert.equal(report.errors.length, 0);
  assert.equal(report.rescheduled, 1);
});

test("penyimpanan yang gagal menulis item tercatat sebagai error, tidak menjatuhkan putaran", async () => {
  const store = new MemoryUploadStore();
  await enqueueUpload(store, photo(), { id: "up-10", now: NOW() });

  const flaky = {
    putItem: async (item: UploadItem) => {
      if (item.state === "uploading") throw new Error("indexeddb penuh");
      return store.putItem(item);
    },
    getItem: (id: string) => store.getItem(id),
    allItems: () => store.allItems(),
    itemsForGallery: (g: string) => store.itemsForGallery(g),
    deleteItem: (id: string) => store.deleteItem(id),
    putBlob: (k: string, b: Blob) => store.putBlob(k, b),
    getBlob: (k: string) => store.getBlob(k),
    deleteBlob: (k: string) => store.deleteBlob(k),
  };

  const report = await runUploadQueue({ store: flaky, client: fakeClient(), now: NOW });
  assert.equal(report.uploaded, 0);
  assert.equal(report.rescheduled, 1);
  assert.equal(report.errors.length, 1);
  const first = report.errors[0]!;
  assert.equal(first.id, "up-10");
  assert.match(first.error, /indexeddb penuh/);
});
