/**
 * Tes penyimpanan setelan video.
 *
 * Sama seperti setelan filter: yang dijaga bukan "JSON-nya benar", tapi **janji
 * bahwa data rusak tidak menjatuhkan aplikasi**. localStorage bisa berisi JSON
 * versi lama, angka `NaN`, atau hasil editan tangan; semuanya harus berakhir jadi
 * setelan yang sah.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { KeyValueStore } from "../capture/rememberedDevice.ts";
import { DEFAULT_VIDEO_SETTINGS } from "./types.ts";
import {
  VIDEO_SETTINGS_KEY,
  normalizeVideoSettings,
  readVideoSettings,
  writeVideoSettings,
} from "./videoSettingsStore.ts";

function fakeStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

test("normalizeVideoSettings mengembalikan default untuk masukan bukan objek", () => {
  for (const input of [null, undefined, 42, "abc", true]) {
    assert.deepEqual(normalizeVideoSettings(input), DEFAULT_VIDEO_SETTINGS);
  }
});

test("normalizeVideoSettings mengisi field yang hilang", () => {
  const out = normalizeVideoSettings({ resolution: "1080p" });

  assert.equal(out.resolution, "1080p");
  assert.equal(out.fps, DEFAULT_VIDEO_SETTINGS.fps);
  assert.equal(out.audio, DEFAULT_VIDEO_SETTINGS.audio);
  assert.equal(out.slowMo, DEFAULT_VIDEO_SETTINGS.slowMo);
  assert.equal(out.animation, DEFAULT_VIDEO_SETTINGS.animation);
});

test("nilai enum yang tidak dikenal jatuh ke default", () => {
  const out = normalizeVideoSettings({
    resolution: "8k",
    fps: 144,
    slowMo: 0.1,
    quality: "ultra",
    animation: "gif",
  });

  assert.equal(out.resolution, "720p");
  assert.equal(out.fps, 30);
  assert.equal(out.slowMo, 1);
  assert.equal(out.quality, "standar");
  assert.equal(out.animation, "none");
});

test("durasi & lama frame dijepit ke batas yang sah", () => {
  assert.equal(normalizeVideoSettings({ maxDurationSec: 0 }).maxDurationSec, 1);
  assert.equal(normalizeVideoSettings({ maxDurationSec: 999 }).maxDurationSec, 60);
  assert.equal(normalizeVideoSettings({ maxDurationSec: 20.7 }).maxDurationSec, 21);
  assert.equal(normalizeVideoSettings({ maxDurationSec: Number.NaN }).maxDurationSec, 15);
  assert.equal(normalizeVideoSettings({ slideshowFrameMs: 10 }).slideshowFrameMs, 200);
  assert.equal(normalizeVideoSettings({ slideshowFrameMs: 99_999 }).slideshowFrameMs, 5000);
});

test("audio non-boolean diabaikan (string \"true\" bukan true)", () => {
  assert.equal(normalizeVideoSettings({ audio: "true" }).audio, false);
  assert.equal(normalizeVideoSettings({ audio: true }).audio, true);
});

test("readVideoSettings: store null / kosong / JSON rusak → default", () => {
  assert.deepEqual(readVideoSettings(null), DEFAULT_VIDEO_SETTINGS);
  assert.deepEqual(readVideoSettings(fakeStore()), DEFAULT_VIDEO_SETTINGS);
  assert.deepEqual(readVideoSettings(fakeStore({ [VIDEO_SETTINGS_KEY]: "{bukan json" })), DEFAULT_VIDEO_SETTINGS);
});

test("readVideoSettings: store yang melempar tetap menghasilkan default", () => {
  const throwing: KeyValueStore = {
    getItem: () => {
      throw new Error("mode privat");
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  };

  assert.deepEqual(readVideoSettings(throwing), DEFAULT_VIDEO_SETTINGS);
});

test("write lalu read mengembalikan setelan yang sama", () => {
  const store = fakeStore();
  const settings = { ...DEFAULT_VIDEO_SETTINGS, resolution: "1080p" as const, fps: 60 as const, audio: true };

  writeVideoSettings(store, settings);
  assert.deepEqual(readVideoSettings(store), settings);
});

test("writeVideoSettings tidak melempar kalau penyimpanan penuh", () => {
  const full: KeyValueStore = {
    getItem: () => null,
    setItem: () => {
      throw new Error("kuota penuh");
    },
    removeItem: () => undefined,
  };

  assert.doesNotThrow(() => writeVideoSettings(full, DEFAULT_VIDEO_SETTINGS));
  assert.doesNotThrow(() => writeVideoSettings(null, DEFAULT_VIDEO_SETTINGS));
});
