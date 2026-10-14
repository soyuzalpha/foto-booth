/**
 * Tes animasi slideshow & boomerang.
 *
 * Yang dijaga: boomerang tidak mengulang ujung (tidak "tersendat" di titik
 * balik), satu foto tidak menghasilkan animasi palsu, dan timeline-nya berurutan
 * tanpa celah waktu.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  animationIsMeaningful,
  boomerangOrder,
  buildAnimation,
  buildSequence,
  orderFor,
  repeatCount,
  sequenceDuration,
  slideshowOrder,
} from "./animation.ts";

test("slideshowOrder berurutan 0..n-1", () => {
  assert.deepEqual(slideshowOrder(3), [0, 1, 2]);
  assert.deepEqual(slideshowOrder(1), [0]);
  assert.deepEqual(slideshowOrder(0), []);
});

test("boomerangOrder maju lalu mundur tanpa mengulang ujung", () => {
  assert.deepEqual(boomerangOrder(3), [0, 1, 2, 1]);
  assert.deepEqual(boomerangOrder(4), [0, 1, 2, 3, 2, 1]);
  assert.deepEqual(boomerangOrder(2), [0, 1]);
  assert.deepEqual(boomerangOrder(1), [0], "satu foto tidak bisa diping-pong");
});

test("orderFor memilih urutan sesuai jenis animasi", () => {
  assert.deepEqual(orderFor("slideshow", 3), [0, 1, 2]);
  assert.deepEqual(orderFor("boomerang", 3), [0, 1, 2, 1]);
  assert.deepEqual(orderFor("none", 3), [], "tanpa animasi tidak ada urutan");
});

test("buildSequence menyusun waktu berurutan tanpa celah", () => {
  const steps = buildSequence([0, 1], 500);

  assert.equal(steps.length, 2);
  const first = steps[0];
  const second = steps[1];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.startSec, 0);
  assert.equal(first.durationSec, 0.5);
  assert.equal(second.startSec, 0.5);
  assert.equal(second.durationSec, 0.5);
});

test("buildSequence tidak menerima durasi nol/negatif", () => {
  const steps = buildSequence([0], 0);
  const only = steps[0];
  assert.ok(only !== undefined);
  assert.ok(only.durationSec > 0);
});

test("sequenceDuration = akhir langkah terakhir", () => {
  assert.equal(sequenceDuration(buildSequence([0, 1, 2], 1000)), 3);
  assert.equal(sequenceDuration([]), 0);
});

test("repeatCount minimal sekali, dan 0 kalau urutannya kosong", () => {
  const steps = buildSequence([0, 1], 1000);
  assert.equal(sequenceDuration(steps), 2);
  assert.equal(repeatCount(steps, 4), 2);
  assert.equal(repeatCount(steps, 0), 1, "target 0 tetap minimal sekali");
  assert.equal(repeatCount([], 10), 0);
});

test("buildAnimation menyusun timeline sesuai jenis & jumlah foto", () => {
  assert.equal(buildAnimation("slideshow", 3, 1000).length, 3);
  assert.equal(buildAnimation("boomerang", 3, 1000).length, 4);
  assert.equal(buildAnimation("none", 3, 1000).length, 0);
});

test("animasi hanya bermakna kalau ada minimal dua foto", () => {
  assert.equal(animationIsMeaningful("none", 5), false);
  assert.equal(animationIsMeaningful("slideshow", 1), false);
  assert.equal(animationIsMeaningful("slideshow", 2), true);
  assert.equal(animationIsMeaningful("boomerang", 1), false);
  assert.equal(animationIsMeaningful("boomerang", 2), true);
});
