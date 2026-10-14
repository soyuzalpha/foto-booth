/**
 * Tes rencana rekaman.
 *
 * `resolveVideoPlan` adalah satu-satunya tempat keputusan Fase 7 diambil, jadi
 * yang dijaga di sini: mode dipilih dari animasi, slow-mo menaikkan fps rekam
 * **dan** memanjangkan durasi keluaran, bitrate dihitung dari fps keluaran, dan
 * tanpa format yang didukung rencananya dinyatakan tidak bisa dijalankan.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_VIDEO_SETTINGS, type VideoSettings } from "./types.ts";
import { describePlan, planIsRunnable, resolveVideoPlan } from "./plan.ts";

const SUPPORT_ALL = (): boolean => true;
const SUPPORT_NONE = (): boolean => false;

function settings(overrides: Partial<VideoSettings> = {}): VideoSettings {
  return { ...DEFAULT_VIDEO_SETTINGS, ...overrides };
}

test("setelan default → rencana rekam 720p 30 fps MP4 tanpa audio", () => {
  const plan = resolveVideoPlan(settings(), { isSupported: SUPPORT_ALL });

  assert.equal(plan.mode, "record");
  assert.equal(plan.width, 1280);
  assert.equal(plan.height, 720);
  assert.equal(plan.fps, 30);
  assert.equal(plan.captureFps, 30);
  assert.equal(plan.audio, false);
  assert.equal(plan.extension, "mp4");
  assert.equal(plan.contentType, "video/mp4");
  assert.equal(plan.audioBitrateBps, 0);
  assert.equal(plan.needsInterpolation, false);
  assert.equal(planIsRunnable(plan), true);
});

test("tanpa format yang didukung rencana tidak bisa dijalankan", () => {
  const plan = resolveVideoPlan(settings(), { isSupported: SUPPORT_NONE });

  assert.equal(plan.mimeType, null);
  assert.equal(planIsRunnable(plan), false);
});

test("slow-mo menaikkan fps rekam dan memanjangkan durasi keluaran", () => {
  const plan = resolveVideoPlan(settings({ slowMo: 0.5 }), {
    isSupported: SUPPORT_ALL,
    sourceDurationSec: 10,
  });

  assert.equal(plan.captureFps, 60, "butuh bahan 2× lebih banyak");
  assert.equal(plan.expectedDurationSec, 20);
  assert.equal(plan.needsInterpolation, true);
});

test("slow-mo ¼ meminta 4× fps rekam", () => {
  const plan = resolveVideoPlan(settings({ slowMo: 0.25, fps: 30 }), { isSupported: SUPPORT_ALL });
  assert.equal(plan.captureFps, 120);
  assert.equal(plan.needsInterpolation, true);
});

test("slow-mo tidak mengubah bitrate (bitrate ikut fps keluaran)", () => {
  const normal = resolveVideoPlan(settings(), { isSupported: SUPPORT_ALL });
  const slow = resolveVideoPlan(settings({ slowMo: 0.5 }), { isSupported: SUPPORT_ALL });

  assert.equal(slow.bitrateBps, normal.bitrateBps);
  assert.ok(slow.expectedBytes > normal.expectedBytes, "durasi 2× → berkas 2×");
});

test("animasi mengubah mode ke `animate` dan tidak butuh interpolasi", () => {
  const plan = resolveVideoPlan(settings({ animation: "boomerang", slowMo: 0.25 }), {
    isSupported: SUPPORT_ALL,
  });

  assert.equal(plan.mode, "animate");
  assert.equal(plan.needsInterpolation, false, "animasi bukan retiming frame video");
  assert.equal(plan.animation, "boomerang");
});

test("audio menambah bitrate audio & memilih format ber-audio", () => {
  const silent = resolveVideoPlan(settings(), { isSupported: SUPPORT_ALL });
  const loud = resolveVideoPlan(settings({ audio: true }), { isSupported: SUPPORT_ALL });

  assert.equal(loud.audioBitrateBps, 128_000);
  assert.ok(loud.expectedBytes > silent.expectedBytes);
  assert.equal(loud.mimeType, "video/mp4;codecs=avc1.4d002a,mp4a.40.2");
});

test("resolusi 4K menghasilkan bitrate & ukuran lebih besar", () => {
  const hd = resolveVideoPlan(settings(), { isSupported: SUPPORT_ALL });
  const uhd = resolveVideoPlan(settings({ resolution: "2160p" }), { isSupported: SUPPORT_ALL });

  assert.equal(uhd.width, 3840);
  assert.ok(uhd.bitrateBps > hd.bitrateBps);
  assert.ok(uhd.expectedBytes > hd.expectedBytes);
});

test("durasi sumber eksplisit dipakai apa adanya", () => {
  const plan = resolveVideoPlan(settings({ maxDurationSec: 60 }), {
    isSupported: SUPPORT_ALL,
    sourceDurationSec: 5,
  });

  assert.equal(plan.maxDurationSec, 60, "batas setelan tetap dibawa");
  assert.equal(plan.expectedDurationSec, 5, "durasi keluaran ikut rekaman nyata");
});

test("describePlan meringkas angka penting untuk UI", () => {
  const text = describePlan(resolveVideoPlan(settings({ slowMo: 0.5 }), { isSupported: SUPPORT_ALL }));

  assert.ok(text.includes("1280×720"), text);
  assert.ok(text.includes("30 fps"), text);
  assert.ok(text.includes("kbps"), text);
  assert.ok(text.includes("tanpa audio"), text);
  assert.ok(text.includes("MP4"), text);
  assert.ok(text.includes("slow-mo"), text);
});
