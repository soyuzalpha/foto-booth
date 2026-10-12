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
 * Katalog ini **dibundel**, bukan diambil dari jaringan pihak ketiga: seluruh
 * berkasnya ada di `apps/api/static/content/<kind>/` dan di-serve statis di
 * `/content/`. Kenapa begitu:
 *
 *   · Aplikasi harus jalan tanpa internet — katalog yang bergantung CDN akan
 *     kosong di kiosk yang offline.
 *   · Studio men-cache katalog ini ke IndexedDB saat sync pertama, jadi
 *     daftarnya tetap tampil setelah jaringan mati.
 *
 * Bentuk respons sudah final sejak Fase 0; Fase 3 mengisinya.
 */

interface CatalogEntry {
  id: string;
  name: string;
  file: string;
  width?: number;
  height?: number;
  tags?: string[];
}

/** Urutan + metadata tiap kategori. Berkasnya sendiri statis. */
const CATALOG: Record<ContentKind, CatalogEntry[]> = {
  starters: [
    { id: "starter-strip-2x6", name: "Strip Klasik 2×6", file: "starter-strip-2x6.json", tags: ["strip", "2x6"] },
    { id: "starter-grid-4x6", name: "Grid Polaroid 4×6", file: "starter-grid-4x6.json", tags: ["grid", "4x6"] },
  ],
  frames: [
    { id: "frame-classic", name: "Bingkai Klasik", file: "frame-classic.svg", width: 600, height: 1800, tags: ["strip"] },
    { id: "frame-polaroid", name: "Bingkai Polaroid", file: "frame-polaroid.svg", width: 600, height: 1800, tags: ["polaroid"] },
  ],
  backgrounds: [
    { id: "bg-cream", name: "Krem Hangat", file: "bg-cream.svg", width: 1200, height: 1800, tags: ["hangat"] },
    { id: "bg-night", name: "Malam Bintang", file: "bg-night.svg", width: 1200, height: 1800, tags: ["gelap", "bintang"] },
  ],
  stickers: [
    { id: "star", name: "Bintang", file: "star.svg", width: 240, height: 240, tags: ["dekorasi"] },
    { id: "cloud", name: "Awan", file: "cloud.svg", width: 320, height: 160, tags: ["dekorasi"] },
  ],
};

export function catalogFor(kind: ContentKind, baseUrl = ""): ContentItem[] {
  return CATALOG[kind].map((entry) => {
    const item: ContentItem = {
      id: entry.id,
      kind,
      name: entry.name,
      url: `${baseUrl}/content/${kind}/${entry.file}`,
      tags: entry.tags ?? [],
    };
    if (entry.width !== undefined) item.width = entry.width;
    if (entry.height !== undefined) item.height = entry.height;
    return item;
  });
}

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

      const items = catalogFor(kind satisfies ContentKind);
      return { kind: kind satisfies ContentKind, items };
    },
  );
}
