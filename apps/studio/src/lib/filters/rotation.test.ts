/**
 * Tes rotasi.
 *
 * Yang paling penting: 90/270 **menukar** lebar & tinggi, dan matriks
 * transform memetakan sudut gambar ke sudut kanvas dengan benar (tidak
 * terpotong, tidak ada bilah hitam).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeRotation, rotatedSize, rotationTransform } from "./rotation.ts";

test("normalizeRotation menynap ke 0/90/180/270", () => {
  assert.equal(normalizeRotation(0), 0);
  assert.equal(normalizeRotation(90), 90);
  assert.equal(normalizeRotation(180), 180);
  assert.equal(normalizeRotation(270), 270);
  assert.equal(normalizeRotation(450), 90, "450 = 90 + 360");
  assert.equal(normalizeRotation(-90), 270, "berputar ke belakang");
  assert.equal(normalizeRotation(44), 0);
  assert.equal(normalizeRotation(46), 90);
  assert.equal(normalizeRotation(Number.NaN), 0);
});

test("rotatedSize menukar sisi pada 90 & 270", () => {
  assert.deepEqual(rotatedSize(1920, 1080, 0), { width: 1920, height: 1080 });
  assert.deepEqual(rotatedSize(1920, 1080, 90), { width: 1080, height: 1920 });
  assert.deepEqual(rotatedSize(1920, 1080, 180), { width: 1920, height: 1080 });
  assert.deepEqual(rotatedSize(1920, 1080, 270), { width: 1080, height: 1920 });
});

test("transform 90° memetakan sudut gambar ke sudut kanvas", () => {
  const t = rotationTransform(90, 1920, 1080);
  const map = (x: number, y: number) => ({ x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f });

  assert.deepEqual(map(0, 0), { x: 1080, y: 0 }, "kiri-atas → kanan-atas");
  assert.deepEqual(map(1920, 0), { x: 1080, y: 1920 }, "kanan-atas → kanan-bawah");
  assert.deepEqual(map(0, 1080), { x: 0, y: 0 }, "kiri-bawah → kiri-atas");
});

test("transform 180° membalik kedua sumbu", () => {
  const t = rotationTransform(180, 800, 600);
  const map = (x: number, y: number) => ({ x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f });

  assert.deepEqual(map(0, 0), { x: 800, y: 600 });
  assert.deepEqual(map(800, 600), { x: 0, y: 0 });
});

test("transform 0° = identitas", () => {
  assert.deepEqual(rotationTransform(0, 640, 480), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
});

test("transform selalu memetakan ke dalam kanvas keluaran", () => {
  for (const deg of [0, 90, 180, 270] as const) {
    const w = 1920;
    const h = 1080;
    const out = rotatedSize(w, h, deg);
    const t = rotationTransform(deg, w, h);
    const corners: [number, number][] = [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ];
    for (const [x, y] of corners) {
      const px = t.a * x + t.c * y + t.e;
      const py = t.b * x + t.d * y + t.f;
      assert.ok(px >= 0 && px <= out.width, `${deg}°: x=${px} di luar 0..${out.width}`);
      assert.ok(py >= 0 && py <= out.height, `${deg}°: y=${py} di luar 0..${out.height}`);
    }
  }
});
