/**
 * Tes renderer template.
 *
 * Renderer diuji dengan context palsu yang **mencatat panggilan**, jadi yang
 * diperiksa adalah angka: ukuran canvas, jumlah frame yang benar-benar
 * tergambar, dan isi teks setelah token disubstitusi. Tidak ada tes
 * "kelihatan bagus" di sini — itu urusan validasi bitmap di Playwright.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultStripTemplate } from "./model.ts";
import { cssFont, renderTemplate, wrapText, type DrawTarget } from "./render.ts";

interface Call {
  op: string;
  args: number[];
}

class RecordingContext implements DrawTarget {
  readonly calls: Call[] = [];
  readonly texts: string[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = "#000";
  strokeStyle: string | CanvasGradient | CanvasPattern = "#000";
  lineWidth = 1;
  textAlign: CanvasTextAlign = "start";
  textBaseline: CanvasTextBaseline = "alphabetic";
  /** Lebar karakter palsu: 0.5 × fontSize. */
  private fontSize = 10;
  private fontValue = "10px sans-serif";

  get font(): string {
    return this.fontValue;
  }

  set font(value: string) {
    this.fontValue = value;
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) this.fontSize = parsed;
  }

  private record(op: string, ...args: number[]): void {
    this.calls.push({ op, args });
  }

  save(): void {
    this.record("save");
  }
  restore(): void {
    this.record("restore");
  }
  translate(x: number, y: number): void {
    this.record("translate", x, y);
  }
  rotate(angle: number): void {
    this.record("rotate", angle);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.record("fillRect", x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.record("strokeRect", x, y, w, h);
  }
  fillText(text: string, x: number, y: number): void {
    this.texts.push(text);
    this.record("fillText", x, y);
  }
  strokeText(text: string, x: number, y: number): void {
    this.record("strokeText", x, y);
  }
  measureText(text: string): { width: number } {
    return { width: text.length * this.fontSize * 0.5 };
  }
  drawImage(...args: unknown[]): void {
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = args as number[];
    this.record("drawImage", sx!, sy!, sw!, sh!, dx!, dy!, dw!, dh!);
  }

  ops(op: string): Call[] {
    return this.calls.filter((call) => call.op === op);
  }
}

const NOW = new Date("2026-10-12T19:30:00Z");

test("renderTemplate mengisi latar seukuran canvas cetak", () => {
  const ctx = new RecordingContext();
  const template = defaultStripTemplate({ now: NOW });

  const stats = renderTemplate(ctx, template);

  assert.equal(stats.width, 600);
  assert.equal(stats.height, 1800);
  assert.deepEqual(ctx.ops("fillRect")[0]?.args, [0, 0, 600, 1800]);
});

test("frame tanpa gambar tetap digambar sebagai slot kosong", () => {
  const ctx = new RecordingContext();
  const template = defaultStripTemplate({ count: 3, now: NOW });

  const stats = renderTemplate(ctx, template);

  assert.equal(stats.framesDrawn, 0, "tidak ada gambar = tidak ada frame terisi");
  assert.equal(ctx.ops("fillRect").length, 1 + 3, "latar + 3 slot kosong");
  assert.equal(ctx.ops("drawImage").length, 0);
});

test("frame dengan gambar digambar cover, bukan diregangkan", () => {
  const ctx = new RecordingContext();
  const template = defaultStripTemplate({ count: 1, now: NOW });
  const frame = template.frames[0]!;

  const stats = renderTemplate(ctx, template, {
    frames: [{ image: {} as CanvasImageSource, width: 1600, height: 1200 }],
  });

  assert.equal(stats.framesDrawn, 1);

  const draw = ctx.ops("drawImage")[0];
  assert.ok(draw !== undefined);
  const [, , sw, sh, , , dw, dh] = draw.args;
  assert.equal(dw, frame.width, "lebar tujuan = lebar frame");
  assert.equal(dh, frame.height, "tinggi tujuan = tinggi frame");
  assert.ok(sw! <= 1600 && sh! <= 1200, "sumber tidak boleh melebihi gambar");
});

