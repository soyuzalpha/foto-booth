import type { FastifyInstance } from "fastify";

import { API_PREFIX, APP_VERSION, type Health } from "@foto-booth/shared";

const startedAt = Date.now();

function health(): Health {
  return {
    status: "ok",
    version: APP_VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Dua jalur, satu handler:
  //  - `/health`   → dipakai healthcheck Docker / monitoring infra.
  //  - `/v1/health` → dipakai studio app, konsisten dengan API_PREFIX.
  app.get("/health", async (): Promise<Health> => health());
  app.get(`${API_PREFIX}/health`, async (): Promise<Health> => health());
}
