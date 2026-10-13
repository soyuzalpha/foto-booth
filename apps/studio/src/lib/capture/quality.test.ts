/**
 * Tes preset kualitas.
 *
 * Yang dijaga: preset tidak pernah memperbesar gambar, dan pembatasan lebar
 * menjaga rasio.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { QUALITY_PRESETS, fitToQualityPreset, qualityPresetById } from "./quality.ts";

test("id preset unik & ketiganya ada", () => {
  const ids = QUALITY_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ["hemat", "standar", "maks"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("qualityPresetById mengembalikan preset, fallback ke standar", () => {
  assert.equal(qualityPresetById("hemat").maxWidth, 1600);
  assert.equal(qualityPresetById("maks").maxWidth, 0);
  assert.equal(qualityPresetById("ngawur" as never).id, "standar");
});

test("gambar lebih lebar dari batas → diperkecil, rasio tetap", () => {
  const preset = qualityPresetById("hemat");
  const out = fitToQualityPreset(4000, 3000, preset);

  assert.equal(out.width, 1600);
  assert.equal(out.height, 1200, "rasio 4:3 harus dijaga");
});

test("gambar lebih kecil dari batas → tidak diperbesar", () => {
  const out = fitToQualityPreset(800, 600, qualityPresetById("hemat"));
  assert.deepEqual(out, { width: 800, height: 600 });
});

test("preset maks (maxWidth 0) → ukuran apa adanya", () => {
  const out = fitToQualityPreset(5000, 4000, qualityPresetById("maks"));
  assert.deepEqual(out, { width: 5000, height: 4000 });
});

test("lebar 0 tidak meledak", () => {
  assert.deepEqual(fitToQualityPreset(0, 0, qualityPresetById("hemat")), { width: 0, height: 0 });
});
