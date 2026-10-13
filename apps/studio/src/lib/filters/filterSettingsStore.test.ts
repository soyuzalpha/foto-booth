/**
 * Tes penyimpanan pengaturan filter.
 *
 * Yang dijaga di sini bukan "JSON-nya benar", tapi **janji bahwa data rusak
 * tidak menjatuhkan aplikasi**: localStorage bisa berisi JSON dari versi lama,
 * angka `NaN`, atau hasil editan tangan. Semuanya harus berakhir jadi
 * pengaturan yang sah — bukan lemparan error saat studio dibuka.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_FILTER_SETTINGS } from "./types.ts";
import {
  FILTER_SETTINGS_KEY,
  normalizeFilterSettings,
  readFilterSettings,
  writeFilterSettings,
} from "./filterSettingsStore.ts";
import type { KeyValueStore } from "../capture/rememberedDevice.ts";

function fakeStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

test("normalizeFilterSettings mengembalikan default untuk masukan bukan objek", () => {
  for (const input of [null, undefined, 42, "abc", true]) {
    assert.deepEqual(normalizeFilterSettings(input), DEFAULT_FILTER_SETTINGS);
  }
});

test("normalizeFilterSettings mengisi field yang hilang dari objek separuh", () => {
  const out = normalizeFilterSettings({ quality: "maks" });

  assert.equal(out.quality, "maks");
  assert.equal(out.rotation, DEFAULT_FILTER_SETTINGS.rotation);
  assert.deepEqual(out.adjustments, DEFAULT_FILTER_SETTINGS.adjustments);
  assert.equal(out.chromaKey.enabled, false);
});

test("normalizeFilterSettings menolak nilai tak dikenal & kembali ke default", () => {
  const out = normalizeFilterSettings({
    rotation: 45,
    quality: "ultra",
    background: { mode: "hologram" },
  });

  assert.equal(out.rotation, 0);
  assert.equal(out.quality, "standar");
  assert.equal(out.background.mode, "none");
});

test("normalizeFilterSettings menjepit angka yang di luar rentang", () => {
  const out = normalizeFilterSettings({
    chromaKey: { enabled: true, similarity: 999, smoothness: -50, spill: 50 },
    adjustments: { brightness: 500, contrast: -500, saturation: 0 },
    background: { mode: "blur", blur: 250 },
  });

  assert.equal(out.chromaKey.similarity, 100);
  assert.equal(out.chromaKey.smoothness, 0);
  assert.equal(out.adjustments.brightness, 100);
  assert.equal(out.adjustments.contrast, -100);
  assert.equal(out.background.blur, 100);
});

test("normalizeFilterSettings membuang NaN, bukan meneruskannya", () => {
  const out = normalizeFilterSettings({
    chromaKey: { enabled: true, similarity: Number.NaN },
    adjustments: { brightness: Number.POSITIVE_INFINITY },
  });

  assert.equal(out.chromaKey.similarity, DEFAULT_FILTER_SETTINGS.chromaKey.similarity);
  assert.equal(out.adjustments.brightness, DEFAULT_FILTER_SETTINGS.adjustments.brightness);
});

test("normalizeFilterSettings menjepit warna RGB ke 0..255", () => {
  const out = normalizeFilterSettings({
    chromaKey: { color: { r: -10, g: 300, b: 128 } },
  });

  assert.deepEqual(out.chromaKey.color, { r: 0, g: 255, b: 128 });
});

test("normalizeFilterSettings tidak mengembalikan referensi ke default global", () => {
  const out = normalizeFilterSettings(null);
  out.chromaKey.color.r = 123;

  assert.notEqual(DEFAULT_FILTER_SETTINGS.chromaKey.color.r, 123);
});

test("readFilterSettings mengembalikan default kalau penyimpanan kosong", () => {
  assert.deepEqual(readFilterSettings(fakeStore()), DEFAULT_FILTER_SETTINGS);
});

test("readFilterSettings mengembalikan default kalau penyimpanan null", () => {
  assert.deepEqual(readFilterSettings(null), DEFAULT_FILTER_SETTINGS);
});

test("readFilterSettings mengembalikan default kalau JSON rusak, bukan melempar", () => {
  const store = fakeStore({ [FILTER_SETTINGS_KEY]: "{bukan json" });
  assert.deepEqual(readFilterSettings(store), DEFAULT_FILTER_SETTINGS);
});

test("writeFilterSettings lalu readFilterSettings mengembalikan nilai yang sama", () => {
  const store = fakeStore();
  const settings = {
    ...DEFAULT_FILTER_SETTINGS,
    rotation: 90 as const,
    faceEnhance: true,
    chromaKey: { ...DEFAULT_FILTER_SETTINGS.chromaKey, enabled: true },
  };

  writeFilterSettings(store, settings);
  assert.deepEqual(readFilterSettings(store), settings);
});

test("writeFilterSettings tidak melempar saat penyimpanan penuh", () => {
  const store: KeyValueStore = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => undefined,
  };

  assert.doesNotThrow(() => writeFilterSettings(store, DEFAULT_FILTER_SETTINGS));
});
