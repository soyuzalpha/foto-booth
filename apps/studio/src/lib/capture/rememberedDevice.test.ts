import test from "node:test";
import assert from "node:assert/strict";

import {
  REMEMBERED_DEVICE_KEY,
  readRememberedDeviceId,
  rememberDeviceId,
  type KeyValueStore,
} from "./rememberedDevice.ts";

/** Penyimpanan palsu di memori — cukup untuk menguji aturannya. */
function memoryStore(initial: Record<string, string> = {}): KeyValueStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

test("membaca kembali device yang diingat", () => {
  const store = memoryStore({ [REMEMBERED_DEVICE_KEY]: "cam-9" });
  assert.equal(readRememberedDeviceId(store), "cam-9");
});

test("penyimpanan kosong / kunci tak ada → null", () => {
  assert.equal(readRememberedDeviceId(memoryStore()), null);
  assert.equal(readRememberedDeviceId(null), null, "localStorage tidak tersedia bukan crash");
});

test("deviceId kosong diperlakukan seperti tidak ada ingatan", () => {
  const store = memoryStore({ [REMEMBERED_DEVICE_KEY]: "" });
  assert.equal(
    readRememberedDeviceId(store),
    null,
    "sebelum izin, browser memberi id kosong — jangan dianggap device nyata",
  );
});

test("menyimpan device menulis kuncinya", () => {
  const store = memoryStore();
  rememberDeviceId(store, "card-1");
  assert.equal(store.data.get(REMEMBERED_DEVICE_KEY), "card-1");
});

test("menyimpan null / kosong menghapus ingatan, bukan menyimpan sampah", () => {
  const store = memoryStore({ [REMEMBERED_DEVICE_KEY]: "lama" });
  rememberDeviceId(store, null);
  assert.equal(store.data.has(REMEMBERED_DEVICE_KEY), false);

  rememberDeviceId(store, "cam-1");
  rememberDeviceId(store, "");
  assert.equal(store.data.has(REMEMBERED_DEVICE_KEY), false);
});

test("penyimpanan yang melempar saat dibaca/ditulis tidak menjatuhkan alur", () => {
  const throwing: KeyValueStore = {
    getItem: () => {
      throw new Error("diblokir");
    },
    setItem: () => {
      throw new Error("penuh");
    },
    removeItem: () => {
      throw new Error("diblokir");
    },
  };

  assert.equal(readRememberedDeviceId(throwing), null);
  assert.doesNotThrow(() => rememberDeviceId(throwing, "cam-1"));
  assert.doesNotThrow(() => rememberDeviceId(throwing, null));
});
