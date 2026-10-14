/**
 * Branding / white-label (Fase 9, FEATURE-MATRIX #61).
 *
 * Operator mengganti logo, judul, subjudul, dan catatan kaki halaman galeri
 * tamu supaya klien melihat nama acaranya, bukan nama aplikasi.
 *
 * Dua permukaan:
 *
 *   · **`GET /v1/branding`** — publik. Halaman galeri tamu perlu tahu judul
 *     apa yang dipasang; ini informasi yang memang dilihat semua tamu, jadi
 *     tidak ada alasan menyembunyikannya di balik token.
 *   · **`PUT /v1/branding/admin`** — operator. Butuh token sesi seperti rute
 *     galeri; prefix `admin` menjaga rute publik tidak bisa "naik" jadi
 *     operator karena salah bentuk URL.
 *
 * Yang dijaga di sini, dan kenapa:
 *
 *   · **Nilai disimpan lewat `normalizeBranding`, bukan apa adanya.** Body
 *     yang dikirim operator bisa memuat `javascript:` di `logoUrl` atau baris
 *     baru di `heading`; nilai itu dirender ke HTML halaman tamu, jadi satu
 *     yang lolos berarti skrip jalan di browser semua tamu.
 *   · **PUT bersifat gabung, bukan ganti total.** Operator yang cuma mengubah
 *     judul tidak boleh menghapus logonya. Field yang tidak dikirim dibiarkan.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  DEFAULT_BRANDING,
  UpdateBrandingSchema,
  brandingIsDefault,
  normalizeBranding,
  type Branding,
} from "@foto-booth/shared";

import { authenticate } from "../auth.ts";
import type { ServerContext } from "../context.ts";
import { getBranding, saveBranding } from "../store.ts";

const INVALID = (message: string) => ({ error: "invalid_request", message, statusCode: 400 });
const UNAUTHORIZED = (status: number, message: string) => ({ error: "unauthorized", message, statusCode: status });

/** Branding tersimpan atau default — dipakai halaman tamu yang selalu butuh nilai. */
function brandingOf(ctx: ServerContext): Branding {
  return getBranding(ctx.db) ?? { ...DEFAULT_BRANDING };
}

export async function brandingRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const guard = (request: FastifyRequest) => authenticate(request, ctx);

  app.get("/v1/branding", async (_request, reply) => {
    const branding = brandingOf(ctx);
    return reply.send({ branding, isDefault: brandingIsDefault(branding) });
  });

  app.put("/v1/branding/admin", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const parsed = UpdateBrandingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));
    }

    // Gabung di atas nilai yang sudah ada supaya field yang tidak dikirim
    // benar-benar dibiarkan — `logoUrl: null` yang eksplisit tetap menghapus.
    const current = brandingOf(ctx);
    const merged = normalizeBranding({ ...current, ...parsed.data });

    saveBranding(ctx.db, merged, ctx.now().toISOString());
    return reply.send({ branding: merged, isDefault: brandingIsDefault(merged) });
  });
}
