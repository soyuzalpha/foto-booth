/**
 * Tes penyesuaian warna.
 *
 * Yang diuji angka, bukan "kelihatan benar": brightness naik → kanal naik,
 * saturation 0 → r=g=b, dan default netral benar-benar tidak mengubah piksel.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adjustmentsToCssFilter,
  applyAdjustmentsToPixel,
  clampAdjustment,
  isNeutralAdjustments,
} from "./adjustments.ts";

const NETRAL = { brightness: 0, contrast: 0, saturation: 0 } as const;

test("netral → tanpa filter & piksel tidak berubah", () => {
  assert.equal(adjustmentsToCssFilter(NETRAL), "none");
  assert.ok(isNeutralAdjustments(NETRAL));
  assert.deepEqual(applyAdjustmentsToPixel({ r: 10, g: 120, b: 240 }, NETRAL), {
    r: 10,
    g: 120,
    b: 240,
  });
});

test("brightness +50 → kanal naik 1.5×", () => {
  const out = applyAdjustmentsToPixel({ r: 100, g: 100, b: 100 }, { ...NETRAL, brightness: 50 });
  assert.ok(out.r > 100, "harus lebih terang");
  assert.equal(Math.round(out.r), 150);
});

test("brightness -100 → hitam pekat", () => {
  const out = applyAdjustmentsToPixel({ r: 200, g: 100, b: 50 }, { ...NETRAL, brightness: -100 });
  assert.deepEqual(out, { r: 0, g: 0, b: 0 });
});

test("saturation -100 → abu-abu (r=g=b)", () => {
  const out = applyAdjustmentsToPixel({ r: 200, g: 100, b: 50 }, { ...NETRAL, saturation: -100 });
  assert.ok(Math.abs(out.r - out.g) < 1e-6, `r=${out.r} g=${out.g} harus sama`);
  assert.ok(Math.abs(out.g - out.b) < 1e-6, `g=${out.g} b=${out.b} harus sama`);
});

test("saturation +100 → warna makin jauh dari abu-abu", () => {
  const base = { r: 180, g: 120, b: 60 };
  const out = applyAdjustmentsToPixel(base, { ...NETRAL, saturation: 100 });
  const spread = (p: { r: number; g: number; b: number }) => p.r - p.b;
  assert.ok(spread(out) > spread(base), "jarak r-b harus melebar");
});

test("contrast +100 pada abu-abu tengah → tetap di tengah", () => {
  const out = applyAdjustmentsToPixel({ r: 128, g: 128, b: 128 }, { ...NETRAL, contrast: 100 });
  assert.ok(Math.abs(out.r - 128) < 1e-6, `tetap 128, dapat ${out.r}`);
});

test("hasil selalu di dalam 0..255", () => {
  for (const adj of [
    { brightness: 100, contrast: 100, saturation: 100 },
    { brightness: -100, contrast: 100, saturation: -100 },
    { brightness: 80, contrast: -100, saturation: 100 },
  ]) {
    const out = applyAdjustmentsToPixel({ r: 250, g: 5, b: 128 }, adj);
    for (const v of [out.r, out.g, out.b]) {
      assert.ok(v >= 0 && v <= 255, `nilai ${v} keluar rentang`);
    }
  }
});

test("string CSS mengikuti urutan brightness → contrast → saturate", () => {
  assert.equal(
    adjustmentsToCssFilter({ brightness: 20, contrast: 0, saturation: 0 }),
    "brightness(1.2)",
  );
  assert.equal(
    adjustmentsToCssFilter({ brightness: 0, contrast: 50, saturation: -50 }),
    "contrast(1.5) saturate(0.5)",
  );
});

test("clampAdjustment membatasi & menetralkan nilai aneh", () => {
  assert.equal(clampAdjustment(500), 100);
  assert.equal(clampAdjustment(-500), -100);
  assert.equal(clampAdjustment(Number.NaN), 0);
  assert.equal(clampAdjustment(Number.POSITIVE_INFINITY), 0);
});
