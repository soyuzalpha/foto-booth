/**
 * Tes pengaturan AI (Fase 8).
 *
 * Yang diuji adalah keputusan yang menentukan apakah kunci operator aman dan
 * apakah aplikasi tetap jalan dengan penyimpanan rusak:
 *
 *   · kunci yang tidak masuk akal **dikosongkan**, bukan diteruskan;
 *   · kunci tidak pernah muncul utuh di bentuk tampilan (`maskAiKey`);
 *   · JSON rusak / versi lama jatuh ke default, bukan menjatuhkan aplikasi;
 *   · tugas & gaya tak dikenal dari penyimpanan lama tidak pernah dikirim ke API.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { KeyValueStore } from "../capture/rememberedDevice.ts";
import {
  AI_SETTINGS_KEY,
  DEFAULT_AI_SETTINGS,
  isAiConfigured,
  maskAiKey,
  normalizeAiSettings,
  readAiSettings,
  writeAiSettings,
} from "./aiSettingsStore.ts";

const KEY = "AIzaSyD-abcdefghijklmnopqrstuvwxyz_0123";

/** Penyimpanan dalam memori; `failWrites` meniru penyimpanan penuh/diblokir. */
function memoryStore(initial: Record<string, string> = {}, failWrites = false): KeyValueStore {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) throw new Error("penuh");
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

test("tanpa penyimpanan → default (mode privat tidak menjatuhkan apa pun)", () => {
  assert.deepEqual(readAiSettings(null), DEFAULT_AI_SETTINGS);
});

test("putaran simpan → baca mengembalikan nilai yang sama", () => {
  const store = memoryStore();
  writeAiSettings(store, { key: KEY, enabled: true, task: "backdrop", style: "oil", custom: "langit senja" });
  const back = readAiSettings(store);
  assert.equal(back.key, KEY);
  assert.equal(back.enabled, true);
  assert.equal(back.task, "backdrop");
  assert.equal(back.style, "oil");
  assert.equal(back.custom, "langit senja");
});

test("AI mati secara default — operator harus menyalakannya sendiri", () => {
  assert.equal(DEFAULT_AI_SETTINGS.enabled, false);
  assert.equal(normalizeAiSettings({ key: KEY }).enabled, false);
  // Nilai truthy yang bukan `true` tidak menyalakan AI (data dari penyimpanan).
  assert.equal(normalizeAiSettings({ enabled: "yes" }).enabled, false);
  assert.equal(normalizeAiSettings({ enabled: 1 }).enabled, false);
});

test("kunci tidak masuk akal dikosongkan, bukan dipakai", () => {
  // Kunci terpotong harus muncul sebagai \"belum diisi\", bukan sebagai 401.
  assert.equal(normalizeAiSettings({ key: "AIza" }).key, "");
  assert.equal(normalizeAiSettings({ key: "AIza kunci dengan spasi" }).key, "");
  assert.equal(normalizeAiSettings({ key: 42 }).key, "");
  assert.equal(normalizeAiSettings({ key: `  ${KEY}  ` }).key, KEY);
});

test("JSON rusak / bukan objek → default, bukan lempar", () => {
  assert.deepEqual(readAiSettings(memoryStore({ [AI_SETTINGS_KEY]: "{bukan json" })), DEFAULT_AI_SETTINGS);
  assert.deepEqual(readAiSettings(memoryStore({ [AI_SETTINGS_KEY]: "\"teks\"" })), DEFAULT_AI_SETTINGS);
  assert.deepEqual(normalizeAiSettings(null), DEFAULT_AI_SETTINGS);
  assert.deepEqual(normalizeAiSettings([]), DEFAULT_AI_SETTINGS);
});

test("tugas & gaya tak dikenal dari versi lama jatuh ke default", () => {
  const settings = normalizeAiSettings({ task: "upscale", style: "vaporwave", key: KEY });
  assert.equal(settings.task, DEFAULT_AI_SETTINGS.task);
  assert.equal(settings.style, DEFAULT_AI_SETTINGS.style);
  // Kuncinya tetap dipakai — yang salah hanya pilihan gaya.
  assert.equal(settings.key, KEY);
});

test("instruksi tambahan dipangkas dan dibatasi", () => {
  const settings = normalizeAiSettings({ custom: "  langit   senja \n hangat " });
  assert.equal(settings.custom, "langit senja hangat");
  assert.equal(normalizeAiSettings({ custom: "x".repeat(999) }).custom.length, 600);
});

test("kegagalan menyimpan tidak melempar", () => {
  const store = memoryStore({}, true);
  assert.doesNotThrow(() => writeAiSettings(store, { key: KEY, enabled: true, task: "style", style: "anime", custom: "" }));
});

test("maskAiKey menunjukkan cukup untuk dikenali, tidak cukup untuk dipakai", () => {
  const masked = maskAiKey(KEY);
  assert.ok(!masked.includes(KEY));
  assert.ok(masked.startsWith("AIzaSy"));
  assert.ok(masked.endsWith(KEY.slice(-4)));
  // Kunci pendek tidak membocorkan ekornya.
  assert.equal(maskAiKey("pendek"), "••••••");
  assert.equal(maskAiKey(""), "");
});

test("isAiConfigured menolak kunci yang tidak masuk akal", () => {
  assert.equal(isAiConfigured({ key: KEY, enabled: true, task: "style", style: "anime", custom: "" }), true);
  assert.equal(isAiConfigured(DEFAULT_AI_SETTINGS), false);
  assert.equal(isAiConfigured({ key: "AIza", enabled: true, task: "style", style: "anime", custom: "" }), false);
});
