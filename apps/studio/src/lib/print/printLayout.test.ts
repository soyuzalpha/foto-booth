/**
 * Tes render lembar cetak.
 *
 * Yang diuji di sini bukan "gambar terlihat bagus", tapi **angka**:
 * ukuran kanvas lembar, di mana template ditempelkan, skala yang dipakai, dan
 * apakah template benar-benar digambar (bukan cuma direncanakan).
 *
 * Kalau `planPrintSheet` benar tapi `renderPrintSheet` tidak menggambar apa
 * pun, hasilnya kertas putih — dan itu baru ketahuan setelah dicetak. Jadi
 * `renderPrintSheet` diperiksa lewat jejak perintah canvas.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { printPresetById, type PrintPreset } from "@foto-booth/shared";

import { defaultStripTemplate } from "../template/model.ts";
import { planPrintSheet, printSheetPlanSummary, renderPrintSheet, type PrintTarget } from "./printLayout.ts";

const NOW = new Date("2026-10-12T19:30:00Z");

/** Target canvas palsu yang mencatat setiap perintah. */
interface Recorder extends PrintTarget {
  ops: string[];
  scales: { x: number; y: number }[];
  translates: { x: number; y: number }[];
  fillRects: { x: number; y: number; w: number; h: number }[];
  lineSegments: { x1: number; y1: number; x2: number; y2: number }[];
  drawImages: number;
  fillTexts: string[];
  pending: { x: number; y: number } | null;
}

function recorder(): Recorder {
  const ops: string[] = [];
  const rec: Recorder = {
    ops,
    scales: [],
    translates: [],
    fillRects: [],
    lineSegments: [],
    drawImages: 0,
    fillTexts: [],
    pending: null,
    save() { ops.push("save"); },
    restore() { ops.push("restore"); },
    translate(x, y) { ops.push("translate"); rec.translates.push({ x, y }); },
    rotate() { ops.push("rotate"); },
    scale(x, y) { ops.push("scale"); rec.scales.push({ x, y }); },
    fillRect(x, y, w, h) { ops.push("fillRect"); rec.fillRects.push({ x, y, w, h }); },
    strokeRect() { ops.push("strokeRect"); },
    fillText(text) { ops.push("fillText"); rec.fillTexts.push(text); },
    strokeText() { ops.push("strokeText"); },
    measureText: (text: string) => ({ width: text.length * 8 }),
    drawImage() { ops.push("drawImage"); rec.drawImages += 1; },
    beginPath() { ops.push("beginPath"); },
    moveTo(x, y) { ops.push("moveTo"); rec.pending = { x, y }; },
    lineTo(x, y) {
      ops.push("lineTo");
      const from = rec.pending;
      if (from !== null) rec.lineSegments.push({ x1: from.x, y1: from.y, x2: x, y2: y });
    },
    stroke() { ops.push("stroke"); },
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    font: "10px sans-serif",
    textAlign: "start" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    shadowColor: "rgba(0, 0, 0, 0)",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    createRadialGradient() {
      ops.push("createRadialGradient");
      return { addColorStop() {} } as unknown as CanvasGradient;
    },
  };
  return rec;
}

function preset(id: string): PrintPreset {
  const found = printPresetById(id);
  assert.ok(found !== null, `preset ${id} tidak ada`);
  return found;
}

test("rencana 2×6: lembar 600×1800, template pas penuh di trim", () => {
  const plan = planPrintSheet(defaultStripTemplate({ now: NOW }), preset("2x6"));

  assert.equal(plan.width, 600);
  assert.equal(plan.height, 1800);
  assert.deepEqual(plan.trimBox, { x: 0, y: 0, width: 600, height: 1800 });
  assert.deepEqual(plan.templateBox, { x: 0, y: 0, width: 600, height: 1800 });
  assert.equal(plan.scale, 1);
});

