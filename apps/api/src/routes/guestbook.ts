/**
 * Video guestbook (Fase 9, FEATURE-MATRIX #19).
 *
 * Tamu meninggalkan pesan video/audio pendek untuk pemilik acara. Dua
 * permukaan, seperti galeri:
 *
 *   · **`/v1/guestbook/*`** — publik. Tamu meminta URL upload, mendaftarkan
 *     metadata, dan melihat pesan yang sudah tampil.
 *   · **`/v1/guestbook/admin/*`** — operator. Butuh token sesi; prefix `admin`
 *     menjaga rute publik tidak bisa "naik" jadi operator karena salah URL.
 *
 * Yang dijaga di sini, dan kenapa:
 *
 *   · **`key` objek dibangun server, bukan dari klien.** Saat meminta URL
 *     upload, id dibuat di sini lalu `guestbookKey` membentuk `key`-nya. Tamu
 *     hanya menerima URL bertanda tangan — tidak ada cara menaruh berkas di
 *     luar prefiks acara.
 *   · **Metadata diperiksa `validateGuestbookDraft`, bukan dipercaya.** Batas
 *     durasi/ukuran ditegakkan lagi di sini walau klien sudah menahannya;
 *     klien bisa dimatikan.
 *   · **Berkas hanya keluar lewat proxy, dan hanya yang `visible`.** Bucket
 *     tetap privat; tamu tidak pernah menerima URL bucket langsung.
 *   · **Menghapus entri menghapus objeknya dulu, baru barisnya.** Urutan
 *     terbalik akan meninggalkan berkas yatim yang tak bisa ditelusuri lagi.
 */

import { Readable } from "node:stream";

import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  GUESTBOOK_PAGE_SIZE,
  GUESTBOOK_CONTENT_TYPES,
  guestbookKey,
  normalizeGuestbookLabel,
  validateGuestbookDraft,
  type GuestbookEntry,
  type UploadUrlResponse,
} from "@foto-booth/shared";

import { authenticate } from "../auth.ts";
import type { ServerContext } from "../context.ts";
import { deleteObject, getObject, presignPut, ObjectStoreError } from "../objectStore.ts";
import { newId } from "../secrets.ts";
import { createRateLimiter } from "../rateLimit.ts";
import {
  countGuestbookEntries,
  deleteGuestbookEntry,
  getGalleryByHash,
  getGuestbookEntry,
  insertGuestbookEntry,
  listGuestbookEntries,
  setGuestbookVisibility,
} from "../store.ts";

const INVALID = (message: string) => ({ error: "invalid_request", message, statusCode: 400 });
const NOT_FOUND = (message: string) => ({ error: "not_found", message, statusCode: 404 });
const UNAUTHORIZED = (status: number, message: string) => ({ error: "unauthorized", message, statusCode: status });

/** Sama dengan galeri: 15 menit cukup untuk merekam lalu mengunggah. */
const UPLOAD_TTL_SECONDS = 15 * 60;

/** Batas kiriman per IP — satu tamu tidak perlu lebih dari ini per menit. */
const GUESTBOOK_RATE_LIMIT = 12;
const GUESTBOOK_RATE_WINDOW_MS = 60_000;

function badGateway(error: unknown) {
  const message = error instanceof ObjectStoreError ? error.message : "bucket tidak dapat dihubungi";
  return { error: "bad_gateway", message, statusCode: 502 };
}

