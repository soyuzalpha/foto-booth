import { existsSync } from "node:fs";
import { parse as parseQuerystring } from "node:querystring";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import { APP_NAME, APP_VERSION, STUDIO_BASE_PATH } from "@foto-booth/shared";

import { CONTENT_DIR, LANDING_DIR, STUDIO_DIST_DIR } from "./paths.ts";
import type { ServerContext } from "./context.ts";
import { authRoutes } from "./routes/auth.ts";
import { bookingPageRoutes } from "./routes/booking-pages.ts";
import { bookingRoutes } from "./routes/booking.ts";
import { contentRoutes } from "./routes/content.ts";
import { analyticsRoutes } from "./routes/analytics.ts";
import { galleryRoutes } from "./routes/gallery.ts";
import { galleryOperatorRoutes } from "./routes/galleries.ts";
import { healthRoutes } from "./routes/health.ts";
import { leadRoutes } from "./routes/leads.ts";
import { modelRoutes } from "./routes/models.ts";
import { scheduleTtlCleanup } from "./jobs/ttl.ts";

/**
 * Bangun aplikasi Fastify.
 *
 * `ctx` wajib: semua ketergantungan luar (DB, bucket, jam, `fetch`, rahasia)
 * datang dari sana, jadi tes bisa membangun app dengan konteks palsu tanpa
 * menyentuh disk atau jaringan.
 */
export async function buildApp(
  ctx: ServerContext,
  options: { logger?: boolean; ttlJob?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: true,
  });

  // Urutan tidak menentukan prioritas (router Fastify menang urut spesifisitas:
  // static > param > wildcard), tapi didaftarkan dulu supaya jelas.
  await healthRoutes(app);

  // Browser mengirim form HTML sebagai `application/x-www-form-urlencoded`, dan
  // Fastify hanya mem-parse JSON & text/plain secara bawaan. Tanpa parser ini
  // setiap POST dari form dijawab 415 — halaman buka-kunci galeri jadi mustahil
  // dipakai dari browser, walau handler-nya benar.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, parseQuerystring(body as string));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  await authRoutes(app, ctx);
  // Galeri operator didaftarkan sebelum galeri publik: `/v1/galleries` (API)
  // dan `/a/:hash` (halaman tamu) tidak bertabrakan, tapi urutan ini membuat
  // jelas mana yang internal.
  await galleryOperatorRoutes(app, ctx);
  await galleryRoutes(app, ctx);
  // Booking: API JSON dulu, baru halaman HTML-nya. Halaman `/booking/s/:token`
  // dan rute API `/v1/booking/status/:token` tidak bertabrakan (prefix beda),
  // tapi mendaftarkan API lebih dulu menjaga keduanya jelas terpisah.
  await bookingRoutes(app, ctx);
  await bookingPageRoutes(app, ctx);
  await contentRoutes(app);
  // Leads tamu + konfigurasi field operator, dan dasbor analytics. Didaftarkan
  // setelah galeri karena rute publiknya (`/v1/leads/*`) memakai hash galeri
  // yang sama — urutan di sini hanya soal keterbacaan, router Fastify memilih
  // berdasarkan spesifisitas.
  await leadRoutes(app, ctx);
  await analyticsRoutes(app, ctx);

  // Model AI statis (`$STORAGE_DIR/models/`) — read-only, di luar git.
  await modelRoutes(app);

  // Job TTL: galeri lewat 30 hari dihapus (objek dulu, baru baris). Dimatikan
  // di tes supaya tidak ada timer latar yang mengubah hasil.
  if (options.ttlJob !== false) {
    scheduleTtlCleanup(ctx, { logger: app.log });
  }

  // Katalog konten yang dibundel — di-serve statis supaya studio bisa
  // meng-cache-nya untuk mode offline.
  await app.register(fastifyStatic, {
    root: CONTENT_DIR,
    prefix: "/content/",
    decorateReply: false,
  });

  // Landing page (neo-brutalism) di `/`.
  await app.register(fastifyStatic, {
    root: LANDING_DIR,
    prefix: "/",
    index: ["index.html"],
    decorateReply: false,
  });

  // Studio SPA di `/studio/`. Belum ada sebelum `pnpm build` dijalankan.
  if (existsSync(STUDIO_DIST_DIR)) {
    await app.register(fastifyStatic, {
      root: STUDIO_DIST_DIR,
      prefix: STUDIO_BASE_PATH,
      index: ["index.html"],
      decorateReply: false,
    });
  } else {
    app.log.warn(
      { dir: STUDIO_DIST_DIR },
      "studio/dist belum ada — SPA belum di-serve. Jalankan `pnpm --filter @foto-booth/studio build`.",
    );
  }

  app.get("/version", async () => ({ name: APP_NAME, version: APP_VERSION }));

  return app;
}
