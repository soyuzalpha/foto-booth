/**
 * Tes preset latar & warna kunci.
 *
 * Preset dipakai langsung sebagai nilai pengaturan, jadi yang diuji: warna
 * dikonversi ke CSS dengan benar (dan di-clamp), serta id-nya unik supaya
 * pilihan UI tidak tertukar.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { BACKGROUND_COLORS, CHROMA_PRESETS, rgbToCss } from "./presets.ts";

test("rgbToCss menghasilkan string CSS yang benar", () => {
  assert.equal(rgbToCss({ r: 255, g: 0, b: 0 }), "rgb(255, 0, 0)");
  assert.equal(rgbToCss({ r: 30, g: 90, b: 200 }), "rgb(30, 90, 200)");
});

test("rgbToCss meng-clamp nilai di luar 0..255", () => {
  assert.equal(rgbToCss({ r: 300, g: -5, b: 10 }), "rgb(255, 0, 10)");
});

test("setiap preset punya id unik", () => {
  const bgIds = BACKGROUND_COLORS.map((p) => p.id);
  assert.equal(new Set(bgIds).size, bgIds.length, "id latar harus unik");

  const chromaIds = CHROMA_PRESETS.map((p) => p.id);
  assert.equal(new Set(chromaIds).size, chromaIds.length, "id kroma harus unik");
});

test("CHROMA_PRESETS berisi hijau & biru", () => {
  const ids = CHROMA_PRESETS.map((p) => p.id);
  assert.ok(ids.includes("green"));
  assert.ok(ids.includes("blue"));
});

test("preset latar tidak kosong dan warnanya valid", () => {
  assert.ok(BACKGROUND_COLORS.length >= 4);
  for (const preset of BACKGROUND_COLORS) {
    const { r, g, b } = preset.color;
    for (const v of [r, g, b]) {
      assert.ok(v >= 0 && v <= 255, `${preset.id}: kanal ${v} keluar rentang`);
    }
  }
});
