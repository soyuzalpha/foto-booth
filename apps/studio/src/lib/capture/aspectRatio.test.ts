/**
 * Tes matematika crop.
 *
 * Yang diuji bukan "kelihatan benar" tapi angka: hasil crop harus punya rasio
 * yang diminta (dalam toleransi 1 piksel karena pembulatan), tidak melebihi
 * sumbernya, dan berada di tengah.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ASPECT_RATIOS,
  aspectRatioById,
  computeCrop,
  croppedSize,
  scaleToFit,
} from "./aspectRatio.ts";

test("original → seluruh frame, tanpa crop", () => {
  const crop = computeCrop({ width: 1920, height: 1080 }, null);
  assert.deepEqual(crop, { sx: 0, sy: 0, sw: 1920, sh: 1080 });
});

test("16:9 dari sumber 4:3 → potong atas-bawah, lebar penuh", () => {
  const crop = computeCrop({ width: 1600, height: 1200 }, 16 / 9);

  assert.equal(crop.sw, 1600, "lebar harus penuh");
  assert.equal(crop.sh, 900, "tinggi = lebar / (16/9)");
  assert.equal(crop.sx, 0);
  assert.equal(crop.sy, 150, "sisa 300 piksel dibagi dua");

  const ratio = crop.sw / crop.sh;
  assert.ok(Math.abs(ratio - 16 / 9) < 0.01, `rasio ${ratio} harus ≈ 1.778`);
});

test("1:1 dari sumber 1920×1080 → persegi 1080×1080 di tengah", () => {
  const crop = computeCrop({ width: 1920, height: 1080 }, 1);

  assert.equal(crop.sw, 1080);
  assert.equal(crop.sh, 1080);
  assert.equal(crop.sy, 0);
  assert.equal(crop.sx, 420, "(1920 - 1080) / 2");
});

test("3:2 dari sumber 1920×1080 → potong kiri-kanan", () => {
  const crop = computeCrop({ width: 1920, height: 1080 }, 3 / 2);

  assert.equal(crop.sh, 1080, "tinggi penuh");
  assert.equal(crop.sw, 1620, "1080 × 1.5");
  assert.equal(crop.sy, 0);
  assert.equal(crop.sx, 150);

  const ratio = crop.sw / crop.sh;
  assert.ok(Math.abs(ratio - 3 / 2) < 0.01, `rasio ${ratio} harus ≈ 1.5`);
});

test("crop tidak pernah melebihi sumber", () => {
  for (const option of ASPECT_RATIOS) {
    for (const source of [
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { width: 640, height: 480 },
      { width: 3840, height: 2160 },
    ]) {
      const crop = computeCrop(source, option.ratio);
      assert.ok(crop.sw <= source.width, `${option.id}: lebar ${crop.sw} > ${source.width}`);
      assert.ok(crop.sh <= source.height, `${option.id}: tinggi ${crop.sh} > ${source.height}`);
      assert.ok(crop.sx >= 0 && crop.sy >= 0, `${option.id}: offset negatif`);
      assert.ok(
        crop.sx + crop.sw <= source.width && crop.sy + crop.sh <= source.height,
        `${option.id}: keluar dari frame`,
      );
      assert.ok(crop.sw >= 1 && crop.sh >= 1, `${option.id}: dimensi nol`);
    }
  }
});

test("crop selalu di tengah (selisih sisi ≤ 1 piksel)", () => {
  const crop = computeCrop({ width: 1921, height: 1081 }, 1);
  const leftGap = crop.sx;
  const rightGap = 1921 - crop.sw - crop.sx;
  const topGap = crop.sy;
  const bottomGap = 1081 - crop.sh - crop.sy;

  assert.ok(Math.abs(leftGap - rightGap) <= 1, "horizontal tidak di tengah");
  assert.ok(Math.abs(topGap - bottomGap) <= 1, "vertikal tidak di tengah");
});

test("sumber 0×0 tidak meledak", () => {
  assert.deepEqual(computeCrop({ width: 0, height: 0 }, 1), { sx: 0, sy: 0, sw: 0, sh: 0 });
  assert.deepEqual(computeCrop({ width: 0, height: 0 }, null), { sx: 0, sy: 0, sw: 0, sh: 0 });
});

test("croppedSize konsisten dengan computeCrop", () => {
  const source = { width: 1920, height: 1080 };
  const size = croppedSize(source, 1);
  const crop = computeCrop(source, 1);

  assert.equal(size.width, crop.sw);
  assert.equal(size.height, crop.sh);
});

test("aspectRatioById menemukan id, dan null untuk yang tidak ada", () => {
  assert.equal(aspectRatioById("1:1")?.ratio, 1);
  assert.equal(aspectRatioById("original")?.ratio, null);
  assert.equal(aspectRatioById("4:3" as never), null);
});

test("scaleToFit mengecilkan tanpa mengubah rasio", () => {
  const scaled = scaleToFit({ width: 3840, height: 2160 }, 1920);
  assert.deepEqual(scaled, { width: 1920, height: 1080 });

  const untouched = scaleToFit({ width: 800, height: 600 }, 1920);
  assert.deepEqual(untouched, { width: 800, height: 600 });
});
