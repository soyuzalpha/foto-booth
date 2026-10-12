import { existsSync } from "node:fs";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import { APP_NAME, APP_VERSION, STUDIO_BASE_PATH } from "@foto-booth/shared";

import { CONTENT_DIR, LANDING_DIR, STUDIO_DIST_DIR } from "./paths.ts";
import { contentRoutes } from "./routes/content.ts";
import { galleryRoutes } from "./routes/gallery.ts";
import { healthRoutes } from "./routes/health.ts";

export async function buildApp(
  options: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: true,
  });

  // Urutan tidak menentukan prioritas (router Fastify menang urut spesifisitas:
  // static > param > wildcard), tapi didaftarkan dulu supaya jelas.
  await healthRoutes(app);
  await galleryRoutes(app);
  await contentRoutes(app);

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
