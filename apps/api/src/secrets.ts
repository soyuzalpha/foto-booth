/**
 * Rahasia: id, token, hash password galeri, hash kode OTP.
 *
 * Satu modul, karena semua yang di sini punya aturan yang sama:
 * **tidak pernah menyimpan rahasia apa adanya, dan tidak pernah membandingkan
 * dengan `===`.** Perbandingan biasa keluar di byte pertama yang berbeda, jadi
 * waktu balasannya membocorkan berapa huruf yang sudah benar.
 *
 * Kripto-nya diambil dari `node:crypto` (bukan WebCrypto) supaya modul ini bisa
 * dipakai tanpa `globalThis.crypto` dan bisa disuntik di tes.
 */

import {
  createHash,
  randomBytes as nodeRandomBytes,
  pbkdf2 as nodePbkdf2,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(nodePbkdf2) as (
  password: string | Buffer,
  salt: string | Buffer,
  iterations: number,
  keylen: number,
  digest: string,
) => Promise<Buffer>;

/** Sumber acak — injectable supaya id/token bisa diprediksi di tes. */
export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export const nodeRandom: RandomSource = {
  bytes: (length) => new Uint8Array(nodeRandomBytes(length)),
};

/** Sama mahal dengan PIN kiosk; cukup untuk brute-force offline. */
export const HASH_ITERATIONS = 120_000;
export const SALT_BYTES = 16;
export const HASH_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Id acak ber-prefix, aman untuk dipakai di URL & nama key objek. */
export function newId(prefix: string, random: RandomSource = nodeRandom, bytes = 9): string {
  return `${prefix}_${toBase64Url(random.bytes(bytes))}`;
}

/**
 * Bagian URL publik galeri: `/a/<hash>`.
 *
 * 12 byte (96 bit) base64url → 16 karakter. Sengaja **tanpa prefix** dan tanpa
 * karakter yang bikin salah ketik waktu orang menyalin dari QR.
 */
export function newGalleryHash(random: RandomSource = nodeRandom): string {
  return toBase64Url(random.bytes(12));
}

export interface SecretHash {
  salt: string;
  hash: string;
}

/**
 * Hash rahasia (password galeri / kode OTP). Salt selalu acak & disimpan
 * bersama hash-nya — dua galeri dengan password sama tidak boleh punya hash sama.
 */
export async function hashSecret(secret: string, random: RandomSource = nodeRandom): Promise<SecretHash> {
  const salt = random.bytes(SALT_BYTES);
  const derived = await pbkdf2Async(secret, Buffer.from(salt), HASH_ITERATIONS, HASH_BYTES, "sha256");
  return { salt: toBase64Url(salt), hash: derived.toString("base64url") };
}

/**
 * Verifikasi rahasia dengan waktu konstan.
 *
 * Record yang bentuknya rusak → `false`, bukan lempar: jalur "password salah"
 * di UI tidak boleh butuh `try/catch`.
 */
export async function verifySecret(
  secret: string,
  stored: { salt: string | null; hash: string | null },
): Promise<boolean> {
  if (stored.salt === null || stored.hash === null) return false;

  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(stored.hash, "base64url");
    salt = Buffer.from(stored.salt, "base64url");
  } catch {
    return false;
  }
  if (expected.length !== HASH_BYTES || salt.length !== SALT_BYTES) return false;

  const actual = await pbkdf2Async(secret, salt, HASH_ITERATIONS, HASH_BYTES, "sha256");
  return timingSafeEqual(actual, expected);
}

/**
 * Bandingkan dua string dengan waktu konstan.
 *
 * Dipakai untuk membandingkan hash/token yang sudah berukuran tetap. String
 * dengan panjang berbeda langsung `false` — itu memang membocorkan panjang,
 * tapi panjangnya sudah publik (semua token kita 43 karakter).
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Kode OTP 6 digit dari sumber acak. Bisa punya nol di depan. */
export function newOtpCode(random: RandomSource = nodeRandom): string {
  const bytes = random.bytes(4);
  const value =
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  // `>>> 0` supaya tetap bilangan tak bertanda sebelum modulo.
  return String((value >>> 0) % 1_000_000).padStart(6, "0");
}

/** SHA-256 hex — untuk sidik jari deterministik (mis. fingerprint URL presigned). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
