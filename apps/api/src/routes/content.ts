import type { FastifyInstance } from "fastify";

import {
  API_PREFIX,
  type ContentItem,
  type ContentKind,
  isContentKind,
} from "@foto-booth/shared";

/**
 * Content library (starters / frames / backgrounds / stickers).
 *
 * Fase 0: katalog masih kosong — route sudah ada dengan bentuk respons final
 * supaya studio app bisa dikembangkan terhadap kontrak yang sebenarnya.
 * Pengisian katalog + cache CDN masuk Fase 2.
 */
export async function contentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { kind: string } }>(
    `${API_PREFIX}/content/:kind`,
    async (request, reply) => {
      const { kind } = request.params;

      if (!isContentKind(kind)) {
        return reply.status(404).send({
          error: "not_found",
          message: `Kategori konten tidak dikenal: ${kind}`,
          statusCode: 404,
        });
      }

      const items: ContentItem[] = [];
      return { kind: kind satisfies ContentKind, items };
    },
  );
}
