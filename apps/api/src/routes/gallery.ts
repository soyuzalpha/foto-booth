import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import {
  GalleryPublicSchema,
  GALLERY_BASE_PATH,
  GALLERY_TTL_DAYS,
  type GalleryPublic,
} from "@foto-booth/shared";

import { STORAGE_DIR } from "../paths.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Fase 0: galeri dibaca dari `storage/galleries/<hash>.json`.
 *
 * Postgres + S3 + upload presigned masuk Fase 5; yang penting sekarang bentuk
 * halaman + meta OG-nya sudah benar, karena itulah bagian yang dipakai
 * WhatsApp/Instagram saat link dibagikan.
 */
async function loadGallery(hash: string): Promise<GalleryPublic | null> {
  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(hash)) return null;

  try {
    const raw = await readFile(join(STORAGE_DIR, "galleries", `${hash}.json`), "utf8");
    const parsed = GalleryPublicSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function shell(title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${head}
<style>
  :root { --ink:#0a0a0a; --paper:#fffdf5; --accent:#ffd93d; --pink:#ff6b9d; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; }
  .card { max-width:640px; width:100%; background:#fff; border:4px solid var(--ink);
          box-shadow:12px 12px 0 var(--ink); padding:32px; }
  h1 { margin:0 0 8px; font-size:clamp(28px,7vw,44px); line-height:1; letter-spacing:-.02em; }
  p  { margin:0 0 20px; font-size:16px; line-height:1.5; }
  .badge { display:inline-block; background:var(--accent); border:3px solid var(--ink);
           padding:4px 12px; font-weight:800; font-size:13px; text-transform:uppercase;
           letter-spacing:.06em; margin-bottom:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:14px; margin:20px 0 0; }
  .grid img { width:100%; aspect-ratio:3/4; object-fit:cover; border:3px solid var(--ink); background:#eee; }
  a.btn { display:inline-block; background:var(--pink); color:var(--ink); border:3px solid var(--ink);
          box-shadow:5px 5px 0 var(--ink); padding:12px 22px; font-weight:800; text-decoration:none; }
</style>
</head>
<body><main class="card">${body}</main></body>
</html>`;
}

export async function galleryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { hash: string } }>(
    `${GALLERY_BASE_PATH}:hash`,
    async (request, reply) => {
      const gallery = await loadGallery(request.params.hash);
      const publicUrl = `${request.protocol}://${request.host}${request.url}`;

      if (!gallery) {
        return reply
          .status(404)
          .type("text/html; charset=utf-8")
          .send(
            shell(
              "Galeri tidak ditemukan",
              `<span class="badge">404</span>
               <h1>Galeri tidak ditemukan</h1>
               <p>Link-nya salah, atau galeri sudah kedaluwarsa. Galeri tamu otomatis
                  dihapus ${GALLERY_TTL_DAYS} hari setelah dibuat.</p>
               <a class="btn" href="/">Kembali ke beranda</a>`,
            ),
          );
      }

      const ogHead = `<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(gallery.event.name)}">
<meta property="og:description" content="Foto dari ${escapeHtml(gallery.event.date)} — ambil & bagikan.">
<meta property="og:image" content="${escapeHtml(new URL(`${GALLERY_BASE_PATH}${gallery.hash}/og.png`, publicUrl).href)}">
<meta property="og:url" content="${escapeHtml(publicUrl)}">
<meta name="twitter:card" content="summary_large_image">`;

      const photos = gallery.photos
        .map((photo) => `<img src="${escapeHtml(photo.thumbUrl)}" alt="" loading="lazy">`)
        .join("");

      return reply.type("text/html; charset=utf-8").send(
        shell(
          gallery.event.name,
          `<span class="badge">Galeri tamu</span>
           <h1>${escapeHtml(gallery.event.name)}</h1>
           <p>${escapeHtml(gallery.event.date)}${gallery.event.hashtag ? ` · ${escapeHtml(gallery.event.hashtag)}` : ""}</p>
           <div class="grid">${photos}</div>`,
          ogHead,
        ),
      );
    },
  );
}
