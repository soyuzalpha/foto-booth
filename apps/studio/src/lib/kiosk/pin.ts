/**
 * PIN lock kiosk (Fase 4, FEATURE-MATRIX §B49 / §A17).
 *
 * Aturan yang dipegang modul ini:
 *  - PIN **tidak pernah** disimpan sebagai plaintext. Yang disimpan hanya
 *    salt acak + hash PBKDF2-SHA256.
 *  - Pembandingan hash memakai waktu konstan supaya panjang kecocokan tidak
 *    bocor lewat timing.
 *  - Semua sumber non-deterministik (byte acak, turunan kunci) **injectable**,
 *    supaya tes tidak bergantung pada WebCrypto dan bisa memeriksa perilaku
 *    gagal dengan pasti.
 */

export type PinAlgo = "PBKDF2-SHA256";

export interface PinRecord {
  algo: PinAlgo;
  iterations: number;
  /** Salt acak, base64. */
  salt: string;
  /** Hash turunan, base64. */
  hash: string;
}

/** Sumber kripto yang bisa diganti di tes. */
export interface PinCrypto {
  randomBytes(length: number): Uint8Array;
  deriveBits(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array>;
}

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 10;
/** Cukup mahal untuk brute-force offline, masih < 0,5 dtk di perangkat kiosk. */
export const PIN_ITERATIONS = 120_000;
export const PIN_SALT_BYTES = 16;
export const PIN_HASH_BYTES = 32;

export class PinError extends Error {
  readonly code: "invalid-format" | "invalid-record";

  constructor(code: "invalid-format" | "invalid-record", message: string) {
    super(message);
    this.name = "PinError";
    this.code = code;
  }
}

/** PIN kiosk: 4–10 digit angka. Dipilih angka saja supaya cocok dengan keypad. */
export function isPinFormatValid(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Bandingkan dua buffer tanpa keluar lebih awal saat byte pertama berbeda. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

/** Cek bentuk record dari storage — record rusak diperlakukan sebagai "tidak ada PIN". */
export function isPinRecord(value: unknown): value is PinRecord {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  return (
    record.algo === "PBKDF2-SHA256" &&
    typeof record.iterations === "number" &&
    record.iterations > 0 &&
    typeof record.salt === "string" &&
    record.salt.length > 0 &&
    typeof record.hash === "string" &&
    record.hash.length > 0
  );
}

export async function createPinRecord(
  pin: string,
  crypto: PinCrypto = webCryptoPin(),
): Promise<PinRecord> {
  if (!isPinFormatValid(pin)) {
    throw new PinError(
      "invalid-format",
      `PIN harus ${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digit angka.`,
    );
  }

  const salt = crypto.randomBytes(PIN_SALT_BYTES);
  const hash = await crypto.deriveBits(pin, salt, PIN_ITERATIONS);

  return {
    algo: "PBKDF2-SHA256",
    iterations: PIN_ITERATIONS,
    salt: toBase64(salt),
    hash: toBase64(hash),
  };
}

/**
 * Verifikasi PIN. Mengembalikan `false` (bukan melempar) untuk PIN yang bentuknya
 * salah, supaya jalur "PIN salah" di UI tidak perlu menangkap exception.
 */
export async function verifyPin(
  pin: string,
  record: PinRecord,
  crypto: PinCrypto = webCryptoPin(),
): Promise<boolean> {
  if (!isPinFormatValid(pin)) return false;
  if (!isPinRecord(record)) return false;

  const expected = fromBase64(record.hash);
  const actual = await crypto.deriveBits(pin, fromBase64(record.salt), record.iterations);

  return constantTimeEqual(actual, expected);
}

/** Implementasi WebCrypto asli (dipakai di browser & Node 24). */
export function webCryptoPin(): PinCrypto {
  return {
    randomBytes: (length) => {
      const bytes = new Uint8Array(length);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    },
    deriveBits: async (pin, salt, iterations) => {
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(pin),
        "PBKDF2",
        false,
        ["deriveBits"],
      );

      const bits = await globalThis.crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
        key,
        PIN_HASH_BYTES * 8,
      );

      return new Uint8Array(bits);
    },
  };
}
