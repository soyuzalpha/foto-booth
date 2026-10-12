/**
 * Tes PIN kiosk.
 *
 * Yang diuji adalah **sifat keamanan dan angka**, bukan tampilan:
 *
 *   - PIN tidak pernah tersimpan sebagai plaintext (record hanya salt + hash);
 *   - PIN dengan panjang/format salah ditolak sebelum turunan kunci dijalankan;
 *   - pembandingan hash berjalan dengan waktu konstan;
 *   - record yang rusak diperlakukan sebagai "tidak ada PIN", bukan crash.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PIN_HASH_BYTES,
  PIN_ITERATIONS,
  PIN_SALT_BYTES,
  constantTimeEqual,
  createPinRecord,
  isPinFormatValid,
  isPinRecord,
  verifyPin,
  type PinCrypto,
  type PinRecord,
} from "./pin.ts";

/** Kripto palsu: deterministik, tanpa WebCrypto, dan mencatat panggilannya. */
function fakeCrypto(): PinCrypto & { derived: number; salts: number } {
  const state = { derived: 0, salts: 0 };

  return {
    get derived() {
      return state.derived;
    },
    get salts() {
      return state.salts;
    },
    randomBytes: (length) => {
      state.salts += 1;
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = (index * 7 + 3) % 256;
      return bytes;
    },
    deriveBits: async (pin, salt, iterations) => {
      state.derived += 1;
      const bytes = new Uint8Array(PIN_HASH_BYTES);
      // "Hash" palsu: gabungan PIN, salt, dan iterasi — cukup untuk membedakan
      // input tanpa memakai kripto asli.
      for (let index = 0; index < bytes.length; index += 1) {
        const saltByte = salt[index % salt.length] ?? 0;
        const pinByte = pin.charCodeAt(index % pin.length);
        bytes[index] = (saltByte + pinByte + index + iterations) % 256;
      }
      return bytes;
    },
  };
}

test("isPinFormatValid menerima 4–10 digit dan menolak sisanya", () => {
  assert.equal(isPinFormatValid("1234"), true);
  assert.equal(isPinFormatValid("1234567890"), true);

  assert.equal(isPinFormatValid("123"), false, "terlalu pendek");
  assert.equal(isPinFormatValid("12345678901"), false, "terlalu panjang");
  assert.equal(isPinFormatValid("12a4"), false, "bukan angka");
  assert.equal(isPinFormatValid(""), false);
  assert.equal(isPinFormatValid(" 1234"), false, "spasi tidak boleh");
});

test("createPinRecord tidak pernah menyimpan PIN sebagai plaintext", async () => {
  const crypto = fakeCrypto();
  const record = await createPinRecord("4821", crypto);

  assert.equal(record.algo, "PBKDF2-SHA256");
  assert.equal(record.iterations, PIN_ITERATIONS);
  assert.equal(record.salt.length > 0, true);
  assert.equal(record.hash.length > 0, true);

  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("4821"), false, "PIN bocor ke record");
  assert.equal(Object.values(record).includes("4821" as never), false);
});

test("createPinRecord memakai salt acak dan hash sepanjang PIN_HASH_BYTES", async () => {
  const crypto = fakeCrypto();
  const record = await createPinRecord("1234", crypto);

  assert.equal(crypto.salts, 1);
  assert.equal(crypto.derived, 1);

  const salt = Buffer.from(record.salt, "base64");
  const hash = Buffer.from(record.hash, "base64");
  assert.equal(salt.length, PIN_SALT_BYTES);
  assert.equal(hash.length, PIN_HASH_BYTES);
});

test("createPinRecord menolak PIN dengan format salah sebelum menurunkan kunci", async () => {
  const crypto = fakeCrypto();

  await assert.rejects(
    () => createPinRecord("12", crypto),
    (error: unknown) => (error as { code?: string }).code === "invalid-format",
  );
  assert.equal(crypto.derived, 0, "kunci diturunkan padahal PIN tidak valid");
  assert.equal(crypto.salts, 0);
});

test("verifyPin menerima PIN benar dan menolak PIN salah", async () => {
  const crypto = fakeCrypto();
  const record = await createPinRecord("4821", crypto);

  assert.equal(await verifyPin("4821", record, crypto), true);
  assert.equal(await verifyPin("4822", record, crypto), false);
  assert.equal(await verifyPin("9999", record, crypto), false);
});

test("verifyPin mengembalikan false (bukan throw) untuk input cacat", async () => {
  const crypto = fakeCrypto();
  const record = await createPinRecord("4821", crypto);

  assert.equal(await verifyPin("12", record, crypto), false, "format PIN salah");
  assert.equal(
    await verifyPin("4821", { ...record, hash: "" }, crypto),
    false,
    "record cacat",
  );
  assert.equal(
    await verifyPin("4821", { ...record, algo: "MD5" } as unknown as PinRecord, crypto),
    false,
    "algo tidak dikenal",
  );
});

test("verifyPin menghitung ulang dengan iterasi milik record, bukan konstanta modul", async () => {
  const crypto = fakeCrypto();
  const record = await createPinRecord("4821", crypto);
  const weaker: PinRecord = { ...record, iterations: 1 };

  // Hash record dibuat dengan 120_000 iterasi; memverifikasi dengan 1 iterasi
  // harus gagal — kalau modul memakai konstanta, ia akan lolos dan menandakan
  // parameter record diabaikan.
  assert.equal(await verifyPin("4821", weaker, crypto), false);
});

test("constantTimeEqual membandingkan isi, bukan referensi", () => {
  assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])), false);
  assert.equal(constantTimeEqual(new Uint8Array([]), new Uint8Array([])), true);
});

test("isPinRecord menolak bentuk yang tidak lengkap", () => {
  const valid: PinRecord = {
    algo: "PBKDF2-SHA256",
    iterations: 120_000,
    salt: "c2FsdA==",
    hash: "aGFzaA==",
  };

  assert.equal(isPinRecord(valid), true);
  assert.equal(isPinRecord({ ...valid, iterations: 0 }), false);
  assert.equal(isPinRecord({ ...valid, salt: "" }), false);
  assert.equal(isPinRecord({ ...valid, hash: "" }), false);
  assert.equal(isPinRecord({ ...valid, algo: "SHA-1" }), false);
  assert.equal(isPinRecord(null), false);
  assert.equal(isPinRecord("pin"), false);
});