test("rencana 4×6 untuk template strip: tinggi penuh, sisa kertas jadi margin", () => {
  const plan = planPrintSheet(defaultStripTemplate({ now: NOW }), preset("4x6"));

  assert.equal(plan.width, 1200);
  assert.equal(plan.height, 1800);
  // Template 600×1800 di area 1200×1800 → tinggi penentu, skala 1.
  assert.equal(plan.templateBox.height, 1800);
  assert.equal(plan.templateBox.width, 600);
  assert.equal(plan.templateBox.x, 300, "sisa 600 dibagi dua");
});

test("bleed memperbesar lembar dan menggeser trim", () => {
  const plan = planPrintSheet(defaultStripTemplate({ now: NOW }), preset("2x6"), {
    includeBleed: true,
  });

  assert.equal(plan.width, 630);
  assert.equal(plan.height, 1830);
  assert.deepEqual(plan.trimBox, { x: 15, y: 15, width: 600, height: 1800 });
  assert.equal(plan.scale, 1);
});

test("mode safe memasangkan template ke area aman, bukan trim", () => {
  const plan = planPrintSheet(defaultStripTemplate({ now: NOW }), preset("2x6"), { fit: "safe" });

  // Area aman 528×1728; template 1:3 → lebar penentu, sisa tinggi jadi margin.
  assert.deepEqual(plan.templateBox, { x: 36, y: 108, width: 528, height: 1584 });
  assert.ok(plan.scale < 1, "area aman selalu menyusutkan template");
  assert.equal(plan.scale, 0.88);
});

test("render menggambar kertas + template, dengan skala seragam", () => {
  const ctx = recorder();
  const frame = { image: {} as CanvasImageSource, width: 640, height: 480 };
  const result = renderPrintSheet(ctx, defaultStripTemplate({ now: NOW }), preset("2x6"), {
    tokens: { event: "Pesta" },
    frames: [frame, frame, frame, frame],
  });

  assert.equal(result.width, 600);
  assert.equal(result.height, 1800);
  assert.deepEqual(ctx.fillRects[0], { x: 0, y: 0, w: 600, h: 1800 }, "kertas digambar penuh");
  assert.deepEqual(ctx.scales[0], { x: 1, y: 1 });
  assert.ok(ctx.ops.includes("drawImage"), "frame harus benar-benar digambar");
  assert.ok(result.stats.renderedTexts.length > 0, "teks template harus ikut");
});

test("skala x dan y selalu sama — tidak pernah distorsi", () => {
  const ctx = recorder();
  renderPrintSheet(ctx, defaultStripTemplate({ now: NOW }), preset("4x6"));

  for (const scale of ctx.scales) {
    assert.equal(scale.x, scale.y, "skala x dan y beda → gambar melebar");
  }
});

test("tanda potong A4 digambar sebagai 8 segmen", () => {
  const ctx = recorder();
  const result = renderPrintSheet(ctx, defaultStripTemplate({ now: NOW }), preset("a4"), {
    includeBleed: true,
  });

  assert.equal(result.cutMarks.length, 8);
  assert.equal(ctx.lineSegments.length, 8);
});

test("strip 2×6 tidak menggambar tanda potong", () => {
  const ctx = recorder();
  const result = renderPrintSheet(ctx, defaultStripTemplate({ now: NOW }), preset("2x6"), {
    includeBleed: true,
  });

  assert.deepEqual(result.cutMarks, []);
  assert.equal(ctx.lineSegments.length, 0);
});

test("setiap save diimbangi restore — tidak ada state canvas bocor", () => {
  const ctx = recorder();
  renderPrintSheet(ctx, defaultStripTemplate({ now: NOW }), preset("a4"), { includeBleed: true });

  const saves = ctx.ops.filter((op) => op === "save").length;
  const restores = ctx.ops.filter((op) => op === "restore").length;
  assert.equal(saves, restores);
});

test("ringkasan rencana memuat angka yang bisa dibandingkan validator", () => {
  const summary = printSheetPlanSummary(planPrintSheet(defaultStripTemplate({ now: NOW }), preset("2x6")));
  assert.equal(summary, "sheet=600x1800 template=600x1800 at=0,0 scale=1.0000");
});
