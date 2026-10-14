/**
 * Tes guestbook (Fase 9).
 *
 * Yang diuji: **apa yang diterima dan apa yang ditolak**. Batas durasi/ukuran
 * ditegakkan di sini, dan `key` dibangun dari id — bukan dari label tamu.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GUESTBOOK_LABEL_MAX,
  GUESTBOOK_MAX_BYTES,
  GUESTBOOK_MAX_SECONDS,
  formatDuration,
  guestbookKey,
  isGuestbookEntryKind,
  normalizeGuestbookLabel,
  totalDurationSeconds,
  validateGuestbookDraft,
  visibleEntries,
  type GuestbookEntry,
} from "./guestbook.ts";

function entry(overrides: Partial<GuestbookEntry> = {}): GuestbookEntry {
  return {
    id: overrides.id ?? "gb_1",
    eventId: overrides.eventId ?? "ev_1",
    galleryId: overrides.galleryId ?? null,
    kind: overrides.kind ?? "video",
    contentType: overrides.contentType ?? "video/webm",
    key: overrides.key ?? "events/ev_1/guestbook/gb_1.webm",
    durationSeconds: overrides.durationSeconds ?? 10,
    bytes: overrides.bytes ?? 1024,
    label: overrides.label ?? "Tamu",
    visible: overrides.visible ?? true,
    createdAt: overrides.createdAt ?? "2026-10-14T10:00:00.000Z",
  };
}

test("isGuestbookEntryKind menyaring nilai asing", () => {
  assert.equal(isGuestbookEntryKind("video"), true);
  assert.equal(isGuestbookEntryKind("audio"), true);
  assert.equal(isGuestbookEntryKind("image"), false);
});

test("label: kosong/rusak jadi 'Tamu', dipotong di batas", () => {
  assert.equal(normalizeGuestbookLabel(undefined), "Tamu");
  assert.equal(normalizeGuestbookLabel("   "), "Tamu");
  assert.equal(normalizeGuestbookLabel("Budi\nSantoso"), "Budi Santoso");
  assert.equal(normalizeGuestbookLabel("x".repeat(GUESTBOOK_LABEL_MAX + 20)).length, GUESTBOOK_LABEL_MAX);
});

test("draft sah diterima dan durasi dibulatkan ke atas", () => {
  const verdict = validateGuestbookDraft({
    kind: "video",
    contentType: "video/webm",
    durationSeconds: 12.4,
    bytes: 2048,
    label: "Rina",
    consent: true,
  });
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    // Dibulatkan ke atas: berkas 12,4 dtk tidak boleh tercatat 12.
    assert.equal(verdict.value.durationSeconds, 13);
    assert.equal(verdict.value.label, "Rina");
  }
});

test("tanpa persetujuan UU PDP tidak ada yang lolos", () => {
  const base = { kind: "video", contentType: "video/webm", durationSeconds: 5, bytes: 100 };
  // Tidak dikirim sama sekali.
  assert.equal(validateGuestbookDraft(base).ok, false);
  // Dikirim tapi bernilai false — "ada" bukan "setuju".
  assert.equal(validateGuestbookDraft({ ...base, consent: false }).ok, false);
  // Nilai yang mirip tapi bukan boolean.
  assert.equal(validateGuestbookDraft({ ...base, consent: "true" }).ok, false);
  assert.equal(validateGuestbookDraft({ ...base, consent: 1 }).ok, false);
  assert.equal(validateGuestbookDraft({ ...base, consent: true }).ok, true);
});

test("kiriman bukan objek ditolak", () => {
  const verdict = validateGuestbookDraft(null);
  assert.equal(verdict.ok, false);
});

test("jenis & format asing ditolak", () => {
  const badKind = validateGuestbookDraft({ kind: "image", contentType: "image/png", durationSeconds: 5, bytes: 100 });
  assert.equal(badKind.ok, false);

  const badType = validateGuestbookDraft({
    kind: "video",
    contentType: "application/x-msdownload",
    durationSeconds: 5,
    bytes: 100,
  });
  assert.equal(badType.ok, false);
});

test("durasi di atas batas ditolak, tepat di batas diterima", () => {
  const over = validateGuestbookDraft({
    kind: "video",
    contentType: "video/webm",
    durationSeconds: GUESTBOOK_MAX_SECONDS + 1,
    bytes: 100,
  });
  assert.equal(over.ok, false);

  const exact = validateGuestbookDraft({
    kind: "video",
    contentType: "video/webm",
    durationSeconds: GUESTBOOK_MAX_SECONDS,
    bytes: 100,
    consent: true,
  });
  assert.equal(exact.ok, true);
});

test("durasi tidak terbaca atau nol ditolak", () => {
  assert.equal(validateGuestbookDraft({ kind: "video", contentType: "video/webm", durationSeconds: "abc", bytes: 100 }).ok, false);
  assert.equal(validateGuestbookDraft({ kind: "video", contentType: "video/webm", durationSeconds: 0, bytes: 100 }).ok, false);
});

test("berkas kosong atau terlalu besar ditolak", () => {
  assert.equal(validateGuestbookDraft({ kind: "video", contentType: "video/webm", durationSeconds: 5, bytes: 0 }).ok, false);
  assert.equal(
    validateGuestbookDraft({
      kind: "video",
      contentType: "video/webm",
      durationSeconds: 5,
      bytes: GUESTBOOK_MAX_BYTES + 1,
    }).ok,
    false,
  );
});

test("key dibangun dari id, bukan label", () => {
  const key = guestbookKey("ev_1", "gb_9", "video/webm");
  assert.equal(key, "events/ev_1/guestbook/gb_9.webm");
  // Nama tamu tidak pernah masuk key: dua 'Budi' tetap dua berkas berbeda.
  assert.equal(guestbookKey("ev_1", "gb_10", "video/mp4"), "events/ev_1/guestbook/gb_10.mp4");
});

test("key tidak bisa keluar dari prefiks acara", () => {
  // MIME aneh disaring jadi ekstensi alfanumerik saja.
  const key = guestbookKey("ev_1", "gb_1", "video/../../etc/passwd");
  assert.equal(key.includes(".."), false);
  assert.equal(key.startsWith("events/ev_1/guestbook/"), true);
});

test("visibleEntries: hanya yang tampil, terbaru dulu", () => {
  const list = [
    entry({ id: "a", createdAt: "2026-10-14T09:00:00.000Z" }),
    entry({ id: "b", createdAt: "2026-10-14T11:00:00.000Z" }),
    entry({ id: "c", createdAt: "2026-10-14T10:00:00.000Z", visible: false }),
  ];
  assert.deepEqual(
    visibleEntries(list).map((row) => row.id),
    ["b", "a"],
  );
});

test("totalDurationSeconds & formatDuration", () => {
  assert.equal(totalDurationSeconds([entry({ durationSeconds: 10 }), entry({ durationSeconds: 25 })]), 35);
  assert.equal(totalDurationSeconds([]), 0);

  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(9), "0:09");
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(-3), "0:00");
  assert.equal(formatDuration(Number.NaN), "0:00");
});
