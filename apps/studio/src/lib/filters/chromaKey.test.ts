/**
 * Tes chroma key.
 *
 * Inti yang diuji: warna kunci jadi tembus, warna lain tetap; similarity
 * memperluas jangkauan; smoothness membuat gradasi tepi; spill hanya
 * **menurunkan** kelebihan kanal kunci, tidak pernah menaikkannya.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { chromaKeyAlpha, dominantChannel, suppressSpill } from "./chromaKey.ts";
import type { ChromaKeySettings } from "./types.ts";

const KEY: ChromaKeySettings = {
  enabled: true,
  color: { r: 0, g: 255, b: 0 },
  similarity: 35,
  smoothness: 15,
  spill: 50,
};

test("nonaktif → alpha selalu 1 (tidak menebak)", () => {
  assert.equal(chromaKeyAlpha(0, 255, 0, { ...KEY, enabled: false }), 1);
});

test("warna kunci persis → alpha 0 (tembus)", () => {
  assert.equal(chromaKeyAlpha(0, 255, 0, KEY), 0);
});

test("putih → alpha 1 (subjek tetap)", () => {
  assert.ok(chromaKeyAlpha(255, 255, 255, KEY) > 0.99);
});

test("warna kulit tetap, tidak ikut ter-key", () => {
  // (222, 170, 140) — rona kulit; harus tetap tampil penuh.
  assert.ok(chromaKeyAlpha(222, 170, 140, KEY) > 0.99);
});

test("similarity naik → makin banyak warna dianggap latar", () => {
  const near = { r: 60, g: 200, b: 60 };
  const rendah = chromaKeyAlpha(near.r, near.g, near.b, { ...KEY, similarity: 10, smoothness: 0 });
  const tinggi = chromaKeyAlpha(near.r, near.g, near.b, { ...KEY, similarity: 60, smoothness: 0 });

  assert.equal(rendah, 1, "similarity kecil → tetap tampil");
  assert.ok(tinggi <= rendah);
  assert.ok(tinggi < 1, "similarity besar → ikut tembus");
});

test("smoothness menghasilkan gradasi tepi (0 < alpha < 1)", () => {
  const alpha = chromaKeyAlpha(60, 200, 60, { ...KEY, similarity: 5, smoothness: 60 });
  assert.ok(alpha > 0 && alpha < 1, `alpha ${alpha} harus di antara 0 dan 1`);
});

test("dominantChannel", () => {
  assert.equal(dominantChannel({ r: 0, g: 255, b: 0 }), "g");
  assert.equal(dominantChannel({ r: 0, g: 0, b: 255 }), "b");
  assert.equal(dominantChannel({ r: 255, g: 0, b: 0 }), "r");
});

test("spill 100 → kelebihan hijau dihilangkan sampai batas kanal lain", () => {
  const out = suppressSpill(100, 200, 100, { ...KEY, spill: 100 });
  assert.equal(Math.round(out.g), 100);
  assert.equal(out.r, 100);
  assert.equal(out.b, 100);
});

test("spill 0 → piksel tidak berubah", () => {
  assert.deepEqual(suppressSpill(100, 200, 100, { ...KEY, spill: 0 }), { r: 100, g: 200, b: 100 });
});

test("piksel tanpa kelebihan hijau tidak pernah dinaikkan", () => {
  assert.deepEqual(suppressSpill(200, 150, 100, { ...KEY, spill: 100 }), {
    r: 200,
    g: 150,
    b: 100,
  });
});

test("spill pada kunci biru menekan kanal biru", () => {
  const blue = { ...KEY, color: { r: 0, g: 0, b: 255 } };
  const out = suppressSpill(100, 120, 210, { ...blue, spill: 100 });
  assert.equal(Math.round(out.b), 120, "biru turun ke max(r,g)");
});
