/**
 * Halaman galeri tamu — satu-satunya bagian publik dari aplikasi.
 *
 * Yang penting di sini bukan tampilannya, tapi tiga hal yang gampang salah:
 *
 *   1. **Meta OG benar.** Link ini disebar lewat WhatsApp/Instagram; kalau
 *      `og:image` tidak ada atau menunjuk URL yang butuh cookie, preview-nya
 *      kosong dan orang tidak mengkliknya.
 *   2. **Bucket tetap privat.** Foto tidak pernah punya URL publik langsung —
 *      byte-nya diproksi lewat server ini. Bucket Garage-nya hanya mendengarkan
 *      di `127.0.0.1`, jadi memproksi bukan kemalasan: itu memang satu-satunya
 *      jalan yang tidak membuka bucket ke internet.
 *   3. **Galeri berpassword benar-benar tertutup.** Bukan menyembunyikan
 *      tautan: byte foto tidak dikirim sebelum password diverifikasi.
 *
 * Halaman ini dirender sebagai HTML dari server (bukan SPA) supaya bisa dibuka
 * tanpa JavaScript dan bisa dibaca crawler preview link.
 */

import { Readable } from "node:stream";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  GALLERY_BASE_PATH,
  GALLERY_TTL_DAYS,
  LEAD_CONSENT_TEXT,
  UnlockGallerySchema,
  activeFieldsFor,
  type Gallery,
  type LeadField,
} from "@foto-booth/shared";

import { signJwt, verifyJwt } from "../jwt.ts";
import { getObject } from "../objectStore.ts";
import { verifySecret } from "../secrets.ts";
import {
  bumpGalleryView,
  getEvent,
  getGalleryByHash,
  getGalleryPassword,
  listLeadFields,
  listPhotos,
} from "../store.ts";
import type { ServerContext } from "../context.ts";
import { leadLimiter } from "../leadLimiter.ts";
import { errorPage, escapeHtml, shell } from "../pages.ts";
import { storeLead } from "./leads.ts";
import { buildZip, type ZipEntry } from "../zip.ts";

/** Umur cookie buka-kunci. Cukup untuk sesi berbagi foto, tidak setahun. */
const UNLOCK_TTL_SECONDS = 12 * 3600;

const UNLOCK_COOKIE = "fb_unlock";

/* ---- Cookie (tanpa dependensi) ------------------------------------ */

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (header === undefined) return null;

  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * Token buka-kunci ditandatangani dengan rahasia server.
 *
 * Cookie tidak menyimpan password dan tidak menyimpan flag "sudah login" yang
 * bisa dikarang klien: tanpa signature yang cocok, cookie diabaikan.
 */
function unlockToken(gallery: Gallery, ctx: ServerContext): string {
  return signJwt(`gallery:${gallery.hash}`, ctx.jwtSecret, {
    expiresInSeconds: UNLOCK_TTL_SECONDS,
    now: ctx.now(),
  }).token;
}

function isUnlocked(request: FastifyRequest, gallery: Gallery, ctx: ServerContext): boolean {
  const token = readCookie(request, UNLOCK_COOKIE);
  if (token === null) return false;

  try {
    const claims = verifyJwt(token, ctx.jwtSecret, { now: ctx.now() });
    return claims.sub === `gallery:${gallery.hash}`;
  } catch {
    return false;
  }
}

/* ---- Kerangka halaman --------------------------------------------- */

const NOT_FOUND_HTML = errorPage(
  404,
  "Galeri tidak ditemukan",
  `Link-nya salah, atau galeri sudah kedaluwarsa. Galeri tamu otomatis dihapus ${GALLERY_TTL_DAYS} hari setelah dibuat.`,
);

function passwordPage(hash: string, failed: boolean): string {
  return shell(
    "Galeri terkunci",
    `<span class="badge">Terkunci</span>
     <h1>Galeri ini pakai password</h1>
     <p>Masukkan password dari operator untuk melihat fotonya.</p>
     ${failed ? `<p style="color:#c00;font-weight:700">Password salah. Coba lagi.</p>` : ""}
     <form method="post" action="${escapeHtml(`${GALLERY_BASE_PATH}${hash}/unlock`)}">
       <input type="password" name="password" placeholder="Password" autofocus required>
       <button class="btn" type="submit">Buka</button>
     </form>`,
  );
}

