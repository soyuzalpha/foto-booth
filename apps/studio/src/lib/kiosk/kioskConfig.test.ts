/**
 * Tes pengaturan kiosk.
 *
 * Yang penting: default aman (kiosk mati), angka idle selalu lewat normalisasi,
 * dan konfigurasi rusak tidak menyalakan kiosk tanpa sengaja.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { IDLE_DEFAULT_CONFIG } from "./idle.ts";
import { createMemoryStorage } from "./pinStore.ts";
import {
  KIOSK_CONFIG_KEY,
  KIOSK_DEFAULT_CONFIG,
  loadKioskConfig,
  parseKioskConfig,
  saveKioskConfig,
} from "./kioskConfig.ts";

test("default: kiosk mati dan idle memakai nilai default", () => {
  assert.equal(KIOSK_DEFAULT_CONFIG.enabled, false);
  assert.deepEqual(KIOSK_DEFAULT_CONFIG.idle, IDLE_DEFAULT_CONFIG);
  assert.equal(KIOSK_DEFAULT_CONFIG.requirePinOnExit, true);
});

test("parseKioskConfig mengembalikan default untuk null / JSON rusak / non-objek", () => {
  assert.deepEqual(parseKioskConfig(null), KIOSK_DEFAULT_CONFIG);
  assert.deepEqual(parseKioskConfig("{rusak"), KIOSK_DEFAULT_CONFIG);
  assert.deepEqual(parseKioskConfig("42"), KIOSK_DEFAULT_CONFIG);
  assert.deepEqual(parseKioskConfig('"kiosk"'), KIOSK_DEFAULT_CONFIG);
});

test("parseKioskConfig menormalkan angka idle dan menolak nilai non-angka", () => {
  const config = parseKioskConfig(
    JSON.stringify({ enabled: true, idle: { timeoutMs: 1, warningMs: "banyak" } }),
  );

  assert.equal(config.enabled, true);
  assert.equal(config.idle.timeoutMs, 15_000, "dijepit ke minimum");
  assert.equal(config.idle.warningMs, IDLE_DEFAULT_CONFIG.warningMs, "non-angka → default");
});

test("enabled hanya true kalau benar-benar boolean true", () => {
  assert.equal(parseKioskConfig(JSON.stringify({ enabled: "yes" })).enabled, false);
  assert.equal(parseKioskConfig(JSON.stringify({ enabled: 1 })).enabled, false);
  assert.equal(parseKioskConfig(JSON.stringify({ enabled: true })).enabled, true);
});

test("requirePinOnExit default true; hanya false eksplisit yang mematikannya", () => {
  assert.equal(parseKioskConfig(JSON.stringify({})).requirePinOnExit, true);
  assert.equal(parseKioskConfig(JSON.stringify({ requirePinOnExit: false })).requirePinOnExit, false);
  assert.equal(parseKioskConfig(JSON.stringify({ requirePinOnExit: "no" })).requirePinOnExit, true);
});

test("flag guard/tapToStart default menyala dan bisa dimatikan", () => {
  const defaults = parseKioskConfig(JSON.stringify({}));
  assert.equal(defaults.blockGestures, true);
  assert.equal(defaults.tapToStart, true);

  const off = parseKioskConfig(JSON.stringify({ blockGestures: false, tapToStart: false }));
  assert.equal(off.blockGestures, false);
  assert.equal(off.tapToStart, false);
});

test("tombol tamu default: print menyala, gallery & share mati", () => {
  const defaults = parseKioskConfig(JSON.stringify({})).buttons;
  assert.deepEqual(defaults, { gallery: false, print: true, share: false });

  const custom = parseKioskConfig(
    JSON.stringify({ buttons: { gallery: true, share: true } }),
  ).buttons;
  assert.deepEqual(custom, { gallery: true, print: true, share: true }, "yang tidak disebut tetap default");
});

test("save lalu load mengembalikan konfigurasi yang sama", () => {
  const storage = createMemoryStorage();
  const config = {
    ...KIOSK_DEFAULT_CONFIG,
    enabled: true,
    idle: { timeoutMs: 60_000, warningMs: 10_000 },
    requirePinOnExit: false,
    buttons: { gallery: true, print: false, share: true },
  };

  assert.equal(saveKioskConfig(config, storage), true);
  assert.deepEqual(loadKioskConfig(storage), config);
});

test("storage kosong → default; storage melempar → default", () => {
  assert.deepEqual(loadKioskConfig(createMemoryStorage()), KIOSK_DEFAULT_CONFIG);

  const hostile = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => undefined,
  };
  assert.deepEqual(loadKioskConfig(hostile), KIOSK_DEFAULT_CONFIG);

  const failing = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.equal(saveKioskConfig(KIOSK_DEFAULT_CONFIG, failing), false);
});

test("config tidak menyimpan PIN — key-nya terpisah", () => {
  const storage = createMemoryStorage();
  saveKioskConfig({ ...KIOSK_DEFAULT_CONFIG, enabled: true }, storage);

  const raw = storage.getItem(KIOSK_CONFIG_KEY) ?? "";
  assert.equal(raw.includes("hash"), false);
  assert.equal(raw.includes("salt"), false);
});
