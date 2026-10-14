/**
 * Tes pemilihan kontainer/kodek.
 *
 * Yang dijaga: kandidat pertama yang didukung yang dipakai (bukan yang terakhir),
 * `isSupported` yang melempar tidak menjatuhkan pemilihan, dan **tidak ada
 * kandidat didukung → `null`** — bukan format tebakan.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VIDEO_MIME_PREFERENCES,
  VIDEO_MIME_PREFERENCES_NO_AUDIO,
  contentTypeForMimeType,
  extensionForMimeType,
  pickMimeType,
  preferencesFor,
} from "./codec.ts";

const SUPPORT_ALL = (): boolean => true;
const SUPPORT_NONE = (): boolean => false;

test("pickMimeType memakai kandidat pertama yang didukung", () => {
  const picked = pickMimeType(["a", "b", "c"], (mime) => mime === "b");
  assert.equal(picked, "b");
});

test("pickMimeType mengembalikan null kalau tidak ada yang didukung", () => {
  assert.equal(pickMimeType(["a", "b"], SUPPORT_NONE), null);
  assert.equal(pickMimeType([], SUPPORT_ALL), null);
});

test("pickMimeType melewati kandidat yang membuat isSupported melempar", () => {
  const picked = pickMimeType(["boom", "ok"], (mime) => {
    if (mime === "boom") throw new Error("browser aneh");
    return true;
  });
  assert.equal(picked, "ok");
});

test("daftar preferensi ber-audio memuat codec audio, yang tanpa audio tidak", () => {
  assert.ok(VIDEO_MIME_PREFERENCES.every((mime) => mime.startsWith("video/")));
  assert.ok(
    VIDEO_MIME_PREFERENCES.some((mime) => mime.includes("opus") || mime.includes("mp4a")),
    "ada kandidat ber-audio",
  );
  assert.ok(
    VIDEO_MIME_PREFERENCES_NO_AUDIO.every((mime) => !mime.includes("opus") && !mime.includes("mp4a")),
    "tanpa audio tidak boleh meminta codec audio",
  );
});

test("preferencesFor memilih daftar sesuai setelan audio", () => {
  assert.equal(preferencesFor(true), VIDEO_MIME_PREFERENCES);
  assert.equal(preferencesFor(false), VIDEO_MIME_PREFERENCES_NO_AUDIO);
});

test("MP4 dipilih lebih dulu karena paling universal untuk tamu", () => {
  assert.equal(extensionForMimeType(pickMimeType(VIDEO_MIME_PREFERENCES_NO_AUDIO, SUPPORT_ALL)), "mp4");
});

test("extensionForMimeType: null → webm, mp4 → mp4", () => {
  assert.equal(extensionForMimeType(null), "webm");
  assert.equal(extensionForMimeType("video/mp4"), "mp4");
  assert.equal(extensionForMimeType("video/mp4;codecs=avc1.4d002a"), "mp4");
  assert.equal(extensionForMimeType("video/webm;codecs=vp9"), "webm");
});

test("contentTypeForMimeType selalu tipe MIME bersih (tanpa parameter codecs)", () => {
  assert.equal(contentTypeForMimeType("video/mp4;codecs=avc1.4d002a,mp4a.40.2"), "video/mp4");
  assert.equal(contentTypeForMimeType("video/webm;codecs=vp9"), "video/webm");
  assert.equal(contentTypeForMimeType(null), "video/webm");
});
