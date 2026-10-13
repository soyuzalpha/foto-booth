/**
 * JWT HS256 — ditulis tangan, tanpa dependensi.
 *
 * Yang dipakai cuma satu algoritma (`HS256`) dan satu tujuan (token sesi
 * operator, umur 7 hari). Library JWT menambahkan ~1 MB dan — lebih penting —
 * permukaan serangan `alg: none` / algorithm-confusion yang harus diingat untuk
 * dimatikan. Di sini algoritmanya **literal**: header dibuat sendiri, dan token
 * yang headernya bukan HS256 ditolak sebelum signature diperiksa.
 *
 * Token ini membuktikan "email ini sudah memverifikasi OTP", bukan otorisasi
 * halus. Karena itu payload-nya kecil dan tidak memuat hak akses.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtPayload {
  /** Subject: email operator. */
  sub: string;
  /** Issued at (detik epoch). */
  iat: number;
  /** Expiry (detik epoch). */
  exp: number;
}

export class JwtError extends Error {
  readonly code: "malformed" | "bad-signature" | "expired" | "bad-algorithm";

  constructor(code: JwtError["code"], message: string) {
    super(message);
    this.name = "JwtError";
    this.code = code;
  }
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64url");
}

/** Terbitkan token. `expiresInSeconds` dihitung dari `now`. */
export function signJwt(
  subject: string,
  secret: string,
  options: { expiresInSeconds: number; now?: Date },
): { token: string; payload: JwtPayload } {
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const payload: JwtPayload = {
    sub: subject,
    iat: nowSeconds,
    exp: nowSeconds + options.expiresInSeconds,
  };

  // Urutan key header penting: `{"alg":"HS256","typ":"JWT"}` — jangan diubah.
  const header = base64UrlEncode('{"alg":"HS256","typ":"JWT"}');
  const body = base64UrlEncode(JSON.stringify(payload));
  const data = `${header}.${body}`;

  return { token: `${data}.${sign(data, secret)}`, payload };
}

/**
 * Verifikasi token. Melempar `JwtError` dengan kode spesifik — pemanggil perlu
 * membedakan "token kedaluwarsa" (klien harus OTP lagi) dari "signature palsu"
 * (permintaan mencurigakan), dan itu tidak bisa dibedakan dari `false`.
 */
export function verifyJwt(token: string, secret: string, options: { now?: Date } = {}): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed", "token bukan tiga bagian");

  const [header, body, signature] = parts as [string, string, string];

  // Periksa algoritma SEBELUM signature: token `alg: none` tidak boleh sampai
  // ke jalur verifikasi sama sekali.
  let parsedHeader: unknown;
  try {
    parsedHeader = JSON.parse(base64UrlDecode(header));
  } catch {
    throw new JwtError("malformed", "header bukan JSON");
  }
  if (
    typeof parsedHeader !== "object" ||
    parsedHeader === null ||
    (parsedHeader as Record<string, unknown>).alg !== "HS256"
  ) {
    throw new JwtError("bad-algorithm", "hanya HS256 yang diterima");
  }

  const expected = Buffer.from(sign(`${header}.${body}`, secret), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new JwtError("bad-signature", "signature tidak cocok");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(body));
  } catch {
    throw new JwtError("malformed", "payload bukan JSON");
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>).sub !== "string" ||
    typeof (payload as Record<string, unknown>).exp !== "number"
  ) {
    throw new JwtError("malformed", "payload tidak punya sub/exp");
  }

  const claims = payload as JwtPayload;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.exp <= nowSeconds) throw new JwtError("expired", "token sudah kedaluwarsa");

  return claims;
}

/** Ambil token dari header `Authorization: Bearer <token>`. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