/* ---- Bantu -------------------------------------------------------- */

/**
 * Cookie penanda "sudah dihitung hari ini" untuk satu galeri.
 *
 * Tanpa ini, satu orang yang menekan refresh lima kali membuat angka
 * kunjungan di dasbor naik lima — dan angka yang bisa dinaikkan sendiri oleh
 * tamu tidak berguna untuk mengambil keputusan.
 *
 * Namanya per-galeri dan `Path`-nya di dalam galeri itu, jadi membuka dua
 * galeri berbeda di hari yang sama tetap dihitung dua kunjungan.
 */
function viewCookieName(hash: string): string {
  return `fb_seen_${hash}`;
}

/** Hari (UTC) — cukup untuk granularitas harian, dan deterministik di tes. */
function viewDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Satu input form sesuai tipe field. */
function leadInput(field: LeadField): string {
  const name = escapeHtml(field.key);
  const label = escapeHtml(field.label);
  const help = field.helpText === null ? "" : `<small>${escapeHtml(field.helpText)}</small>`;
  const required = field.required ? " required" : "";
  const star = field.required ? " *" : "";

  if (field.type === "checkbox") {
    return `<label class="check"><input type="checkbox" name="${name}" value="1"${required}> ${label}${star}</label>${help}`;
  }

  if (field.type === "select") {
    const options = field.options
      .map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`)
      .join("");
    return `<label>${label}${star}<select name="${name}"${required}><option value="">— pilih —</option>${options}</select></label>${help}`;
  }

  const type = field.type === "email" ? "email" : field.type === "phone" ? "tel" : "text";
  return `<label>${label}${star}<input type="${type}" name="${name}"${required}></label>${help}`;
}

/**
 * Form data tamu di bawah galeri.
 *
 * Dirender sebagai `<form>` biasa (bukan fetch): halaman galeri harus tetap
 * berguna tanpa JavaScript, dan form yang bergantung pada JS akan hilang di
 * browser lama atau saat skrip gagal dimuat.
 *
 * Field-nya kosong → form tidak ditampilkan sama sekali. Menampilkan form
 * yang cuma berisi checkbox consent akan membuat tamu menyetujui sesuatu yang
 * tidak diminta, dan itu justru masalah kepatuhan.
 */
function leadFormHtml(gallery: Gallery, fields: readonly LeadField[], status: string | undefined): string {
  if (fields.length === 0) return "";

  const note =
    status === "terkirim"
      ? `<p style="color:#0a7d3f;font-weight:700">Terima kasih — datanya sudah kami terima.</p>`
      : status === "gagal"
        ? `<p style="color:#c00;font-weight:700">Ada isian yang belum benar. Coba lagi ya.</p>`
        : status === "penuh"
          ? `<p style="color:#c00;font-weight:700">Kiriman dari jaringan ini sedang terlalu banyak. Coba lagi beberapa saat lagi.</p>`
          : "";

  return `
    <section class="leads">
      <h2>Isi data kamu</h2>
      ${note}
      <form method="post" action="${escapeHtml(`${GALLERY_BASE_PATH}${gallery.hash}/lead`)}">
        ${fields.map(leadInput).join("\n")}
        <label class="check">
          <input type="checkbox" name="consent" value="1" required>
          ${escapeHtml(LEAD_CONSENT_TEXT)}
        </label>
        <input type="text" name="website" tabindex="-1" autocomplete="off" class="trap" aria-hidden="true">
        <button class="btn" type="submit">Kirim</button>
      </form>
    </section>`;
}

async function loadGallery(hash: string, ctx: ServerContext): Promise<Gallery | null> {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(hash)) return null;
  return getGalleryByHash(ctx.db, hash);
}

function absolute(request: FastifyRequest, path: string): string {
  return `${request.protocol}://${request.host}${path}`;
}

/** Galeri berpassword yang belum dibuka kunci → `true`. */
function isLocked(request: FastifyRequest, gallery: Gallery, ctx: ServerContext): boolean {
  const password = getGalleryPassword(ctx.db, gallery.id);
  if (password === null || password.hash === null) return false;
  return !isUnlocked(request, gallery, ctx);
}

function toWebStream(body: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}

/** Nama folder di dalam ZIP — huruf/angka/dash saja, sisanya jadi `-`. */
function sanitizeFolder(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return cleaned === "" ? "galeri" : cleaned;
}

function extFromContentType(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

/* ---- Rute --------------------------------------------------------- */

export async function galleryRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  /* Halaman utama album. */
  app.get<{ Params: { hash: string }; Querystring: { salah?: string; status?: string } }>(
    `${GALLERY_BASE_PATH}:hash`,
    async (request, reply) => {
      const gallery = await loadGallery(request.params.hash, ctx);
      if (gallery === null) return reply.status(404).type("text/html; charset=utf-8").send(NOT_FOUND_HTML);

      if (isLocked(request, gallery, ctx)) {
        return reply
          .status(401)
          .type("text/html; charset=utf-8")
          .send(passwordPage(gallery.hash, request.query.salah === "1"));
      }

      const event = getEvent(ctx.db, gallery.eventId);
      const photos = listPhotos(ctx.db, gallery.id);
      const base = absolute(request, `${GALLERY_BASE_PATH}${gallery.hash}`);

      // Kunjungan dihitung di sini — bukan di rute terpisah — karena inilah
      // satu-satunya tempat yang tahu halamannya benar-benar dirender ke tamu
      // (bukan halaman password, bukan 404). Cookie harian menahan refresh.
      const day = viewDay(ctx.now());
      if (readCookie(request, viewCookieName(gallery.hash)) !== day) {
        bumpGalleryView(ctx.db, gallery.id, day);
        reply.header(
          "set-cookie",
          `${viewCookieName(gallery.hash)}=${day}; Path=${GALLERY_BASE_PATH}${gallery.hash}; ` +
            `Max-Age=86400; HttpOnly; SameSite=Lax`,
        );
      }

      const fields = activeFieldsFor(listLeadFields(ctx.db, { eventId: gallery.eventId }), gallery.eventId);

      const firstPhoto = photos[0];
      const ogHead = [
        `<meta property="og:type" content="website">`,
        `<meta property="og:title" content="${escapeHtml(event?.name ?? "Galeri foto")}">`,
        `<meta property="og:description" content="${escapeHtml(
          event === null ? "Ambil & bagikan fotonya." : `Foto dari ${event.date} — ambil & bagikan.`,
        )}">`,
        `<meta property="og:url" content="${escapeHtml(base)}">`,
        // Thumb dipakai sebagai OG image: tanpa foto, lebih jujur tidak
        // mengirim og:image sama sekali daripada menunjuk gambar kosong.
        ...(firstPhoto === undefined
          ? []
          : [`<meta property="og:image" content="${escapeHtml(`${base}/og.png`)}">`]),
        `<meta name="twitter:card" content="summary_large_image">`,
      ].join("\n");

      const cards = photos
        .map(
          (photo) =>
            `<a href="${escapeHtml(`${base}/photo/${photo.id}`)}" target="_blank" rel="noopener">` +
            `<img src="${escapeHtml(`${base}/photo/${photo.id}?thumb=1`)}" alt="" loading="lazy"></a>`,
        )
        .join("");

      const body = `
        <span class="badge">Galeri tamu</span>
        <h1>${escapeHtml(event?.name ?? "Galeri foto")}</h1>
        <p>${escapeHtml(event?.date ?? "")}${event?.hashtag ? ` · ${escapeHtml(event.hashtag)}` : ""}</p>
        ${
          photos.length === 0
            ? `<p>Belum ada foto di galeri ini.</p>`
            : `<div class="grid">${cards}</div>`
        }
        ${
          photos.length === 0
            ? ""
            : `<div class="row"><a class="btn" href="${escapeHtml(`${base}/zip`)}">Unduh semua (${photos.length})</a></div>`
        }
        <p class="note">Galeri ini dihapus otomatis ${GALLERY_TTL_DAYS} hari setelah dibuat.</p>
        ${leadFormHtml(gallery, fields, request.query.status)}`;

      return reply.type("text/html; charset=utf-8").send(shell(event?.name ?? "Galeri foto", body, ogHead));
    },
  );

  /* Form data tamu (Fase 9). */
  app.post<{ Params: { hash: string }; Body: Record<string, unknown> }>(
    `${GALLERY_BASE_PATH}:hash/lead`,
    async (request, reply) => {
      const gallery = await loadGallery(request.params.hash, ctx);
      if (gallery === null) return reply.status(404).type("text/html; charset=utf-8").send(NOT_FOUND_HTML);
      if (isLocked(request, gallery, ctx)) {
        return reply.redirect(`${GALLERY_BASE_PATH}${gallery.hash}`, 303);
      }

      // Honeypot: kolom tersembunyi yang hanya diisi bot. Diisi → pura-pura
      // sukses (303 ke ?status=terkirim) supaya bot tidak belajar bahwa
      // kirimannya ditolak dan mencoba lagi dengan kolom itu dikosongkan.
      const raw = (request.body ?? {}) as Record<string, unknown>;
      if (typeof raw.website === "string" && raw.website.trim() !== "") {
        return reply.redirect(`${GALLERY_BASE_PATH}${gallery.hash}?status=terkirim`, 303);
      }

      // Kuota kiriman. Diperiksa **sebelum** apa pun ditulis, dan dengan
      // pembatas yang sama seperti `POST /v1/leads`: satu orang tidak bisa
      // membanjiri tabel lewat jalur mana pun.
      const verdict = leadLimiter(ctx).check(request.ip);
      if (!verdict.allowed) {
        return reply.redirect(`${GALLERY_BASE_PATH}${gallery.hash}?status=penuh`, 303);
      }

      const fields = activeFieldsFor(listLeadFields(ctx.db, { eventId: gallery.eventId }), gallery.eventId);
      const values: Record<string, string | boolean> = {};
      for (const field of fields) {
        const value = raw[field.key];
        if (field.type === "checkbox") {
          // `true`, bukan `"1"`: validator shared menerima boolean apa adanya,
          // dan menyimpan string di sini membuat nilai checkbox tampil "1"
          // alih-alih "ya" di CSV.
          if (value === "1" || value === "on" || value === true) values[field.key] = true;
        } else if (typeof value === "string") {
          values[field.key] = value;
        }
      }

      const stored = storeLead(ctx, {
        galleryHash: gallery.hash,
        eventId: gallery.eventId,
        values,
        consent: raw.consent === "1" || raw.consent === "on" || raw.consent === true,
      });
      return reply.redirect(
        `${GALLERY_BASE_PATH}${gallery.hash}?status=${stored.ok ? "terkirim" : "gagal"}`,
        303,
      );
    },
  );

  /* Buka kunci dengan password. */
  app.post<{ Params: { hash: string }; Body: { password?: string } }>(
    `${GALLERY_BASE_PATH}:hash/unlock`,
    async (request, reply) => {
      const gallery = await loadGallery(request.params.hash, ctx);
      if (gallery === null) return reply.status(404).type("text/html; charset=utf-8").send(NOT_FOUND_HTML);

      const parsed = UnlockGallerySchema.safeParse(request.body ?? {});
      const stored = getGalleryPassword(ctx.db, gallery.id);
      const ok =
        parsed.success && stored !== null && (await verifySecret(parsed.data.password, stored));

      if (!ok) {
        // Redirect, bukan 401: menekan F5 tidak memunculkan dialog "kirim ulang
        // formulir" di browser.
        return reply.redirect(`${GALLERY_BASE_PATH}${gallery.hash}?salah=1`, 303);
      }

      reply.header(
        "set-cookie",
        `${UNLOCK_COOKIE}=${encodeURIComponent(unlockToken(gallery, ctx))}; ` +
          `Path=${GALLERY_BASE_PATH}${gallery.hash}; Max-Age=${UNLOCK_TTL_SECONDS}; ` +
          `HttpOnly; SameSite=Lax`,
      );
      return reply.redirect(`${GALLERY_BASE_PATH}${gallery.hash}`, 303);
    },
  );

  /* Byte foto. Diproksi supaya bucket tetap privat. */
  app.get<{ Params: { hash: string; photoId: string }; Querystring: { thumb?: string } }>(
    `${GALLERY_BASE_PATH}:hash/photo/:photoId`,
    async (request, reply) => {
      const gallery = await loadGallery(request.params.hash, ctx);
      if (gallery === null) {
        return reply.status(404).send({ error: "not_found", message: "galeri tidak ditemukan", statusCode: 404 });
      }
      if (isLocked(request, gallery, ctx)) {
        return reply.status(401).send({ error: "locked", message: "galeri terkunci", statusCode: 401 });
      }

      const photo = listPhotos(ctx.db, gallery.id).find((row) => row.id === request.params.photoId);
      if (photo === undefined) {
        return reply.status(404).send({ error: "not_found", message: "foto tidak ditemukan", statusCode: 404 });
      }

      return sendObject(app, reply, ctx, request.query.thumb === "1" ? photo.thumbKey : photo.key);
    },
  );

  /* Gambar OG: thumb foto pertama, diproksi dengan URL bersih tanpa query. */
  app.get<{ Params: { hash: string } }>(`${GALLERY_BASE_PATH}:hash/og.png`, async (request, reply) => {
    const gallery = await loadGallery(request.params.hash, ctx);
    if (gallery === null) return reply.status(404).send();
    if (isLocked(request, gallery, ctx)) return reply.status(401).send();

    const first = listPhotos(ctx.db, gallery.id)[0];
    if (first === undefined) return reply.status(404).send();

    return sendObject(app, reply, ctx, first.thumbKey, "public, max-age=3600");
  });

  /* Unduh semua sebagai ZIP. */
  app.get<{ Params: { hash: string } }>(`${GALLERY_BASE_PATH}:hash/zip`, async (request, reply) => {
    const gallery = await loadGallery(request.params.hash, ctx);
    if (gallery === null) {
      return reply.status(404).send({ error: "not_found", message: "galeri tidak ditemukan", statusCode: 404 });
    }
    if (isLocked(request, gallery, ctx)) {
      return reply.status(401).send({ error: "locked", message: "galeri terkunci", statusCode: 401 });
    }

    const event = getEvent(ctx.db, gallery.eventId);
    const photos = listPhotos(ctx.db, gallery.id);
    const folder = sanitizeFolder(event?.name ?? gallery.hash);

    // Entri diambil berurutan dari bucket, jadi album besar tidak pernah utuh
    // di memori — hanya satu foto pada satu waktu.
    async function* entries(): AsyncGenerator<ZipEntry> {
      for (const [index, photo] of photos.entries()) {
        const object = await getObject(ctx.s3, photo.key, { fetch: ctx.fetch, now: ctx.now });
        const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
        const name = `${folder}/${String(index + 1).padStart(3, "0")}-${photo.id}.${extFromContentType(object.contentType)}`;
        yield { name, bytes };
      }
    }

    reply.type("application/zip");
    reply.header("content-disposition", `attachment; filename="${folder}.zip"`);
    return reply.send(buildZip(entries(), { now: ctx.now }));
  });
}

/** Ambil objek dari bucket dan teruskan ke tamu. */
async function sendObject(
  app: FastifyInstance,
  reply: FastifyReply,
  ctx: ServerContext,
  key: string,
  cacheControl = "private, max-age=3600",
): Promise<FastifyReply> {
  try {
    const object = await getObject(ctx.s3, key, { fetch: ctx.fetch, now: ctx.now });
    reply.type(object.contentType);
    if (object.contentLength !== null) reply.header("content-length", String(object.contentLength));
    reply.header("cache-control", cacheControl);
    return await reply.send(toWebStream(object.body));
  } catch (error) {
    app.log.error({ err: error, key }, "gagal mengambil objek foto");
    return reply.status(502).send({ error: "object_store_error", message: "foto tidak bisa diambil", statusCode: 502 });
  }
}

/** Diekspor supaya tes bisa memeriksa bentuk halaman tanpa HTTP. */
export { sanitizeFolder, passwordPage, NOT_FOUND_HTML };