export async function guestbookRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const limiter = createRateLimiter(
    { limit: GUESTBOOK_RATE_LIMIT, windowMs: GUESTBOOK_RATE_WINDOW_MS },
    ctx.now,
  );

  /** `true` kalau kiriman ini harus ditolak karena terlalu sering. */
  const throttled = (request: FastifyRequest): boolean => !limiter.check(request.ip).allowed;

  /* ================================================================ *
   * Publik (tamu)
   * ================================================================ */

  /**
   * URL upload bertanda tangan untuk satu pesan baru.
   *
   * Id & key dibuat di sini. `galleryHash` dipakai supaya tamu tidak perlu tahu
   * id acara; `eventId` diterima juga untuk kiosk yang sudah punya konteksnya.
   */
  app.post<{ Body: Record<string, unknown> }>("/v1/guestbook/upload-url", async (request, reply) => {
    if (throttled(request)) {
      return reply.status(429).send({ error: "rate_limited", message: "terlalu banyak percobaan", statusCode: 429 });
    }

    const body = request.body ?? {};
    const galleryHash = typeof body.galleryHash === "string" ? body.galleryHash : "";
    const explicitEventId = typeof body.eventId === "string" ? body.eventId : "";

    // Acara ditentukan dari galeri (kalau ada) supaya tamu tidak bisa memilih
    // acara orang lain dengan menebak id.
    let eventId = explicitEventId;
    if (galleryHash !== "") {
      const gallery = /^[A-Za-z0-9_-]{4,64}$/.test(galleryHash) ? getGalleryByHash(ctx.db, galleryHash) : null;
      if (gallery === null) return reply.status(404).send(NOT_FOUND("galeri tidak ditemukan"));
      eventId = gallery.eventId;
    }
    if (eventId === "") return reply.status(400).send(INVALID("acara tidak ditentukan"));

    const verdict = validateGuestbookDraft(body);
    if (!verdict.ok) return reply.status(400).send(INVALID(verdict.reason));

    const id = newId("gb");
    const key = guestbookKey(eventId, id, verdict.value.contentType);
    const expiresAt = new Date(ctx.now().getTime() + UPLOAD_TTL_SECONDS * 1000);

    let uploadUrl: string;
    try {
      uploadUrl = presignPut(ctx.s3, key, {
        expiresIn: UPLOAD_TTL_SECONDS,
        contentType: verdict.value.contentType,
        now: ctx.now(),
      });
    } catch (error) {
      app.log.error({ err: error, eventId }, "gagal menandatangani URL upload guestbook");
      return reply.status(502).send(badGateway(error));
    }

    const response: UploadUrlResponse = {
      photoId: id,
      uploadUrl,
      // Guestbook tidak punya thumbnail terpisah: pemutarnya memuat berkas asli.
      thumbUploadUrl: uploadUrl,
      key,
      thumbKey: key,
      expiresAt: expiresAt.toISOString(),
    };
    return reply.send(response);
  });

  /** Daftarkan metadata setelah berkas naik ke bucket. */
  app.post<{ Body: Record<string, unknown> }>("/v1/guestbook", async (request, reply) => {
    if (throttled(request)) {
      return reply.status(429).send({ error: "rate_limited", message: "terlalu banyak percobaan", statusCode: 429 });
    }

    const body = request.body ?? {};
    const verdict = validateGuestbookDraft(body);
    if (!verdict.ok) return reply.status(400).send(INVALID(verdict.reason));

    const galleryHash = typeof body.galleryHash === "string" ? body.galleryHash : "";
    const explicitEventId = typeof body.eventId === "string" ? body.eventId : "";

    let eventId = explicitEventId;
    let galleryId: string | null = null;
    if (galleryHash !== "") {
      const gallery = /^[A-Za-z0-9_-]{4,64}$/.test(galleryHash) ? getGalleryByHash(ctx.db, galleryHash) : null;
      if (gallery === null) return reply.status(404).send(NOT_FOUND("galeri tidak ditemukan"));
      eventId = gallery.eventId;
      galleryId = gallery.id;
    }
    if (eventId === "") return reply.status(400).send(INVALID("acara tidak ditentukan"));

    // `key` dari klien diperiksa, bukan dipercaya: harus persis bentuk yang
    // dibangun `guestbookKey` untuk acara ini.
    const key = typeof body.key === "string" ? body.key : "";
    if (!/^events\/[^/]+\/guestbook\/[^/]+$/.test(key)) {
      return reply.status(400).send(INVALID("key tidak valid"));
    }
    if (!key.startsWith(`events/${eventId}/guestbook/`)) {
      return reply.status(400).send(INVALID("key bukan milik acara ini"));
    }
    const id = key.slice(`events/${eventId}/guestbook/`.length).split(".")[0] ?? "";
    if (id === "") return reply.status(400).send(INVALID("key tidak valid"));

    const entry = insertGuestbookEntry(
      ctx.db,
      id,
      {
        eventId,
        galleryId,
        kind: verdict.value.kind,
        contentType: verdict.value.contentType,
        key,
        durationSeconds: verdict.value.durationSeconds,
        bytes: verdict.value.bytes,
        label: verdict.value.label,
        visible: true,
      },
      ctx.now().toISOString(),
    );
    return reply.status(201).send({ entry });
  });

  /** Dinding guestbook publik: hanya entri yang tampil. */
  app.get<{ Querystring: { galleryHash?: string; eventId?: string; limit?: string } }>(
    "/v1/guestbook",
    async (request, reply) => {
      let eventId = request.query.eventId ?? "";
      if (eventId === "" && request.query.galleryHash !== undefined) {
        const gallery = getGalleryByHash(ctx.db, request.query.galleryHash);
        if (gallery === null) return reply.status(404).send(NOT_FOUND("galeri tidak ditemukan"));
        eventId = gallery.eventId;
      }
      if (eventId === "") return reply.status(400).send(INVALID("acara tidak ditentukan"));

      const limit = Number.parseInt(request.query.limit ?? "", 10);
      const entries = listGuestbookEntries(ctx.db, {
        eventId,
        visibleOnly: true,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, GUESTBOOK_PAGE_SIZE) : GUESTBOOK_PAGE_SIZE,
      });
      return reply.send({ entries, total: countGuestbookEntries(ctx.db, eventId) });
    },
  );

  /**
   * Byte media satu entri.
   *
   * Diproksi supaya bucket tetap privat, dan **hanya entri `visible`** yang
   * keluar: entri yang disembunyikan operator tidak boleh bocor lewat jalur ini
   * walau id-nya diketahui.
   */
  app.get<{ Params: { id: string } }>("/v1/guestbook/:id/media", async (request, reply) => {
    const entry = getGuestbookEntry(ctx.db, request.params.id);
    if (entry === null || !entry.visible) {
      return reply.status(404).send(NOT_FOUND("pesan tidak ditemukan"));
    }

    try {
      const object = await getObject(ctx.s3, entry.key, { fetch: ctx.fetch, now: ctx.now });
      reply.header("content-type", object.contentType || entry.contentType);
      reply.header("cache-control", "private, max-age=300");
      if (object.contentLength !== null) reply.header("content-length", String(object.contentLength));
      return reply.send(Readable.fromWeb(object.body as Parameters<typeof Readable.fromWeb>[0]));
    } catch (error) {
      if (error instanceof ObjectStoreError && error.status === 404) {
        return reply.status(404).send(NOT_FOUND("berkas tidak ditemukan"));
      }
      app.log.error({ err: error, guestbookId: entry.id }, "gagal mengambil berkas guestbook");
      return reply.status(502).send(badGateway(error));
    }
  });

  /* ================================================================ *
   * Operator
   * ================================================================ */

  const guard = (request: FastifyRequest) => authenticate(request, ctx);

  app.get<{ Querystring: { eventId?: string; includeHidden?: string } }>(
    "/v1/guestbook/admin",
    async (request, reply) => {
      const auth = guard(request);
      if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

      const eventId = request.query.eventId ?? "";
      if (eventId === "") return reply.status(400).send(INVALID("eventId wajib"));
      const entries = listGuestbookEntries(ctx.db, {
        eventId,
        visibleOnly: request.query.includeHidden !== "1",
      });
      return reply.send({
        entries,
        total: countGuestbookEntries(ctx.db, eventId),
        totalDurationSeconds: entries.reduce((sum, entry) => sum + entry.durationSeconds, 0),
      });
    },
  );

  app.patch<{ Params: { id: string }; Body: { visible?: unknown } }>(
    "/v1/guestbook/admin/:id",
    async (request, reply) => {
      const auth = guard(request);
      if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

      if (typeof request.body?.visible !== "boolean") {
        return reply.status(400).send(INVALID("visible harus boolean"));
      }
      const updated = setGuestbookVisibility(ctx.db, request.params.id, request.body.visible);
      if (updated === null) return reply.status(404).send(NOT_FOUND("pesan tidak ditemukan"));
      return reply.send({ entry: updated });
    },
  );

  app.delete<{ Params: { id: string } }>("/v1/guestbook/admin/:id", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const entry = getGuestbookEntry(ctx.db, request.params.id);
    if (entry === null) return reply.status(404).send(NOT_FOUND("pesan tidak ditemukan"));

    // Objek dulu, baru baris: kalau urutannya terbalik dan penghapusan objek
    // gagal, `key`-nya sudah tidak bisa ditemukan lagi.
    try {
      await deleteObject(ctx.s3, entry.key, { fetch: ctx.fetch, now: ctx.now });
    } catch (error) {
      app.log.error({ err: error, guestbookId: entry.id }, "gagal menghapus berkas guestbook");
      return reply.status(502).send(badGateway(error));
    }
    const removed = deleteGuestbookEntry(ctx.db, entry.id);
    return reply.send({ deleted: true, removed });
  });
}

/** Dipakai tes: daftar content type yang diterima, dari satu sumber. */
export const GUESTBOOK_ACCEPTED_TYPES = GUESTBOOK_CONTENT_TYPES;

/** Label default kalau tamu tidak mengisi nama. */
export const GUESTBOOK_DEFAULT_LABEL = normalizeGuestbookLabel("");

export type { GuestbookEntry };