test("teks digambar dengan token sudah disubstitusi", () => {
  const ctx = new RecordingContext();
  const template = defaultStripTemplate({ now: NOW });

  const stats = renderTemplate(ctx, template, {
    tokens: { event: "Pesta Ulang Tahun", date: "12 Oktober 2026", time: "19:30" },
  });

  assert.equal(stats.textsDrawn, 2);
  assert.deepEqual(stats.renderedTexts, ["Pesta Ulang Tahun", "12 Oktober 2026 · 19:30"]);
  assert.ok(ctx.texts.includes("Pesta Ulang Tahun"), "teks harus benar-benar digambar");
  assert.equal(ctx.texts.join(" ").includes("{"), false, "tidak boleh ada token tersisa di bitmap");
});

test("teks tanpa nilai token jadi kosong, bukan token mentah", () => {
  const ctx = new RecordingContext();
  const template = defaultStripTemplate({ count: 1, now: NOW });

  const stats = renderTemplate(ctx, template);

  assert.equal(stats.renderedTexts.join("").includes("{"), false);
});

test("teks digambar setelah frame supaya tidak tertutup foto", () => {
  const ctx = new RecordingContext();
  const template = defaultStripTemplate({ count: 1, now: NOW });

  renderTemplate(ctx, template, {
    frames: [{ image: {} as CanvasImageSource, width: 600, height: 600 }],
    tokens: { event: "X" },
  });

  const firstDrawImage = ctx.calls.findIndex((call) => call.op === "drawImage");
  const firstFillText = ctx.calls.findIndex((call) => call.op === "fillText");
  assert.ok(firstDrawImage !== -1 && firstFillText !== -1);
  assert.ok(firstFillText > firstDrawImage, "teks harus digambar setelah gambar");
});

test("sticker tanpa gambar dilewati tanpa error", () => {
  const ctx = new RecordingContext();
  const template = defaultStripTemplate({ count: 1, now: NOW });
  const withSticker = {
    ...template,
    stickers: [{ id: "st_1", src: "x.png", x: 10, y: 10, width: 50, height: 50, rotation: 0 }],
  };

  const stats = renderTemplate(ctx, withSticker);
  assert.equal(stats.stickersDrawn, 0);
});

test("sticker dengan gambar dihitung", () => {
  const ctx = new RecordingContext();
  const template = defaultStripTemplate({ count: 1, now: NOW });
  const withSticker = {
    ...template,
    stickers: [{ id: "st_1", src: "x.png", x: 10, y: 10, width: 50, height: 50, rotation: 0 }],
  };

  const stats = renderTemplate(ctx, withSticker, {
    stickers: { st_1: { image: {} as CanvasImageSource, width: 100, height: 100 } },
  });
  assert.equal(stats.stickersDrawn, 1);
});

test("rotasi frame menghasilkan rotate yang benar (90° = π/2)", () => {
  const ctx = new RecordingContext();
  const template = defaultStripTemplate({ count: 1, now: NOW });
  const rotated = {
    ...template,
    frames: [{ ...template.frames[0]!, rotation: 90 }],
  };

  renderTemplate(ctx, rotated, {
    frames: [{ image: {} as CanvasImageSource, width: 600, height: 600 }],
  });

  const rotate = ctx.ops("rotate")[0];
  assert.ok(rotate !== undefined);
  assert.ok(Math.abs(rotate.args[0]! - Math.PI / 2) < 1e-9);
});

test("wrapText memecah kalimat panjang jadi beberapa baris", () => {
  const ctx = new RecordingContext();
  ctx.font = "20px sans-serif";
  // Lebar palsu: 10 px per karakter.
  const lines = wrapText(ctx, "satu dua tiga empat lima enam", 100);
  assert.ok(lines.length > 1, `harus pecah, dapat: ${JSON.stringify(lines)}`);
  assert.equal(lines.join(" "), "satu dua tiga empat lima enam", "isi tidak boleh hilang");
});

test("wrapText tidak memecah satu kata yang lebih panjang dari kotak", () => {
  const ctx = new RecordingContext();
  ctx.font = "20px sans-serif";
  assert.deepEqual(wrapText(ctx, "supercalifragilistic", 50), ["supercalifragilistic"]);
});

test("wrapText pada teks kosong mengembalikan satu baris kosong", () => {
  const ctx = new RecordingContext();
  assert.deepEqual(wrapText(ctx, "", 100), [""]);
});

test("cssFont memakai ukuran & keluarga dari elemen teks", () => {
  assert.equal(cssFont({ fontSize: 46, fontFamily: "Inter, sans-serif" }), "46px Inter, sans-serif");
});
