/**
 * Tes radius blur.
 *
 * Blur dihitung dari lebar gambar, jadi tesnya memastikan radius tumbuh
 * sebanding ukuran & kekuatan, dan tidak pernah 0 saat blur diminta.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_BLUR_FRACTION, blurRadiusPx } from "./blur.ts";

test("kekuatan 0 → tidak ada blur", () => {
  assert.equal(blurRadiusPx(0, 1000), 0);
});

test("kekuatan penuh → radius = fraksi maksimum × lebar", () => {
  assert.equal(blurRadiusPx(100, 1000), Math.round(1000 * MAX_BLUR_FRACTION));
});

test("kekuatan setengah → separuh radius", () => {
  assert.equal(blurRadiusPx(50, 1000), Math.round((1000 * MAX_BLUR_FRACTION) / 2));
});

test("radius tumbuh sebanding lebar gambar", () => {
  assert.ok(blurRadiusPx(50, 2000) > blurRadiusPx(50, 1000));
});

test("lebar 0 → 0 (tidak ada yang diblur)", () => {
  assert.equal(blurRadiusPx(50, 0), 0);
});

test("blur kecil pun minimal 1 px (bukan 0 yang menipu)", () => {
  assert.equal(blurRadiusPx(1, 100), 1);
});
