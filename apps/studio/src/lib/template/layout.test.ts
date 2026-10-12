/**
 * Tes geometri template.
 *
 * Semua angka di sini bisa diperiksa tangan — dan memang harus: kalau
 * `stripLayout` salah satu piksel saja, hasil cetak 300 dpi kelihatan
 * miring, dan itu baru ketahuan setelah kertas terbuang.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_STRIP_LAYOUT,
  boxFits,
  clampBox,
  coverCrop,
  footerBox,
  parseRatio,
  stripLayout,
} from "./layout.ts";

const STRIP_2X6 = { width: 600, height: 1800 };

test("6 frame dalam strip 600×1800: semua muat, tidak saling tumpang", () => {
  const boxes = stripLayout(STRIP_2X6, 6);
  assert.equal(boxes.length, 6);

  for (const box of boxes) {
    assert.ok(boxFits(box, STRIP_2X6), `frame ${box.y} keluar dari canvas`);
    assert.ok(box.width > 0 && box.height > 0);
  }

  for (let index = 1; index < boxes.length; index += 1) {
    const previous = boxes[index - 1];
    const current = boxes[index];
    assert.ok(previous !== undefined && current !== undefined);
    assert.ok(
      current.y >= previous.y + previous.height,
      `frame ${index} mulai sebelum frame ${index - 1} selesai`,
    );
  }
});

test("frame terakhir menyerap sisa pembulatan — dasar strip rata", () => {
  const boxes = stripLayout(STRIP_2X6, 6);
  const last = boxes.at(-1);
  assert.ok(last !== undefined);

  const bottom = last.y + last.height;
  const expected = STRIP_2X6.height - DEFAULT_STRIP_LAYOUT.margin - DEFAULT_STRIP_LAYOUT.footerHeight;
  assert.equal(bottom, expected, "frame terakhir harus mentok di atas footer");
});

test("tinggi frame dibulatkan ke bawah, bukan ke atas", () => {
  const boxes = stripLayout({ width: 600, height: 1000 }, 3, { margin: 10, gap: 7, footerHeight: 40 });
  // available = 1000 - 20 - 40 - 14 = 926 → floor(926/3) = 308
  assert.equal(boxes[0]?.height, 308);
  assert.equal(boxes[2]?.height, 926 - 308 * 2, "frame terakhir menyerap 2 piksel sisa");
});

test("count 0 atau ruang habis → tidak ada frame, bukan angka negatif", () => {
  assert.deepEqual(stripLayout(STRIP_2X6, 0), []);
  assert.deepEqual(stripLayout({ width: 40, height: 60 }, 4), []);
});

test("footerBox ada di bawah frame terakhir", () => {
  const boxes = stripLayout(STRIP_2X6, 6);
  const last = boxes.at(-1);
  const footer = footerBox(STRIP_2X6, 6);
  assert.ok(last !== undefined);

  assert.ok(footer.y >= last.y + last.height, "footer tidak boleh menimpa frame");
  assert.equal(footer.height, DEFAULT_STRIP_LAYOUT.footerHeight - DEFAULT_STRIP_LAYOUT.gap);
  assert.equal(footer.width, STRIP_2X6.width - DEFAULT_STRIP_LAYOUT.margin * 2);
});

test("parseRatio menerima \"4:5\" dan menolak sampah", () => {
  assert.equal(parseRatio("4:5"), 0.8);
  assert.equal(parseRatio("16:9"), 16 / 9);
  assert.equal(parseRatio(undefined), null);
  assert.equal(parseRatio(""), null);
  assert.equal(parseRatio("4"), null);
  assert.equal(parseRatio("0:5"), null);
  assert.equal(parseRatio("a:b"), null);
});

test("coverCrop mengisi kotak tanpa distorsi, sisa dipotong tengah", () => {
  // Foto 1600×1200 (4:3) ke kotak 600×600 (1:1) → potong kiri-kanan.
  const crop = coverCrop(1600, 1200, { x: 0, y: 0, width: 600, height: 600 }, undefined);

  assert.equal(crop.sh, 1200, "tinggi penuh");
  assert.equal(crop.sw, 1200, "lebar = tinggi × 1");
  assert.equal(crop.sy, 0);
  assert.equal(crop.sx, 200, "sisa 400 dibagi dua");
});

test("coverCrop menghormati aspectRatio frame", () => {
  const crop = coverCrop(1600, 1200, { x: 0, y: 0, width: 600, height: 750 }, "4:5");
  const ratio = crop.sw / crop.sh;
  assert.ok(Math.abs(ratio - 0.8) < 0.001, `rasio ${ratio} harus 0.8`);
});

test("coverCrop tidak pernah melebihi gambar asli", () => {
  const crop = coverCrop(1920, 1080, { x: 0, y: 0, width: 600, height: 1800 }, undefined);
  assert.ok(crop.sw <= 1920 && crop.sh <= 1080);
  assert.ok(crop.sx >= 0 && crop.sy >= 0);
});

test("clampBox menarik elemen yang keluar canvas kembali ke dalam", () => {
  const clamped = clampBox({ x: 700, y: -50, width: 100, height: 100 }, STRIP_2X6);
  assert.deepEqual(clamped, { x: 500, y: 0, width: 100, height: 100 });
});

test("clampBox tidak mengubah elemen yang sudah di dalam", () => {
  const inside = { x: 10, y: 10, width: 100, height: 100 };
  assert.deepEqual(clampBox(inside, STRIP_2X6), inside);
});
