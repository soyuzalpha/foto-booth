/**
 * Tes penamaan berkas video.
 *
 * Yang dijaga: nomor di-`padStart` (supaya urutan di file manager benar) dan
 * nama animasi tidak bertabrakan dengan nama rekaman kamera.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { animationFilename, filenameForMode, videoFilename } from "./naming.ts";

test("videoFilename memakai nomor ber-pad dan ekstensi yang benar", () => {
  assert.equal(videoFilename(0, "mp4"), "video-01.mp4");
  assert.equal(videoFilename(9, "webm"), "video-10.webm");
  assert.equal(videoFilename(99, "mp4"), "video-100.mp4");
});

test("animationFilename menyebut jenis animasinya", () => {
  assert.equal(animationFilename("boomerang", "webm"), "animasi-boomerang.webm");
  assert.equal(animationFilename("slideshow", "mp4"), "animasi-slideshow.mp4");
});

test("filenameForMode memisahkan rekaman kamera dari animasi", () => {
  assert.equal(filenameForMode("record", 2, "mp4"), "video-03.mp4");
  assert.equal(filenameForMode("animate", 2, "mp4", "boomerang"), "animasi-boomerang.mp4");
  assert.equal(filenameForMode("animate", 0, "webm"), "animasi-slideshow.webm");
});
