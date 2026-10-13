import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SHUTTER_OFFSET_MS,
  SHUTTER_OFFSET_STEP_MS,
  describeShutterOffset,
  normalizeShutterOffset,
  shutterGrabDue,
  shutterRemainingMs,
} from "./shutterOffset.ts";

test("normalizeShutterOffset menjepit ke rentang dan membulatkan ke langkah", () => {
  assert.equal(normalizeShutterOffset(0), 0);
  assert.equal(normalizeShutterOffset(300), 300);
  // 320 → langkah 50 terdekat = 300.
  assert.equal(normalizeShutterOffset(320), 300);
  // 330 → langkah 50 terdekat = 350.
  assert.equal(normalizeShutterOffset(330), 350);
  assert.equal(normalizeShutterOffset(-100), 0);
  assert.equal(normalizeShutterOffset(MAX_SHUTTER_OFFSET_MS + 5000), MAX_SHUTTER_OFFSET_MS);
});

test("normalizeShutterOffset memperlakukan NaN sebagai 0 (bukan crash)", () => {
  assert.equal(normalizeShutterOffset(Number.NaN), 0);
  assert.equal(normalizeShutterOffset(Number.POSITIVE_INFINITY), 0);
});

test("offset 0 berarti frame diambil tepat saat hitungan menyentuh nol", () => {
  assert.equal(shutterGrabDue(0, 0), true);
  assert.equal(shutterRemainingMs(0, 0), 0);
});

test("offset menahan pengambilan frame sampai jeda terlewat", () => {
  const offset = 300;
  assert.equal(shutterGrabDue(299, offset), false);
  assert.equal(shutterGrabDue(300, offset), true);
  assert.equal(shutterGrabDue(301, offset), true);
  assert.equal(shutterRemainingMs(100, offset), 200);
  assert.equal(shutterRemainingMs(300, offset), 0);
  assert.equal(shutterRemainingMs(500, offset), 0);
});

test("offset yang belum ternormalisasi tetap dihormati saat keputusan diambil", () => {
  // 999 dijepit ke MAX; jadi jeda 1999 ms belum boleh jepret, 2000 boleh.
  assert.equal(shutterGrabDue(1999, 999_999), false);
  assert.equal(shutterGrabDue(2000, 999_999), true);
});

test("describeShutterOffset memberi label yang bisa dibaca operator", () => {
  assert.equal(describeShutterOffset(0), "tidak ada");
  assert.equal(describeShutterOffset(300), "0,3 dtk");
  assert.equal(describeShutterOffset(1000), "1 dtk");
  assert.equal(describeShutterOffset(1500), "1,5 dtk");
});

test("SHUTTER_OFFSET_STEP_MS membagi habis MAX (slider tidak mentok di angka aneh)", () => {
  assert.equal(MAX_SHUTTER_OFFSET_MS % SHUTTER_OFFSET_STEP_MS, 0);
});
