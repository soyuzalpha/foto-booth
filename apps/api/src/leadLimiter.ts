/**
 * Satu pembatas laju untuk **semua** jalur kiriman data tamu (Fase 9).
 *
 * Kenapa tidak dibuat di dalam `leadRoutes` seperti sebelumnya: tamu tidak
 * mengirim lewat `POST /v1/leads`, melainkan lewat form di halaman galeri
 * (`POST /a/:hash/lead`). Kalau pembatasnya hidup di dalam plugin yang satu
 * itu, jalur yang benar-benar dipakai orang justru yang tidak dijaga — dan
 * sebuah skrip bisa membanjiri tabel leads tanpa pernah menyentuh rutenya.
 *
 * Dikunci per `ctx`, bukan per modul: tiap proses punya konteks sendiri, dan
 * tes membuat konteks baru per kasus. `WeakMap` membuat hitungannya ikut
 * hilang bersama konteksnya, jadi tidak ada kuota yang bocor antar tes.
 */

import { LEAD_RATE_LIMIT, LEAD_RATE_WINDOW_MS } from "@foto-booth/shared";

import type { ServerContext } from "./context.ts";
import { createRateLimiter, type RateLimiter } from "./rateLimit.ts";

const limiters = new WeakMap<ServerContext, RateLimiter>();

/** Pembatas bersama untuk kiriman data tamu pada konteks ini. */
export function leadLimiter(ctx: ServerContext): RateLimiter {
  const existing = limiters.get(ctx);
  if (existing !== undefined) return existing;

  const created = createRateLimiter({ limit: LEAD_RATE_LIMIT, windowMs: LEAD_RATE_WINDOW_MS }, ctx.now);
  limiters.set(ctx, created);
  return created;
}
