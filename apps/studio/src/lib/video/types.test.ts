/**
 * Tes tipe & pengaturan video.
 *
 * Yang dijaga: default selalu "paling aman" (720p/30 fps/tanpa audio/tanpa
 * slow-mo), resolusi tak dikenal jatuh ke 720p (bukan `undefined` yang membuat
 * `plan.ts` meledak), dan fps rekam naik tepat sebesar faktor slow-mo.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_VIDEO_SETTINGS,
  SLIDESHOW_FRAME_MS_LIMITS,
  SLOW_MO_FACTORS,
  VIDEO_FPS_OPTIONS,
  VIDEO_MAX_DURATION_LIMITS,
  VIDEO_RESOLUTIONS,
  captureFpsFor,
  videoResolutionById,
} from "./types.ts";

test("daftar resolusi urut menaik & tiap id unik", () => {
  const ids = VIDEO_RESOLUTIONS.map((r) => r.id);
  assert.deepEqual(ids, ["480p", "720p", "1080p", "2160p"]);
  assert.equal(new Set(ids).size, ids.length);

  for (let i = 1; i < VIDEO_RESOLUTIONS.length; i += 1) {
    const prev = VIDEO_RESOLUTIONS[i - 1];
    const cur = VIDEO_RESOLUTIONS[i];
    assert.ok(prev !== undefined && cur !== undefined);
    assert.ok(cur.width > prev.width, "resolusi harus makin besar");
  }
});

test("videoResolutionById mengembalikan resolusi, fallback ke 720p", () => {
  assert.equal(videoResolutionById("2160p").width, 3840);
  assert.equal(videoResolutionById("480p").height, 480);
  assert.equal(videoResolutionById("8k" as never).id, "720p");
});

test("default setelan aman: 720p, 30 fps, tanpa audio, tanpa slow-mo", () => {
  assert.equal(DEFAULT_VIDEO_SETTINGS.resolution, "720p");
  assert.equal(DEFAULT_VIDEO_SETTINGS.fps, 30);
  assert.equal(DEFAULT_VIDEO_SETTINGS.audio, false);
  assert.equal(DEFAULT_VIDEO_SETTINGS.slowMo, 1);
  assert.equal(DEFAULT_VIDEO_SETTINGS.animation, "none");
  assert.ok(VIDEO_FPS_OPTIONS.includes(DEFAULT_VIDEO_SETTINGS.fps));
  assert.ok(SLOW_MO_FACTORS.includes(DEFAULT_VIDEO_SETTINGS.slowMo));
});

test("durasi default berada di dalam batas yang diizinkan", () => {
  assert.ok(DEFAULT_VIDEO_SETTINGS.maxDurationSec >= VIDEO_MAX_DURATION_LIMITS.min);
  assert.ok(DEFAULT_VIDEO_SETTINGS.maxDurationSec <= VIDEO_MAX_DURATION_LIMITS.max);
  assert.ok(DEFAULT_VIDEO_SETTINGS.slideshowFrameMs >= SLIDESHOW_FRAME_MS_LIMITS.min);
  assert.ok(DEFAULT_VIDEO_SETTINGS.slideshowFrameMs <= SLIDESHOW_FRAME_MS_LIMITS.max);
});

test("captureFpsFor menaikkan fps rekam sesuai faktor slow-mo", () => {
  assert.equal(captureFpsFor(30, 1), 30);
  assert.equal(captureFpsFor(24, 1), 24);
  assert.equal(captureFpsFor(30, 0.5), 60);
  assert.equal(captureFpsFor(30, 0.25), 120);
  assert.equal(captureFpsFor(60, 0.25), 240);
});

test("captureFpsFor berhenti di 240 fps walau faktor ekstrem", () => {
  assert.equal(captureFpsFor(60, 0.25), 240);
  assert.ok(captureFpsFor(240 as never, 0.25) <= 240);
});
