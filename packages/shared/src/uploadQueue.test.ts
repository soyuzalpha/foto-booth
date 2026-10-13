/**
 * Tes mesin antrian upload.
 *
 * Fokusnya satu hal: **"tutup tab saat offline → buka lagi → antrian masih ada
 * dan jalan sendiri"**. Itu perilaku, bukan tampilan — jadi diuji sebagai
 * deret transisi, tanpa browser dan tanpa IndexedDB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { UPLOAD_MAX_ATTEMPTS } from "./constants.ts";
import {
  backoffMs,
  countByState,
  hasWork,
  isReady,
  nextBatch,
  reduceUpload,
  type UploadItem,
} from "./uploadQueue.ts";

const T0 = new Date("2026-10-12T00:00:00.000Z");

function item(overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    id: "p1",
    galleryId: "g1",
    blobKey: "blob:p1",
    thumbBlobKey: "blob:p1:t",
    filename: "p1.jpg",
    contentType: "image/jpeg",
    bytes: 1024,
    width: 1200,
    height: 1800,
    state: "local-only",
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    remotePhotoId: null,
    createdAt: T0.toISOString(),
    uploadedAt: null,
    ...overrides,
  };
}

test("foto baru = local-only, belum ikut antrian", () => {
  const it = item();
  assert.equal(it.state, "local-only");
  assert.equal(isReady(it, T0), false, "local-only tidak pernah dikerjakan auto-sync");
});

test("enqueue → queued, langsung siap", () => {
  const it = reduceUpload(item(), { type: "enqueue" });
  assert.equal(it.state, "queued");
  assert.equal(it.nextAttemptAt, null);
  assert.equal(isReady(it, T0), true);
});

test("start menaikkan attempts dan mengunci state", () => {
  let it = reduceUpload(item(), { type: "enqueue" });
  it = reduceUpload(it, { type: "start" });
  assert.equal(it.state, "uploading");
  assert.equal(it.attempts, 1);
  assert.equal(isReady(it, T0), false, "yang sedang uploading tidak dikerjakan dua kali");
});

test("start pada item uploaded tidak mengubah apa pun", () => {
  const uploaded = item({ state: "uploaded", attempts: 1, remotePhotoId: "r1" });
  assert.deepEqual(reduceUpload(uploaded, { type: "start" }), uploaded);
});

test("success → uploaded + remotePhotoId + uploadedAt, dan tidak pernah mundur", () => {
  let it = reduceUpload(item(), { type: "enqueue" });
  it = reduceUpload(it, { type: "start" });
  it = reduceUpload(it, { type: "success", remotePhotoId: "r1", at: T0 });

  assert.equal(it.state, "uploaded");
  assert.equal(it.remotePhotoId, "r1");
  assert.equal(it.uploadedAt, T0.toISOString());
  assert.equal(it.nextAttemptAt, null);

  // Enqueue lagi tidak boleh membangkitkan foto yang sudah terkirim.
  assert.equal(reduceUpload(it, { type: "enqueue" }).state, "uploaded");
});

test("failure → balik ke queued dengan jadwal backoff, bukan mati", () => {
  let it = reduceUpload(item(), { type: "enqueue" });
  it = reduceUpload(it, { type: "start" });
  it = reduceUpload(it, { type: "failure", error: "network down", at: T0 });

  assert.equal(it.state, "queued");
  assert.equal(it.lastError, "network down");
  assert.ok(it.nextAttemptAt !== null);

  const wait = new Date(it.nextAttemptAt!).getTime() - T0.getTime();
  assert.ok(wait >= 800 && wait <= 1200, `percobaan pertama ≈1 s, dapat ${wait} ms`);

  // Belum waktunya → belum siap; setelah waktunya → siap lagi.
  assert.equal(isReady(it, T0), false);
  assert.equal(isReady(it, new Date(T0.getTime() + 5000)), true);
});

test("backoff naik 1→2→4→8→16 s (dengan jitter ±20%)", () => {
  const id = "abc";
  const nominal = [1000, 2000, 4000, 8000, 16000];
  for (const [index, want] of nominal.entries()) {
    const attempt = index + 1;
    const ms = backoffMs(attempt, id);
    assert.ok(
      ms >= want * 0.8 - 1 && ms <= want * 1.2 + 1,
      `attempt ${attempt}: ${ms} ms harus di sekitar ${want} ms`,
    );
  }
});

test("backoff punya plafon 60 s walau attempt besar", () => {
  assert.ok(backoffMs(30, "abc") <= 60_000);
});

test("backoff deterministik: id+attempt sama → angka sama", () => {
  assert.equal(backoffMs(3, "foto-a"), backoffMs(3, "foto-a"));
  // Dan id berbeda → jadwal berbeda (tidak menabrak server bersamaan).
  assert.notEqual(backoffMs(3, "foto-a"), backoffMs(3, "foto-b"));
});

test(`kehabisan ${UPLOAD_MAX_ATTEMPTS} percobaan → failed, auto-sync berhenti`, () => {
  let it = reduceUpload(item(), { type: "enqueue" });

  for (let i = 0; i < UPLOAD_MAX_ATTEMPTS; i += 1) {
    it = reduceUpload(it, { type: "start" });
    it = reduceUpload(it, { type: "failure", error: `gagal ke-${i + 1}`, at: T0 });
  }

  assert.equal(it.attempts, UPLOAD_MAX_ATTEMPTS);
  assert.equal(it.state, "failed");
  assert.equal(it.nextAttemptAt, null, "failed tidak dijadwalkan lagi");
  assert.equal(isReady(it, new Date(T0.getTime() + 3_600_000)), false);
});

test("retry-now dari failed mengembalikan ke antrian dengan percobaan nol", () => {
  const failed = item({ state: "failed", attempts: UPLOAD_MAX_ATTEMPTS, lastError: "gagal" });
  const it = reduceUpload(failed, { type: "retry-now", at: T0 });
  assert.equal(it.state, "queued");
  assert.equal(it.attempts, 0);
  assert.equal(it.lastError, null);
  assert.equal(isReady(it, T0), true);
});

test("nextBatch menghormati concurrency dan urutan createdAt", () => {
  const items: UploadItem[] = [
    item({ id: "b", createdAt: "2026-10-12T00:00:02.000Z", state: "queued" }),
    item({ id: "a", createdAt: "2026-10-12T00:00:01.000Z", state: "queued" }),
    item({ id: "c", createdAt: "2026-10-12T00:00:03.000Z", state: "queued" }),
  ];
  const batch = nextBatch(items, T0, 2);
  assert.deepEqual(batch.map((i) => i.id), ["a", "b"], "yang lebih dulu diambil lebih dulu");
});

test("nextBatch melewati item yang belum waktunya & yang sudah uploaded", () => {
  const items: UploadItem[] = [
    item({ id: "tunggu", state: "queued", nextAttemptAt: "2026-10-12T00:05:00.000Z" }),
    item({ id: "selesai", state: "uploaded" }),
    item({ id: "siap", state: "queued" }),
  ];
  assert.deepEqual(nextBatch(items, T0, 5).map((i) => i.id), ["siap"]);
});

test("nextBatch dengan concurrency 0 → kosong (tidak diam-diam mengabaikan batas)", () => {
  assert.deepEqual(nextBatch([item({ state: "queued" })], T0, 0), []);
});

test("countByState menghitung pending = total − uploaded", () => {
  const items: UploadItem[] = [
    item({ id: "1", state: "local-only" }),
    item({ id: "2", state: "queued" }),
    item({ id: "3", state: "uploading" }),
    item({ id: "4", state: "uploaded" }),
    item({ id: "5", state: "failed" }),
  ];
  const counts = countByState(items);
  assert.equal(counts.total, 5);
  assert.equal(counts.uploaded, 1);
  assert.equal(counts.pending, 4);
  assert.equal(counts["local-only"], 1);
  assert.equal(counts.failed, 1);
});

test("hasWork: true kalau ada yang siap, false kalau semua menunggu/beres", () => {
  assert.equal(hasWork([item({ state: "queued" })], T0), true);
  assert.equal(hasWork([item({ state: "uploaded" })], T0), false);
  assert.equal(hasWork([item({ state: "local-only" })], T0), false);
  assert.equal(
    hasWork([item({ state: "queued", nextAttemptAt: "2026-10-12T01:00:00.000Z" })], T0),
    false,
    "yang masih backoff bukan 'ada kerjaan'",
  );
});
