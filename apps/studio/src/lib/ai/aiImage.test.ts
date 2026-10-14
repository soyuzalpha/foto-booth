/**
 * Tes bantu gambar AI (Fase 8).
 *
 * Yang diuji di sini adalah batas yang gampang salah dan mahal:
 *
 *   · data-URL yang bentuknya aneh (charset, spasi/baris baru, MIME tak dikenal)
 *     tidak boleh lolos ke jaringan;
 *   · gambar kebesaran ditolak **tanpa mendekode** base64-nya — kalau fungsi ini
 *     mendekode dulu, foto 40 MB dari kamera salah setelan bisa menghabiskan
 *     memori kiosk sebelum ditolak;
 *   · ekstensi hasil harus cocok dengan MIME-nya, kalau tidak berkas hasil simpan
 *     tidak bisa dibuka aplikasi lain.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AI_MAX_INPUT_BYTES } from "@foto-booth/shared";

import { decodeDataUrl, extensionForAiMime, toDataUrl } from "./aiImage.ts";

/** base64 sah untuk sejumlah byte biner. */
function b64(bytes: number): string {
  return "A".repeat(Math.ceil(bytes / 3) * 4);
}

test("data-URL JPEG yang sah terbaca", () => {
  const decoded = decodeDataUrl("data:image/jpeg;base64,AAAA");
  assert.deepEqual(decoded, { mimeType: "image/jpeg", base64: "AAAA", bytes: 3 });
});

test("charset & spasi dari formatter tidak mengganggu", () => {
  const decoded = decodeDataUrl("data:image/png;charset=utf-8;base64,AA\nAA");
  assert.equal(decoded?.mimeType, "image/png");
  assert.equal(decoded?.base64, "AAAA");
});

test("bukan data-URL / MIME tak didukung → null", () => {
  const rejected = [
    "http://example.com/foto.jpg",
    "data:image/gif;base64,AAAA",
    "data:video/mp4;base64,AAAA",
    "data:image/jpeg;base64,",
    "data:image/jpeg,AAAA",
    "",
  ];
  for (const input of rejected) {
    assert.equal(decodeDataUrl(input), null, input);
  }
});

test("gambar melewati batas ditolak tanpa mendekode", () => {
  const tooBig = `data:image/jpeg;base64,${b64(AI_MAX_INPUT_BYTES + 1024)}`;
  assert.equal(decodeDataUrl(tooBig), null);
});

test("gambar tepat di bawah batas diterima", () => {
  const ok = `data:image/webp;base64,${b64(AI_MAX_INPUT_BYTES - 1024)}`;
  const decoded = decodeDataUrl(ok);
  assert.equal(decoded?.mimeType, "image/webp");
  assert.ok((decoded?.bytes ?? 0) <= AI_MAX_INPUT_BYTES);
});

test("toDataUrl memasang MIME yang sah, dan jatuh ke PNG kalau tak dikenal", () => {
  assert.equal(toDataUrl("image/jpeg", "AAAA"), "data:image/jpeg;base64,AAAA");
  assert.equal(toDataUrl("image/avif", "AAAA"), "data:image/png;base64,AAAA");
});

test("ekstensi hasil cocok dengan MIME-nya", () => {
  assert.equal(extensionForAiMime("image/jpeg"), "jpg");
  assert.equal(extensionForAiMime("image/webp"), "webp");
  assert.equal(extensionForAiMime("image/png"), "png");
  // Apa pun yang tidak dikenal → png (perilaku `parseGeminiImage`).
  assert.equal(extensionForAiMime("image/avif"), "png");
});
