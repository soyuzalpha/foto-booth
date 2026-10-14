/**
 * Tes perhitungan slow-mo.
 *
 * Yang dijaga: durasi & jumlah frame keluaran berbanding terbalik dengan faktor,
 * timeline keluaran **selalu** menunjuk frame yang ada (tidak ada indeks di luar
 * akhir berkas), dan `mix` selalu di 0..1.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  needsInterpolation,
  outputDurationSec,
  outputFrameCount,
  playbackRateFor,
  retimeTimeline,
  syntheticFrameCount,
} from "./slowMotion.ts";

test("playbackRateFor: faktor 1 tetap 1, faktor lain apa adanya", () => {
  assert.equal(playbackRateFor(1), 1);
  assert.equal(playbackRateFor(0.5), 0.5);
  assert.equal(playbackRateFor(0.25), 0.25);
});

test("durasi keluaran memanjang sebanding 1/faktor", () => {
  assert.equal(outputDurationSec(10, 1), 10);
  assert.equal(outputDurationSec(10, 0.5), 20);
  assert.equal(outputDurationSec(10, 0.25), 40);
  assert.equal(outputDurationSec(-4, 0.5), 0, "durasi negatif tidak menghasilkan durasi negatif");
});

test("jumlah frame keluaran bertambah sebanding 1/faktor", () => {
  assert.equal(outputFrameCount(100, 1), 100);
  assert.equal(outputFrameCount(100, 0.5), 200);
  assert.equal(outputFrameCount(100, 0.25), 400);
  assert.equal(outputFrameCount(0, 0.5), 0);
});

test("retimeTimeline: jumlah langkah = frame keluaran, waktu = k/fps", () => {
  const steps = retimeTimeline(4, 0.5, 30);
  assert.equal(steps.length, 8);

  steps.forEach((step, k) => {
    assert.equal(step.outputIndex, k);
    assert.equal(step.atSec, k / 30);
  });
});

test("retimeTimeline tidak pernah menunjuk frame di luar berkas sumber", () => {
  const steps = retimeTimeline(4, 0.5, 30);
  for (const step of steps) {
    assert.ok(step.fromIndex >= 0 && step.fromIndex <= 3, `fromIndex ${step.fromIndex}`);
    assert.ok(step.toIndex >= 0 && step.toIndex <= 3, `toIndex ${step.toIndex}`);
    assert.ok(step.mix >= 0 && step.mix <= 1, `mix ${step.mix}`);
    assert.ok(step.toIndex >= step.fromIndex, "toIndex tidak mendahului fromIndex");
  }
});

test("retimeTimeline tanpa frame → timeline kosong", () => {
  assert.deepEqual(retimeTimeline(0, 0.5, 30), []);
});

test("retimeTimeline satu frame → tidak ada yang disintesis", () => {
  const steps = retimeTimeline(1, 0.5, 30);
  assert.equal(steps.length, 2);
  for (const step of steps) {
    assert.equal(step.fromIndex, 0);
    assert.equal(step.toIndex, 0);
    assert.equal(step.mix, 0);
  }
  assert.equal(syntheticFrameCount(steps), 0);
});

test("retimeTimeline fps 0 tidak membagi dengan nol", () => {
  const steps = retimeTimeline(2, 1, 0);
  assert.ok(steps.every((step) => Number.isFinite(step.atSec)));
});

test("faktor 0,5 menyisipkan frame sintetis di antara pasangan frame asli", () => {
  const steps = retimeTimeline(4, 0.5, 30);
  // 8 langkah; yang punya pasangan nyata (0→1, 1→2, 2→3) = 3. Langkah terakhir
  // menahan frame 3 apa adanya, jadi tidak dihitung.
  assert.equal(syntheticFrameCount(steps), 3);
  assert.equal(needsInterpolation(steps), true);
});

test("frame terakhir tidak memicu interpolasi (tidak ada frame sesudahnya)", () => {
  const steps = retimeTimeline(4, 0.5, 30);
  const last = steps[steps.length - 1];
  assert.ok(last !== undefined);
  assert.equal(last.fromIndex, last.toIndex);
  assert.equal(last.mix, 0);
});

test("faktor 1 tidak butuh interpolasi sama sekali", () => {
  const steps = retimeTimeline(30, 1, 30);
  assert.equal(syntheticFrameCount(steps), 0);
  assert.equal(needsInterpolation(steps), false);
});
