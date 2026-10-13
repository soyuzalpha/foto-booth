/**
 * Alur masuk operator: minta kode OTP → tukar kode dengan token sesi.
 *
 * Dua rute, dan sengaja tidak ada yang lain: tidak ada registrasi, tidak ada
 * reset password, tidak ada daftar pengguna. Aplikasi ini dipakai satu orang.
 *
 * Aturan yang dijaga:
 *
 *   · **Kode OTP tidak pernah disimpan apa adanya** — hanya hash PBKDF2 + salt.
 *   · **Satu kode aktif per email.** Minta ulang membatalkan kode lama, jadi
 *     permintaan berulang tidak memperbesar peluang tebakan.
 *   · **Salah berkali-kali membuang kode.** Setelah `OTP_MAX_ATTEMPTS`, kode
 *     dihapus dan operator harus minta baru — menutup tebakan 6 digit bertubi.
 *   · **Balasan tidak pernah membedakan** "email belum pernah minta kode" dari
 *     "kode salah" — sama-sama 400 dengan pesan yang sama.
 */

import type { FastifyInstance } from "fastify";

import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MINUTES,
  OtpRequestSchema,
  OtpVerifySchema,
  SESSION_TTL_HOURS,
  type OtpRequested,
  type Session,
} from "@foto-booth/shared";

import { signJwt } from "../jwt.ts";
import { hashSecret, newOtpCode, verifySecret } from "../secrets.ts";
import { bumpOtpAttempts, deleteOtp, getOtp, upsertOtp } from "../store.ts";
import type { ServerContext } from "../context.ts";

/** Pesan yang sama untuk semua kegagalan verifikasi. */
const VERIFY_FAILED = "kode tidak valid atau sudah kedaluwarsa";

export async function authRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.post("/v1/auth/otp/request", async (request, reply) => {
    const parsed = OtpRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", message: "email tidak valid", statusCode: 400 });
    }

    const email = parsed.data.email.toLowerCase();
    const now = ctx.now();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60_000);
    const code = newOtpCode();
    const { salt, hash } = await hashSecret(code);

    // Menimpa kode lama: satu kode aktif per email.
    upsertOtp(ctx.db, { email, codeHash: hash, salt, expiresAt: expiresAt.toISOString() }, now.toISOString());
    await ctx.mailer.send(email, code, expiresAt);

    const body: OtpRequested & { code?: string } = {
      sent: true,
      expiresAt: expiresAt.toISOString(),
    };
    // Hanya di mode dev — supaya bisa dicoba tanpa kotak masuk.
    if (ctx.exposeOtpCode) body.code = code;

    return reply.status(202).send(body);
  });

  app.post("/v1/auth/otp/verify", async (request, reply) => {
    const parsed = OtpVerifySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", message: VERIFY_FAILED, statusCode: 400 });
    }

    const email = parsed.data.email.toLowerCase();
    const now = ctx.now();
    const stored = getOtp(ctx.db, email);

    if (stored === null) {
      return reply.status(400).send({ error: "invalid_code", message: VERIFY_FAILED, statusCode: 400 });
    }

    if (new Date(stored.expiresAt).getTime() <= now.getTime()) {
      deleteOtp(ctx.db, email);
      return reply.status(400).send({ error: "expired_code", message: VERIFY_FAILED, statusCode: 400 });
    }

    const matches = await verifySecret(parsed.data.code, { salt: stored.salt, hash: stored.codeHash });

    if (!matches) {
      const attempts = bumpOtpAttempts(ctx.db, email);
      if (attempts >= OTP_MAX_ATTEMPTS) {
        // Kode dibuang: penyerang tidak bisa melanjutkan tebakan.
        deleteOtp(ctx.db, email);
      }
      return reply.status(400).send({ error: "invalid_code", message: VERIFY_FAILED, statusCode: 400 });
    }

    // Sukses → kode langsung mati, tidak bisa dipakai dua kali.
    deleteOtp(ctx.db, email);

    const { token, payload } = signJwt(email, ctx.jwtSecret, {
      expiresInSeconds: SESSION_TTL_HOURS * 3600,
      now,
    });

    const session: Session = {
      token,
      email,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
    return reply.status(200).send(session);
  });
}
