/**
 * Rute operator: bikin acara, bikin galeri, tandatangani URL upload, daftarkan
 * foto yang sudah diupload.
 *
 * Semua rute di sini butuh token sesi (`authenticate`). Yang **tidak** ada di
 * sini: menerima byte foto. Sesuai desain Fase 5, foto jalan langsung dari
 * studio ke bucket — API hanya menandatangani URL. Kalau API ikut menerima
 * byte-nya, server rumah ini jadi jalur sempit untuk setiap upload, dan
 * justru itu yang mau dihindari.
 *
 * Key objek **selalu** ditentukan server (lihat `packages/shared/src/storage.ts`).
 * Klien tidak pernah mengirim key saat minta URL; saat mendaftarkan foto, key
 * yang dikirim diperiksa benar-benar milik album itu.
 */

import type { FastifyInstance } from "fastify";

import {
  CreateEventSchema,
  CreateGallerySchema,
  GALLERY_TTL_DAYS,
  RegisterPhotoSchema,
  UPLOAD_URL_TTL_SECONDS,
  UploadUrlRequestSchema,
  albumPrefixes,
  keyBelongsToAlbum,
  maxBytesForContentType,
  mimeForExt,
  photoKey,
  planAllowsGallery,
  planLimits,
  thumbKey,
  type CreateGallery,
  type Event,
  type Gallery,
  type UploadUrlResponse,
} from "@foto-booth/shared";

import { authenticate } from "../auth.ts";
import type { ServerContext } from "../context.ts";
import { deletePrefix, presignPut, ObjectStoreError } from "../objectStore.ts";
import { hashSecret, newGalleryHash, newId } from "../secrets.ts";
import {
  countActiveGalleries,
  countPhotos,
  deleteGallery,
  deletePhotos,
  entitlementAllowsNewGallery,
  getEntitlement,
  getEvent,
  getGallery,
  insertEvent,
  insertGallery,
  insertPhoto,
  listEvents,
  listGalleries,
  listPhotos,
} from "../store.ts";

const INVALID = (message: string) => ({ error: "invalid_request", message, statusCode: 400 });
const NOT_FOUND = (message: string) => ({ error: "not_found", message, statusCode: 404 });

/**
 * Tipe konten dari ekstensi key objek.
 *
 * Dipakai waktu studio mendaftarkan berkas yang sudah diupload. Key-nya dibuat
 * server (`photoKey`), jadi ekstensinya mencerminkan tipe yang benar-benar
 * ditandatangani — bukan yang diklaim klien. Ekstensi tak dikenal jatuh ke
 * `image/jpeg`: itu perilaku lama untuk foto sebelum kolom `content_type` ada,
 * dan halaman galeri memperlakukannya sebagai gambar.
 */
function contentTypeForStoredKey(key: string): string {
  const dot = key.lastIndexOf(".");
  if (dot < 0) return "image/jpeg";
  const mime = mimeForExt(key.slice(dot + 1));
  return mime === "application/octet-stream" ? "image/jpeg" : mime;
}

function badGateway(error: unknown) {
  const detail = error instanceof ObjectStoreError ? error.message : "penandatanganan URL gagal";
  return { error: "object_store_error", message: detail, statusCode: 502 };
}

