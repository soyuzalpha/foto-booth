import test from "node:test";
import assert from "node:assert/strict";

import { initSentry, isValidDsn, normalizeError, type SentrySdk } from "./sentry.ts";

/** SDK palsu yang mencatat apa yang diterimanya. */
function fakeSdk(): SentrySdk & { inits: unknown[]; errors: unknown[]; messages: unknown[] } {
  const inits: unknown[] = [];
  const errors: unknown[] = [];
  const messages: unknown[] = [];
  return {
    inits,
    errors,
    messages,
    init(options) {
      inits.push(options);
    },
    captureException(error, context) {
      errors.push({ error, context });
    },
    captureMessage(message, level) {
      messages.push({ message, level });
    },
  };
}

const DSN = "https://abc123@o1.ingest.sentry.io/42";

test("isValidDsn menerima DSN Sentry standar & menolak yang asal", () => {
  assert.equal(isValidDsn(DSN), true);
  assert.equal(isValidDsn(""), false);
  assert.equal(isValidDsn("http://abc@host/1"), false, "harus https");
  assert.equal(isValidDsn("https://host/1"), false, "tanpa kunci");
  assert.equal(isValidDsn("https://abc@host/"), false, "tanpa project");
  assert.equal(isValidDsn("https://abc@host/xyz"), false, "project harus angka");
});

test("tanpa DSN → nonaktif, tidak memuat SDK, tidak menyentuh jaringan", async () => {
  let loaded = 0;
  const handle = initSentry({
    dsn: undefined,
    loadSdk: async () => {
      loaded += 1;
      return fakeSdk();
    },
  });

  await handle.ready;
  assert.equal(handle.enabled, false);
  assert.equal(loaded, 0, "SDK tidak boleh dimuat tanpa DSN");

  // capture harus aman dipanggil walau nonaktif.
  assert.doesNotThrow(() => handle.captureError(new Error("x")));
  assert.doesNotThrow(() => handle.captureMessage("y"));
});

test("DSN tidak valid diperlakukan seperti tanpa DSN", async () => {
  const handle = initSentry({ dsn: "bukan-dsn", loadSdk: async () => fakeSdk() });
  await handle.ready;
  assert.equal(handle.enabled, false);
});

test("DSN valid → SDK dimuat, init dipanggil, capture diteruskan", async () => {
  const sdk = fakeSdk();
  const handle = initSentry({
    dsn: DSN,
    environment: "production",
    release: "0.1.0",
    loadSdk: async () => sdk,
  });

  assert.equal(handle.enabled, true);
  await handle.ready;

  assert.equal(sdk.inits.length, 1);
  assert.deepEqual(sdk.inits[0], { dsn: DSN, environment: "production", release: "0.1.0" });

  handle.captureError(new Error("boom"), { stage: "filter" });
  handle.captureMessage("halo", "warning");
  assert.equal(sdk.errors.length, 1);
  assert.equal(sdk.messages.length, 1);
});

test("capture sebelum SDK selesai dimuat tidak melempar", () => {
  const sdk = fakeSdk();
  const handle = initSentry({ dsn: DSN, loadSdk: async () => sdk });
  // Belum `await ready` — SDK masih null di dalam.
  assert.doesNotThrow(() => handle.captureError(new Error("awal")));
});

test("pemuatan SDK gagal → onLoadError dipanggil, tetap no-op, tidak crash", async () => {
  let caught: unknown = null;
  const handle = initSentry({
    dsn: DSN,
    loadSdk: async () => {
      throw new Error("paket tidak ada");
    },
    onLoadError: (error) => {
      caught = error;
    },
  });

  await handle.ready;
  assert.ok(caught instanceof Error);
  assert.equal(handle.enabled, true, "DSN ada, jadi 'enabled' tetap true");
  assert.doesNotThrow(() => handle.captureError(new Error("x")));
});

test("loader mengembalikan null (paket tak terpasang) → tidak crash", async () => {
  const handle = initSentry({ dsn: DSN, loadSdk: async () => null });
  await handle.ready;
  assert.doesNotThrow(() => handle.captureMessage("z"));
});

test("normalizeError mengubah error apa pun jadi bentuk yang aman dikirim", () => {
  assert.deepEqual(normalizeError(new TypeError("salah tipe")), {
    message: "salah tipe",
    name: "TypeError",
  });
  assert.deepEqual(normalizeError("teks"), { message: "teks", name: "Error" });
  assert.deepEqual(normalizeError({ a: 1 }), { message: '{"a":1}', name: "Error" });
});
