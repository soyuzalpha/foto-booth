/**
 * Tes penjadwalan timer antrian upload.
 *
 * Ini bagian yang paling gampang salah dan paling mahal kalau salah:
 *
 *   · Timer yang selalu menyala → laptop kiosk tidak pernah tidur.
 *   · Timer yang tidak dipasang saat backoff → foto menggantung sampai
 *     operator menekan tombol, padahal jaringannya sudah kembali.
 *
 * Karena itu `nextDelayMs` dipisah dari hook: keputusan penjadwalan bisa
 * diuji tanpa React dan tanpa `setTimeout` sungguhan.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { UploadItem } from "@foto-booth/shared";

import { nextDelayMs } from "./useUploadQueue.ts";

function item(overrides: Partial<UploadItem> & { id: string }): UploadItem {
  return {
    galleryId: "gal-1",
    blobKey: "blob:1",
    thumbBlobKey: "thumb:1",
    filename: "a.jpg",
    contentType: "image/jpeg",
    bytes: 10,
    width: 100,
    height: 100,
    state: "queued",
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    remotePhotoId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    uploadedAt: null,
    ...overrides,
  };
}

const NOW = new Date("2026-01-01T00:00:00Z");
const TICK = 1000;

test("antrian kosong → tidak ada timer (null)", () => {
  assert.equal(nextDelayMs([], NOW, TICK), null);
});

test("semua sudah uploaded → tidak ada timer", () => {
  const items = [item({ id: "a", state: "uploaded" }), item({ id: "b", state: "uploaded" })];
  assert.equal(nextDelayMs(items, NOW, TICK), null);
});

test("ada item siap sekarang → pakai tick pendek", () => {
  const items = [item({ id: "a", state: "queued", nextAttemptAt: null })];
  assert.equal(nextDelayMs(items, NOW, TICK), TICK);
});

test("item dengan jadwal yang sudah lewat dianggap siap → tick pendek", () => {
  const items = [item({ id: "a", nextAttemptAt: "2025-12-31T23:59:00.000Z" })];
  assert.equal(nextDelayMs(items, NOW, TICK), TICK);
});

test("semua terjadwal di masa depan → timer disetel ke jadwal terdekat", () => {
  const items = [
    item({ id: "a", nextAttemptAt: "2026-01-01T00:00:30.000Z" }),
    item({ id: "b", nextAttemptAt: "2026-01-01T00:00:05.000Z" }),
  ];
  // Yang terdekat = 5 detik, bukan tick 1 detik yang berputar 5 kali.
  assert.equal(nextDelayMs(items, NOW, TICK), 5000);
});

test("campuran: satu siap → tick pendek menang atas jadwal jauh", () => {
  const items = [
    item({ id: "a", nextAttemptAt: "2026-01-01T01:00:00.000Z" }),
    item({ id: "b", nextAttemptAt: null }),
  ];
  assert.equal(nextDelayMs(items, NOW, TICK), TICK);
});

test("item `failed` tidak ditunggu (auto-sync tidak menyentuhnya lagi)", () => {
  const items = [item({ id: "a", state: "failed", attempts: 5, nextAttemptAt: null })];
  assert.equal(nextDelayMs(items, NOW, TICK), null);
});

test("item `local-only` tidak dipasangi timer (belum punya byte)", () => {
  // Kalau ini lolos ke perhitungan, `nextAttemptAt: null` → jadwal 1970 →
  // timer 50 ms yang berputar selamanya di kiosk.
  const items = [item({ id: "a", state: "local-only", nextAttemptAt: null })];
  assert.equal(nextDelayMs(items, NOW, TICK), null);
});

test("item `uploading` tidak dipasangi timer (sedang dikerjakan)", () => {
  const items = [item({ id: "a", state: "uploading", attempts: 1, nextAttemptAt: null })];
  assert.equal(nextDelayMs(items, NOW, TICK), null);
});

test("item `uploaded` diabaikan walau ada item pending lain", () => {
  const items = [
    item({ id: "a", state: "uploaded" }),
    item({ id: "b", state: "queued", nextAttemptAt: "2026-01-01T00:00:02.000Z" }),
  ];
  assert.equal(nextDelayMs(items, NOW, TICK), 2000);
});

test("jadwal yang sangat dekat tidak jadi timer 0 ms (batas bawah)", () => {
  const items = [item({ id: "a", nextAttemptAt: "2026-01-01T00:00:00.010Z" })];
  const delay = nextDelayMs(items, NOW, TICK);
  assert.ok(delay !== null && delay >= 50);
});
