/**
 * Tes export lembar cetak.
 *
 * Yang diperiksa: ukuran kanvas yang diminta, nama berkas, dan bahwa rencana
 * yang dipakai memang rencana lembar (bukan rencana template). Kalau modul ini
 * salah memilih ukuran, hasilnya tetap "berhasil" — cuma kertasnya salah.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { exportFilename, printPresetById, type PrintPreset } from "@foto-booth/shared";

import { defaultStripTemplate } from "../template/model.ts";
import type { ExportCanvas, ExportDeps } from "../template/exportPng.ts";
import { ExportError } from "../template/exportPng.ts";
import { exportPrintSheet, sheetFilename } from "./exportPrint.ts";

const NOW = new Date("2026-10-12T19:30:00Z");

function preset(id: string): PrintPreset {
  const found = printPresetById(id);
  assert.ok(found !== null, `preset ${id} tidak ada`);
  return found;
}

/** Canvas palsu: mencatat ukuran yang diminta + perintah gambar. */
function fakeCanvas(sizes: { width: number; height: number }[], draws: string[]) {
  return (width: number, height: number): ExportCanvas => {
    sizes.push({ width, height });
    const context = {
      save: () => draws.push("save"),
      restore: () => draws.push("restore"),
      translate: () => draws.push("translate"),
      rotate: () => {},
      scale: () => draws.push("scale"),
      fillRect: () => draws.push("fillRect"),
      strokeRect: () => {},
      fillText: () => draws.push("fillText"),
      strokeText: () => {},
      measureText: () => ({ width: 10 }),
      drawImage: () => draws.push("drawImage"),
      beginPath: () => draws.push("beginPath"),
      moveTo: () => draws.push("moveTo"),
      lineTo: () => draws.push("lineTo"),
      stroke: () => draws.push("stroke"),
      fillStyle: "#000",
      strokeStyle: "#000",
      lineWidth: 1,
      font: "10px sans-serif",
      textAlign: "start",
      textBaseline: "alphabetic",
    };

    return {
      width,
      height,
      getContext: () => context,
      convertToBlob: async () => new Blob([new Uint8Array(2048)], { type: "image/png" }),
    };
  };
}

function deps(sizes: { width: number; height: number }[], draws: string[]): ExportDeps {
  return { createCanvas: fakeCanvas(sizes, draws) };
}

test("export 2×6 meminta kanvas 600×1800 — ukuran kertas, bukan pratinjau", async () => {
  const sizes: { width: number; height: number }[] = [];
  const draws: string[] = [];

  const result = await exportPrintSheet(defaultStripTemplate({ now: NOW }), preset("2x6"), deps(sizes, draws), {
    now: NOW,
  });

  assert.deepEqual(sizes, [{ width: 600, height: 1800 }]);
  assert.equal(result.width, 600);
  assert.equal(result.height, 1800);
  assert.equal(result.plan.trimBox.width, 600);
});

test("export 4×6 meminta 1200×1800 — kertas lebih lebar dari template", async () => {
  const sizes: { width: number; height: number }[] = [];
  const draws: string[] = [];

  const result = await exportPrintSheet(defaultStripTemplate({ now: NOW }), preset("4x6"), deps(sizes, draws), {
    now: NOW,
  });

  assert.deepEqual(sizes, [{ width: 1200, height: 1800 }]);
  assert.equal(result.plan.templateBox.x, 300, "template di tengah kertas");
});

test("bleed menambah kanvas dan menggeser trim", async () => {
  const sizes: { width: number; height: number }[] = [];
  const draws: string[] = [];

  const result = await exportPrintSheet(defaultStripTemplate({ now: NOW }), preset("2x6"), deps(sizes, draws), {
    now: NOW,
    includeBleed: true,
  });

  assert.deepEqual(sizes, [{ width: 630, height: 1830 }]);
  assert.deepEqual(result.plan.trimBox, { x: 15, y: 15, width: 600, height: 1800 });
});

test("A4 dengan bleed menggambar tanda potong", async () => {
  const sizes: { width: number; height: number }[] = [];
  const draws: string[] = [];

  const result = await exportPrintSheet(defaultStripTemplate({ now: NOW }), preset("a4"), deps(sizes, draws), {
    now: NOW,
    includeBleed: true,
  });

  assert.equal(result.plan.cutMarks.length, 8);
  assert.equal(draws.filter((op) => op === "stroke").length, 1);
});

test("nama berkas ditandai cetak + preset + ukuran piksel", () => {
  const pixels = { width: 1200, height: 1800 };
  const filename = sheetFilename(defaultStripTemplate({ now: NOW }), preset("4x6"), pixels, "png", NOW);

  assert.match(filename, /-cetak-4x6-1200x1800\.png$/);
  assert.match(filename, /^[a-z0-9.-]+$/, "nama berkas harus aman untuk filesystem");
});

test("nama berkas bleed dibedakan dari yang tanpa bleed", () => {
  const pixels = { width: 630, height: 1830 };
  const withBleed = sheetFilename(defaultStripTemplate({ now: NOW }), preset("2x6"), pixels, "png", NOW, {
    includeBleed: true,
  });

  assert.match(withBleed, /-cetak-2x6-bleed-630x1830\.png$/);
});

test("nama berkas tidak tertukar dengan export template", () => {
  const pixels = { width: 600, height: 1800 };
  const sheet = sheetFilename(defaultStripTemplate({ now: NOW }), preset("2x6"), pixels, "png", NOW);

  assert.ok(sheet.includes("-cetak-2x6-"), "penanda cetak wajib ada");
  assert.notEqual(sheet, exportFilename("strip 2×6", {}, pixels, "png", NOW));
});

test("format jpeg memakai ekstensi .jpg", async () => {
  const sizes: { width: number; height: number }[] = [];
  const draws: string[] = [];

  const result = await exportPrintSheet(defaultStripTemplate({ now: NOW }), preset("2x6"), deps(sizes, draws), {
    now: NOW,
    format: "jpeg",
  });

  assert.equal(result.format, "jpeg");
  assert.match(result.filename, /\.jpg$/);
});

test("canvas tanpa convertToBlob maupun toBlob → ExportError, bukan crash", async () => {
  const sizes: { width: number; height: number }[] = [];
  const draws: string[] = [];
  const createCanvas = fakeCanvas(sizes, draws);

  const broken: ExportDeps = {
    createCanvas: (width, height) => {
      const canvas = createCanvas(width, height);
      return {
        width: canvas.width,
        height: canvas.height,
        getContext: canvas.getContext.bind(canvas),
      };
    },
  };

  await assert.rejects(
    () => exportPrintSheet(defaultStripTemplate({ now: NOW }), preset("2x6"), broken, { now: NOW }),
    (error: unknown) => error instanceof ExportError,
  );
});
