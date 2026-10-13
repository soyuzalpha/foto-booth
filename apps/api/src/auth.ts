/**
 * Penjaga rute operator.
 *
 * Yang dijaga bukan "apakah orang ini punya akun" — tidak ada akun di sini.
 * Yang dijaga adalah "apakah pemanggil sudah membuktikan dia memegang email
 * operator", dan buktinya adalah JWT dari alur OTP.
 *
 * Dipisah dari route supaya aturannya cuma ada di satu tempat: kalau nanti
 * entitlement juga menentukan hak, perubahannya di sini, bukan di sepuluh
 * handler.
 */

import type { FastifyRequest } from "fastify";

import { bearerToken, verifyJwt, JwtError } from "./jwt.ts";
import type { ServerContext } from "./context.ts";

export interface Operator {
  email: string;
}

export type AuthResult =
  | { ok: true; operator: Operator }
  | { ok: false; status: 401; message: string };

/**
 * Baca & verifikasi token operator dari header `Authorization`.
 *
 * Pesan errornya sengaja dibedakan untuk klien ("token kedaluwarsa" ≠ "token
 * tidak valid") tapi tidak pernah membocorkan isi token.
 */
export function authenticate(request: FastifyRequest, ctx: ServerContext): AuthResult {
  const token = bearerToken(request.headers.authorization);
  if (token === null) {
    return { ok: false, status: 401, message: "butuh header Authorization: Bearer <token>" };
  }

  try {
    const claims = verifyJwt(token, ctx.jwtSecret, { now: ctx.now() });
    return { ok: true, operator: { email: claims.sub } };
  } catch (error) {
    if (error instanceof JwtError && error.code === "expired") {
      return { ok: false, status: 401, message: "sesi kedaluwarsa — minta kode OTP baru" };
    }
    return { ok: false, status: 401, message: "token tidak valid" };
  }
}
