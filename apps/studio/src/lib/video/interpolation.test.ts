/**
 * Tes perencanaan interpolasi.
 *
 * Yang dijaga: interpolasi **tidak pernah** membatalkan video. Provider yang
 * belum siap, melempar, atau tidak punya frame pasangan harus berakhir `null` di
 * slotnya — bukan exception yang menjalar ke UI.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { retimeTimeline } from "./slowMotion.ts";
import {
  blendWeight,
  interpolateFrames,
  syntheticFrames,
  type FrameInterpolator,
  type SourceFrame,
} from "./interpolation.ts";

function frame(index: number): SourceFrame {
  return { index, image: { index }, width: 4, height: 4 };
}

function provider(kind: "rife" | "blend", ready: boolean, result: unknown = { made: true }): FrameInterpolator {
  return {
    kind,
    ready: () => ready,
    interpolate: () => Promise.resolve(result),
  };
}

test("syntheticFrames hanya mengambil langkah yang butuh sintesis", () => {
  const steps = retimeTimeline(3, 0.5, 30);
  const jobs = syntheticFrames(steps);

  assert.ok(jobs.length > 0);
  for (const job of jobs) {
    assert.ok(job.mix > 0, "frame asli tidak boleh masuk daftar sintesis");
  }
  assert.equal(jobs.length, steps.filter((s) => s.mix > 0).length);
});

test("blendWeight menjepit bobot ke 0..1 dan menolak NaN", () => {
  assert.equal(blendWeight(0.4), 0.4);
  assert.equal(blendWeight(-2), 0);
  assert.equal(blendWeight(7), 1);
  assert.equal(blendWeight(Number.NaN), 0);
});

test("tanpa provider: semua slot null (pemanggil pakai frame asli)", async () => {
  const steps = retimeTimeline(3, 0.5, 30);
  const frames = [frame(0), frame(1), frame(2)];

  const out = await interpolateFrames(null, frames, steps);
  assert.equal(out.length, syntheticFrames(steps).length);
  assert.ok(out.every((item) => item === null));
});

test("provider belum siap: tidak dipanggil, hasil null", async () => {
  let calls = 0;
  const notReady: FrameInterpolator = {
    kind: "rife",
    ready: () => false,
    interpolate: () => {
      calls += 1;
      return Promise.resolve({});
    },
  };

  const out = await interpolateFrames(notReady, [frame(0), frame(1), frame(2)], retimeTimeline(3, 0.5, 30));
  assert.equal(calls, 0, "provider yang belum siap tidak boleh dipanggil");
  assert.ok(out.every((item) => item === null));
});

test("provider siap: frame sintetis dikembalikan di slotnya", async () => {
  const out = await interpolateFrames(
    provider("blend", true),
    [frame(0), frame(1), frame(2)],
    retimeTimeline(3, 0.5, 30),
  );
  assert.ok(out.length > 0);
  assert.ok(out.every((item) => item !== null));
});

test("provider yang melempar tidak menjatuhkan pemanggil", async () => {
  const throwing: FrameInterpolator = {
    kind: "rife",
    ready: () => true,
    interpolate: () => Promise.reject(new Error("wasm hilang")),
  };

  const out = await interpolateFrames(throwing, [frame(0), frame(1)], retimeTimeline(2, 0.5, 30));
  assert.ok(out.length > 0);
  assert.ok(out.every((item) => item === null));
});

test("frame pasangan tidak ada → null, bukan lemparan", async () => {
  const steps = retimeTimeline(4, 0.5, 30);
  // Sengaja hanya menyediakan frame 0 dan 1.
  const out = await interpolateFrames(provider("blend", true), [frame(0), frame(1)], steps);
  assert.ok(out.length > 0);
  assert.ok(out.includes(null), "langkah yang pasangannya hilang harus null");
});
