/**
 * Tes perkiraan bitrate.
 *
 * Yang dijaga bukan angkanya presisi, tapi **sifatnya**: naik kalau resolusi,
 * fps, atau kualitas naik; selalu di dalam batas; dan bulat ke ribuan supaya
 * angka di UI stabil antar-render.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_BITRATE_BPS,
  MIN_BITRATE_BPS,
  audioBitrateBps,
  estimateBitrateBps,
  estimateBytes,
} from "./bitrate.ts";

test("kualitas lebih tinggi menghasilkan bitrate lebih besar", () => {
  const hemat = estimateBitrateBps(1280, 720, 30, "hemat");
  const standar = estimateBitrateBps(1280, 720, 30, "standar");
  const maks = estimateBitrateBps(1280, 720, 30, "maks");

  assert.ok(hemat < standar, "hemat < standar");
  assert.ok(standar < maks, "standar < maks");
});

test("resolusi & fps naik → bitrate naik", () => {
  const sd = estimateBitrateBps(854, 480, 30, "standar");
  const hd = estimateBitrateBps(1280, 720, 30, "standar");
  const fhd = estimateBitrateBps(1920, 1080, 30, "standar");
  const fhd60 = estimateBitrateBps(1920, 1080, 60, "standar");

  assert.ok(sd < hd && hd < fhd, "resolusi naik");
  assert.ok(fhd < fhd60, "fps naik");
});

test("hasil selalu di dalam batas bawah & atas", () => {
  const tiny = estimateBitrateBps(1, 1, 1, "hemat");
  const huge = estimateBitrateBps(7680, 4320, 240, "maks");

  assert.equal(tiny, MIN_BITRATE_BPS);
  assert.equal(huge, MAX_BITRATE_BPS);
});

test("bitrate dibulatkan ke ribuan terdekat", () => {
  const value = estimateBitrateBps(1280, 720, 30, "standar");
  assert.equal(value % 1000, 0);
  assert.equal(value, 2_765_000);
});

test("dimensi/fps aneh tidak menghasilkan NaN", () => {
  for (const value of [estimateBitrateBps(0, 0, 0, "standar"), estimateBitrateBps(-5, -5, -30, "hemat")]) {
    assert.ok(Number.isFinite(value));
    assert.ok(value >= MIN_BITRATE_BPS);
  }
});

test("estimateBytes mengubah bitrate+durasi jadi byte", () => {
  assert.equal(estimateBytes(8_000_000, 1), 1_000_000);
  assert.equal(estimateBytes(4_000_000, 15), 7_500_000);
  assert.equal(estimateBytes(4_000_000, 0), 0);
  assert.equal(estimateBytes(4_000_000, -3), 0, "durasi negatif tidak menghasilkan byte negatif");
});

test("audioBitrateBps nol saat audio dimatikan", () => {
  assert.equal(audioBitrateBps(false), 0);
  assert.equal(audioBitrateBps(true), 128_000);
});
