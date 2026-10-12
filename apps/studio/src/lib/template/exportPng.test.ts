/**
 * Tes export gambar.
 *
 * Yang paling penting: **resolusi cetak**. Canvas harus dibuat pada ukuran
 * piksel penuh (inci × dpi), bukan ukuran pratinjau — kalau tidak, berkasnya
 * tetap "PNG" tapi hasil cetaknya pecah, dan itu baru ketahuan di printer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ExportError, exportTemplate, type ExportCanvas, type ExportDeps } from "./exportPng.ts";
import { defaultStripTemplate } from "./model.ts";

const NOW = new Date("2026-10-12T19:30:00Z");

interface FakeCanvas extends ExportCanvas {
  created: { width: number; height: number };
  blobOptions: { type?: string; quality?: number } | null;
}

function fakeDeps(): { deps: ExportDeps; canvases: FakeCanvas[] } {
  const canvases: FakeCanvas[] = [];

  const deps: ExportDeps = {
    createCanvas(width, height) {
      const canvas = {
        width,
        height,
        created: { width, height },
        blobOptions: null as { type?: string; quality?: number } | null,
        getContext() {
          return {
            save() {},
            restore() {},
            translate() {},
            rotate() {},
            fillRect() {},
            strokeRect() {},
            fillText() {},
            strokeText() {},
            measureText: (text: string) => ({ width: text.length * 10 }),
            drawImage() {},
            fillStyle: "#000",
            strokeStyle: "#000",
            lineWidth: 1,
            font: "10px sans-serif",
            textAlign: "start" as CanvasTextAlign,
            textBaseline: "alphabetic" as CanvasTextBaseline,
          };
        },
        async convertToBlob(options?: { type?: string; quality?: number }) {
          canvas.blobOptions = options ?? null;
          return new Blob([new Uint8Array(2048)], { type: options?.type ?? "image/png" });
        },
      } satisfies FakeCanvas;
      canvases.push(canvas);
      return canvas;
    },
  };

  return { deps, canvases };
}

test("export 2×6 @300 dpi menghasilkan canvas 600×1800, bukan ukuran pratinjau", async () => {
  const { deps, canvases } = fakeDeps();
  const template = defaultStripTemplate({ now: NOW });

  const result = await exportTemplate(template, deps, { tokens: { event: "Pesta" }, now: NOW });

  assert.equal(result.width, 600);
  assert.equal(result.height, 1800);
  assert.deepEqual(canvases[0]?.created, { width: 600, height: 1800 });
});

test("export 4×6 @300 dpi menghasilkan canvas 1200×1800", async () => {
  const { deps } = fakeDeps();
  const template = defaultStripTemplate({ presetId: "4x6", now: NOW });

  const result = await exportTemplate(template, deps, { now: NOW });

  assert.equal(result.width, 1200);
  assert.equal(result.height, 1800);
});

test("nama berkas rapi dan memuat ukuran piksel", async () => {
  const { deps } = fakeDeps();
  const template = defaultStripTemplate({ name: "Strip 2×6", now: NOW });

  const result = await exportTemplate(template, deps, {
    tokens: { event: "Pesta Ulang Tahun" },
    now: NOW,
  });

  assert.equal(result.filename, "strip-2-6-pesta-ulang-tahun-2026-10-12-600x1800.png");
});

test("format JPEG memakai mime & kualitas yang benar", async () => {
  const { deps, canvases } = fakeDeps();
  const template = defaultStripTemplate({ now: NOW });

  const result = await exportTemplate(template, deps, { format: "jpeg", quality: 0.8, now: NOW });

  assert.equal(result.format, "jpeg");
  assert.equal(canvases[0]?.blobOptions?.type, "image/jpeg");
  assert.equal(canvases[0]?.blobOptions?.quality, 0.8);
  assert.match(result.filename, /\.jpeg$/);
});

test("nama berkas unik: bentrok dapat akhiran -2", async () => {
  const { deps } = fakeDeps();
  const template = defaultStripTemplate({ now: NOW });
  const taken = new Set(["strip-2-6-2026-10-12-600x1800.png"]);

  const result = await exportTemplate(
    { ...template, name: "Strip 2×6" },
    { ...deps, exists: (filename) => taken.has(filename) },
    { now: NOW },
  );

  assert.equal(result.filename, "strip-2-6-2026-10-12-600x1800-2.png");
});

test("template kebesaran ditolak sebelum canvas dibuat", async () => {
  const { deps, canvases } = fakeDeps();
  const template = defaultStripTemplate({ now: NOW });
  const huge = { ...template, size: { ...template.size, width: 30, height: 30, dpi: 600 } };

  await assert.rejects(() => exportTemplate(huge, deps, { now: NOW }), ExportError);
  assert.equal(canvases.length, 0, "canvas tidak boleh dibuat untuk template kebesaran");
});

test("canvas tanpa convertToBlob/toBlob melempar pesan yang jelas", async () => {
  const deps: ExportDeps = {
    createCanvas(width, height) {
      return {
        width,
        height,
        getContext: () => ({
          save() {},
          restore() {},
          translate() {},
          rotate() {},
          fillRect() {},
          strokeRect() {},
          fillText() {},
          strokeText() {},
          measureText: () => ({ width: 0 }),
          drawImage() {},
          fillStyle: "#000",
          strokeStyle: "#000",
          lineWidth: 1,
          font: "10px sans-serif",
          textAlign: "start" as CanvasTextAlign,
          textBaseline: "alphabetic" as CanvasTextBaseline,
        }),
      };
    },
  };

  const template = defaultStripTemplate({ now: NOW });
  await assert.rejects(() => exportTemplate(template, deps, { now: NOW }), /convertToBlob/);
});

test("ukuran blob dilaporkan apa adanya", async () => {
  const { deps } = fakeDeps();
  const template = defaultStripTemplate({ now: NOW });
  const result = await exportTemplate(template, deps, { now: NOW });
  assert.equal(result.bytes, 2048);
  assert.ok(result.blob.size > 0);
});
