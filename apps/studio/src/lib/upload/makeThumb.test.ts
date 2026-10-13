/**
 * Tes pembuat thumbnail.
 *
 * Modul ini **selalu boleh gagal**: `createImageBitmap` dan `<canvas>` tidak
 * ada di semua lingkungan, dan kegagalannya tidak berarti apa-apa bagi foto
 * aslinya. Jadi yang diuji:
 *
 *   1. **Hitungannya benar** — sisi panjang dibatasi 512 px, foto kecil tidak
 *      diperbesar, dan tidak ada hasil 0 px.
 *   2. **Tanpa dukungan browser, hasilnya `null`, bukan lemparan.** Di Node
 *      `createImageBitmap` tidak ada; itu jalur yang persis sama dengan jsdom.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeThumb, THUMB_CONTENT_TYPE, THUMB_MAX_EDGE, thumbSize } from "./makeThumb.ts";

test("sisi panjang dibatasi 512 px", () => {
  assert.equal(THUMB_MAX_EDGE, 512);
  assert.deepEqual(thumbSize(4000, 3000), { width: 512, height: 384 });
  assert.deepEqual(thumbSize(1000, 2000), { width: 256, height: 512 });
});

test("foto yang sudah kecil tidak diperbesar", () => {
  assert.deepEqual(thumbSize(300, 200), { width: 300, height: 200 });
  assert.deepEqual(thumbSize(512, 512), { width: 512, height: 512 });
});

test("ukuran tidak pernah jadi 0 px walau pembulatannya mendekati nol", () => {
  // 512/10000 dari 1 px membulat jadi 0 — dan thumbnail 0 px bikin
  // `canvas.toBlob` mengembalikan null tanpa penjelasan.
  assert.deepEqual(thumbSize(10000, 1), { width: 512, height: 1 });
  assert.deepEqual(thumbSize(1, 10000), { width: 1, height: 512 });
});

test("ukuran yang tidak masuk akal menghasilkan 0, bukan NaN", () => {
  assert.deepEqual(thumbSize(0, 3000), { width: 0, height: 0 });
  assert.deepEqual(thumbSize(4000, -1), { width: 0, height: 0 });
});

test("maxEdge bisa ditimpa untuk tes dan kebutuhan lain", () => {
  assert.deepEqual(thumbSize(1000, 500, 100), { width: 100, height: 50 });
});

test("tanpa createImageBitmap, makeThumb mengembalikan null (bukan melempar)", async () => {
  assert.equal(typeof createImageBitmap, "undefined");
  assert.equal(await makeThumb(new Blob(["x"], { type: "image/jpeg" })), null);
});

test("tipe konten thumbnail adalah JPEG — kecil, dan didukung semua browser", () => {
  assert.equal(THUMB_CONTENT_TYPE, "image/jpeg");
});
