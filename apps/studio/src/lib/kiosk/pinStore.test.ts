/**
 * Tes penyimpanan PIN kiosk.
 *
 * Fokus: apa yang benar-benar ditulis ke storage, dan bahwa storage yang rusak
 * atau memblokir tidak menjatuhkan aplikasi.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { PinRecord } from "./pin.ts";
import {
  PIN_STORAGE_KEY,
  clearPinRecord,
  createMemoryStorage,
  hasPin,
  loadPinRecord,
  savePinRecord,
} from "./pinStore.ts";

const RECORD: PinRecord = {
  algo: "PBKDF2-SHA256",
  iterations: 120_000,
  salt: "c2FsdA==",
  hash: "aGFzaA==",
};

test("savePinRecord lalu loadPinRecord mengembalikan record yang sama", () => {
  const storage = createMemoryStorage();

  assert.equal(hasPin(storage), false, "storage kosong belum punya PIN");
  assert.equal(savePinRecord(RECORD, storage), true);

  assert.equal(hasPin(storage), true);
  assert.deepEqual(loadPinRecord(storage), RECORD);
});

test("yang tersimpan di storage adalah record, bukan PIN mentah", () => {
  const storage = createMemoryStorage();
  savePinRecord(RECORD, storage);

  const raw = storage.getItem(PIN_STORAGE_KEY);
  assert.equal(raw !== null, true);
  assert.equal(raw?.includes("4821"), false);
  assert.equal(raw?.includes("PBKDF2-SHA256"), true);
});

test("clearPinRecord menghapus PIN dan hasPin kembali false", () => {
  const storage = createMemoryStorage();
  savePinRecord(RECORD, storage);

  clearPinRecord(storage);

  assert.equal(storage.getItem(PIN_STORAGE_KEY), null);
  assert.equal(hasPin(storage), false);
});

test("loadPinRecord mengembalikan null untuk JSON rusak, bukan melempar", () => {
  const storage = createMemoryStorage();
  storage.setItem(PIN_STORAGE_KEY, "{bukan json");

  assert.equal(loadPinRecord(storage), null);
});

test("loadPinRecord mengembalikan null untuk record yang bentuknya salah", () => {
  const storage = createMemoryStorage();
  storage.setItem(PIN_STORAGE_KEY, JSON.stringify({ algo: "PBKDF2-SHA256" }));

  assert.equal(loadPinRecord(storage), null);
  assert.equal(hasPin(storage), false);
});

test("storage yang melempar saat ditulis dilaporkan sebagai kegagalan, bukan crash", () => {
  const hostile = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => undefined,
  };

  assert.equal(savePinRecord(RECORD, hostile), false);
});

test("storage yang melempar saat dibaca dianggap tidak punya PIN", () => {
  const hostile = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  };

  assert.equal(loadPinRecord(hostile), null);
  assert.equal(hasPin(hostile), false);
});
