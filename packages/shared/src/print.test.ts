/**
 * Tes aturan cetak bersama.
 *
 * Semua angka di sini bisa diperiksa tangan — dan memang harus: kalau satu
 * piksel salah, hasil cetak 300 dpi baru ketahuan setelah kertas terbuang.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRINT_BLEED_IN,
  PRINT_PRESETS,
  PRINT_SAFE_MARGIN_IN,
  cutMarkLines,
  fitBox,
  nearestPrintPreset,
  printPixelSize,
  printPresetById,
  printSafeBox,
  printSizeMm,
  printTrimBox,
} from "./print.ts";

test("preset 2×6 @300 dpi = lembar 600×1800 px", () => {
  const preset = printPresetById("2x6");
  assert.ok(preset !== null);
  assert.deepEqual(printPixelSize(preset), { width: 600, height: 1800 });
});

test("preset 4×6 @300 dpi = lembar 1200×1800 px", () => {
  const preset = printPresetById("4x6");
  assert.ok(preset !== null);
  assert.deepEqual(printPixelSize(preset), { width: 1200, height: 1800 });
});

test("bleed menambah kanvas 2× di tiap sisi (0,05 in = 15 px)", () => {
  const preset = printPresetById("2x6");
  assert.ok(preset !== null);
  assert.equal(PRINT_BLEED_IN, 0.05);

  const withBleed = printPixelSize(preset, { includeBleed: true });
  assert.deepEqual(withBleed, { width: 630, height: 1830 });
});

test("area trim = ukuran kertas; bergeser sejauh bleed kalau bleed aktif", () => {
  const preset = printPresetById("2x6");
  assert.ok(preset !== null);

  assert.deepEqual(printTrimBox(preset), { x: 0, y: 0, width: 600, height: 1800 });
  assert.deepEqual(printTrimBox(preset, { includeBleed: true }), {
    x: 15,
    y: 15,
    width: 600,
    height: 1800,
  });
});

test("area aman = trim dikurangi margin 36 px @300 dpi", () => {
  const preset = printPresetById("2x6");
  assert.ok(preset !== null);
  assert.equal(PRINT_SAFE_MARGIN_IN, 0.12);

  assert.deepEqual(printSafeBox(preset), { x: 36, y: 36, width: 528, height: 1728 });
});

test("area aman dengan bleed bergeser bleed + margin", () => {
  const preset = printPresetById("2x6");
  assert.ok(preset !== null);
  assert.deepEqual(printSafeBox(preset, { includeBleed: true }), {
    x: 51,
    y: 51,
    width: 528,
    height: 1728,
  });
});

test("preset tidak dikenal → null, bukan preset pertama", () => {
  assert.equal(printPresetById("tidak-ada"), null);
});

test("nearestPrintPreset memilih yang paling dekat, bukan yang pertama", () => {
  assert.equal(nearestPrintPreset(3.9, 6.1).id, "4x6");
  assert.equal(nearestPrintPreset(2, 6).id, "2x6");
  assert.equal(nearestPrintPreset(8.5, 11).id, "a4");
});

test("fitBox menjaga rasio aspek dan tidak memperbesar melebihi area", () => {
  // Template 600×1800 (1:3) ke area 1200×1800 (2:3) → tinggi jadi penentu.
  const box = fitBox({ width: 600, height: 1800 }, { x: 0, y: 0, width: 1200, height: 1800 });
  assert.equal(box.height, 1800);
  assert.equal(box.width, 600);
  assert.equal(box.x, 300, "sisa kertas dibagi dua");
  assert.equal(box.y, 0);
});

test("fitBox memberi letterbox, bukan distorsi", () => {
  const box = fitBox({ width: 1600, height: 1200 }, { x: 0, y: 0, width: 600, height: 600 });
  assert.equal(box.width / box.height, 1600 / 1200);
});

test("fitBox dengan konten kosong → kotak nol, bukan NaN", () => {
  const box = fitBox({ width: 0, height: 0 }, { x: 10, y: 10, width: 100, height: 100 });
  assert.deepEqual(box, { x: 10, y: 10, width: 0, height: 0 });
});

test("printSizeMm mengubah inci → mm untuk @page", () => {
  const preset = printPresetById("2x6");
  assert.ok(preset !== null);
  assert.deepEqual(printSizeMm(preset), { width: 50.8, height: 152.4 });
});

test("printSizeMm dengan bleed menambah 2×0,05 in = 2,54 mm", () => {
  const preset = printPresetById("2x6");
  assert.ok(preset !== null);
  const mm = printSizeMm(preset, { includeBleed: true });
  assert.equal(mm.width, 53.34);
  assert.equal(mm.height, 154.94);
});

test("tanda potong hanya keluar kalau preset minta DAN bleed aktif", () => {
  const strip = printPresetById("2x6");
  const a4 = printPresetById("a4");
  assert.ok(strip !== null && a4 !== null);

  assert.equal(strip.cutMarks, false);
  assert.deepEqual(cutMarkLines(strip, { includeBleed: true }), []);

  assert.equal(a4.cutMarks, true);
  assert.deepEqual(cutMarkLines(a4, {}), [], "tanpa bleed tidak ada area untuk tanda");
  assert.equal(cutMarkLines(a4, { includeBleed: true }).length, 8);
});

test("tanda potong tidak pernah masuk ke area cetak", () => {
  const a4 = printPresetById("a4");
  assert.ok(a4 !== null);

  const trim = printTrimBox(a4, { includeBleed: true });
  for (const line of cutMarkLines(a4, { includeBleed: true })) {
    for (const x of [line.x1, line.x2]) {
      assert.ok(
        x <= trim.x || x >= trim.x + trim.width,
        `tanda potong x=${x} masuk area cetak`,
      );
    }
    for (const y of [line.y1, line.y2]) {
      assert.ok(
        y <= trim.y || y >= trim.y + trim.height,
        `tanda potong y=${y} masuk area cetak`,
      );
    }
  }
});

test("semua preset punya id unik dan margin aman minimal", () => {
  const ids = PRINT_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);

  for (const preset of PRINT_PRESETS) {
    assert.ok(preset.margin >= 0.08, `${preset.id} margin terlalu tipis`);
    assert.ok(preset.dpi >= 300, `${preset.id} dpi di bawah 300`);
  }
});