export async function galleryOperatorRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  /* ---- Acara ------------------------------------------------------- */

  app.post("/v1/events", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send({ error: "unauthorized", message: auth.message, statusCode: auth.status });

    const parsed = CreateEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));

    const event = insertEvent(ctx.db, newId("ev"), parsed.data, ctx.now().toISOString());
    return reply.status(201).send(event);
  });

  app.get("/v1/events", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send({ error: "unauthorized", message: auth.message, statusCode: auth.status });

    return reply.send({ events: listEvents(ctx.db) });
  });

  /* ---- Galeri ------------------------------------------------------ */

  app.post("/v1/galleries", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send({ error: "unauthorized", message: auth.message, statusCode: auth.status });

    const parsed = CreateGallerySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));

    const body: CreateGallery = parsed.data;
    if (getEvent(ctx.db, body.eventId) === null) {
      return reply.status(404).send(NOT_FOUND("acara tidak ditemukan"));
    }

    const now = ctx.now();
    const entitlement = getEntitlement(ctx.db, auth.operator.email);
    const verdict = entitlementAllowsNewGallery(entitlement, now);
    if (!verdict.allowed) {
      return reply.status(402).send({
        error: "entitlement_required",
        message: `tidak bisa membuat galeri baru: ${verdict.reason ?? "lisensi tidak aktif"}`,
        statusCode: 402,
      });
    }

    // Batas jumlah galeri aktif dari plan (Fase 10). Diperiksa terpisah dari
    // `entitlementAllowsNewGallery` karena pertanyaannya beda: yang itu soal
    // "lisensinya hidup atau tidak", yang ini soal "kuotanya masih ada atau
    // tidak". Operator tanpa entitlement (mode lokal) tidak dibatasi — mode
    // jujur hari ini adalah "tanpa lisensi", bukan "terkunci".
    if (entitlement !== null) {
      const limits = planLimits(entitlement.plan);
      if (!planAllowsGallery(limits, countActiveGalleries(ctx.db, now))) {
        return reply.status(402).send({
          error: "entitlement_required",
          message:
            `batas ${limits.maxActiveGalleries} galeri aktif untuk plan "${entitlement.plan}" sudah tercapai. ` +
            `Hapus galeri lama, atau tingkatkan lisensi.`,
          statusCode: 402,
        });
      }
    }

    const ttlDays = body.ttlDays ?? GALLERY_TTL_DAYS;
    const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000).toISOString();
    const secret = body.password === undefined ? null : await hashSecret(body.password);

    const gallery = insertGallery(
      ctx.db,
      newId("gal"),
      {
        eventId: body.eventId,
        hash: newGalleryHash(),
        passwordHash: secret?.hash ?? null,
        passwordSalt: secret?.salt ?? null,
        expiresAt,
      },
      now.toISOString(),
    );

    // URL publik dibangun dari origin permintaan, jadi galeri tetap benar
    // entah diakses lewat tunnel, LAN, atau localhost.
    return reply.status(201).send({ ...gallery, url: `${request.protocol}://${request.host}/a/${gallery.hash}` });
  });

  app.get("/v1/galleries", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send({ error: "unauthorized", message: auth.message, statusCode: auth.status });

    const galleries = listGalleries(ctx.db).map((gallery) => ({
      ...gallery,
      photoCount: countPhotos(ctx.db, gallery.id),
      url: `${request.protocol}://${request.host}/a/${gallery.hash}`,
    }));
    return reply.send({ galleries });
  });

  app.get<{ Params: { id: string } }>("/v1/galleries/:id", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send({ error: "unauthorized", message: auth.message, statusCode: auth.status });

    const gallery = getGallery(ctx.db, request.params.id);
    if (gallery === null) return reply.status(404).send(NOT_FOUND("galeri tidak ditemukan"));

    const event = getEvent(ctx.db, gallery.eventId);
    return reply.send({
      ...gallery,
      url: `${request.protocol}://${request.host}/a/${gallery.hash}`,
      event,
      photos: listPhotos(ctx.db, gallery.id),
    });
  });

  app.delete<{ Params: { id: string } }>("/v1/galleries/:id", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send({ error: "unauthorized", message: auth.message, statusCode: auth.status });

    const gallery = getGallery(ctx.db, request.params.id);
    if (gallery === null) return reply.status(404).send(NOT_FOUND("galeri tidak ditemukan"));

    // Objek dulu, baru baris: kalau penghapusan objek gagal, galeri masih ada
    // dan bisa dicoba lagi. Urutan sebaliknya meninggalkan objek yatim yang
    // tidak ada lagi yang tahu cara menemukannya.
    let removedObjects = 0;
    try {
      for (const prefix of albumPrefixes(gallery.hash)) {
        removedObjects += await deletePrefix(ctx.s3, prefix, { fetch: ctx.fetch, now: ctx.now });
      }
    } catch (error) {
      app.log.error({ err: error, galleryId: gallery.id }, "gagal menghapus objek galeri");
      return reply.status(502).send(badGateway(error));
    }

    const removedPhotos = deletePhotos(ctx.db, gallery.id);
    deleteGallery(ctx.db, gallery.id);

    return reply.send({ deleted: true, removedObjects, removedPhotos });
  });

  /* ---- Upload presigned -------------------------------------------- */

  app.post<{ Params: { id: string } }>("/v1/galleries/:id/upload-url", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send({ error: "unauthorized", message: auth.message, statusCode: auth.status });

    const gallery = getGallery(ctx.db, request.params.id);
    if (gallery === null) return reply.status(404).send(NOT_FOUND("galeri tidak ditemukan"));

    const parsed = UploadUrlRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));

    const { contentType, bytes } = parsed.data;
    // Batas ukuran mengikuti jenis berkas: video boleh jauh lebih besar
    // daripada foto. Satu fungsi bersama dipakai supaya studio & API tidak
    // pernah menghitung sendiri-sendiri.
    const limit = maxBytesForContentType(contentType);
    if (bytes > limit) {
      return reply.status(413).send({
        error: "photo_too_large",
        message: `berkas ${bytes} byte melebihi batas ${limit} byte untuk ${contentType}`,
        statusCode: 413,
      });
    }

    // Id dibuat di sini, jadi key tidak pernah berasal dari klien.
    const photoId = newId("ph");
    const key = photoKey(gallery.hash, photoId, contentType);
    const thumb = thumbKey(gallery.hash, photoId, contentType);
    const expiresAt = new Date(ctx.now().getTime() + UPLOAD_URL_TTL_SECONDS * 1000);

    let uploadUrl: string;
    let thumbUploadUrl: string;
    try {
      const sign = { expiresIn: UPLOAD_URL_TTL_SECONDS, contentType, now: ctx.now() };
      uploadUrl = presignPut(ctx.s3, key, sign);
      thumbUploadUrl = presignPut(ctx.s3, thumb, sign);
    } catch (error) {
      app.log.error({ err: error, galleryId: gallery.id }, "gagal menandatangani URL upload");
      return reply.status(502).send(badGateway(error));
    }

    const body: UploadUrlResponse = {
      photoId,
      uploadUrl,
      thumbUploadUrl,
      key,
      thumbKey: thumb,
      expiresAt: expiresAt.toISOString(),
    };
    return reply.send(body);
  });

  app.post<{ Params: { id: string } }>("/v1/galleries/:id/photos", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send({ error: "unauthorized", message: auth.message, statusCode: auth.status });

    const gallery = getGallery(ctx.db, request.params.id);
    if (gallery === null) return reply.status(404).send(NOT_FOUND("galeri tidak ditemukan"));

    const parsed = RegisterPhotoSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));

    const photo = parsed.data;
    // Klien melaporkan key-nya sendiri — pastikan bukan key milik album lain.
    if (!keyBelongsToAlbum(photo.key, gallery.hash) || !keyBelongsToAlbum(photo.thumbKey, gallery.hash)) {
      return reply.status(400).send(INVALID("key tidak termasuk album ini"));
    }

    // Tipe konten diturunkan dari ekstensi key, **bukan** dari klien. Key-nya
    // dibuat server waktu menandatangani URL, jadi ekstensinya otoritatif:
    // klien tidak bisa mendaftarkan berkas sebagai video hanya dengan mengaku.
    const contentType = contentTypeForStoredKey(photo.key);
    const limit = maxBytesForContentType(contentType);
    if (photo.bytes > limit) {
      return reply.status(413).send({
        error: "photo_too_large",
        message: `berkas ${photo.bytes} byte melebihi batas ${limit} byte untuk ${contentType}`,
        statusCode: 413,
      });
    }

    insertPhoto(ctx.db, photo.photoId, { ...photo, galleryId: gallery.id, contentType }, ctx.now().toISOString());
    const stored = listPhotos(ctx.db, gallery.id).find((row) => row.id === photo.photoId);

    return reply.status(201).send({
      ...stored,
      url: `${request.protocol}://${request.host}/a/${gallery.hash}/photo/${photo.photoId}`,
    });
  });

  /* ---- Bantu operator lihat status galeri sendiri ------------------ */

  app.get("/v1/me", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send({ error: "unauthorized", message: auth.message, statusCode: auth.status });

    const entitlement = getEntitlement(ctx.db, auth.operator.email);
    return reply.send({
      email: auth.operator.email,
      entitlement,
      galleries: listGalleries(ctx.db).length,
    });
  });
}

/** Dipakai `store.ts` — diekspor ulang supaya route tidak mengimpor store dua kali. */
export type { Event, Gallery };
