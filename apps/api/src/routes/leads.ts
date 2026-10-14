/**
 * Leads (Fase 9) — data tamu, konfigurasi field, dan ekspor CSV.
 *
 * Yang perlu dipegang saat membaca file ini:
 *
 *   · **Field dibuat operator saat runtime**, jadi `values` di DB adalah JSON,
 *     bukan kolom tetap. Konsekuensinya `key` harus stabil: nilai lama
 *     menunjuk kunci lama, dan mengganti key akan memutus riwayat. Karena itu
 *     `PATCH` tidak pernah menyentuh `key` — hanya label dan setelan tampilan.
 *   · **Consent disimpan sebagai teks + versi**, bukan `true`/`false` saja.
 *     Syarat UU PDP bukan "tamu setuju", tapi "bisa dibuktikan apa yang
 *     disetujui". Karena itu `consentText` disalin dari konstanta saat
 *     penyimpanan, bukan dibaca ulang dari konstanta saat dibaca.
 *   · **Field tak dikenal diabaikan**, bukan ditolak — form yang ter-cache di
 *     HP tamu bisa mengirim field yang sudah dihapus operator.
 *   · **Ekspor dibatasi** (`LEAD_EXPORT_LIMIT`) supaya satu klik operator tidak
 *     memuat seisi tabel ke memori.
 */

import type { FastifyInstance } from "fastify";

import {
  CreateLeadFieldSchema,
  LEAD_CONSENT_TEXT,
  LEAD_CONSENT_VERSION,
  LEAD_EXPORT_LIMIT,
  LEAD_MAX_FIELDS,
  LeadSubmissionSchema,
  UpdateLeadFieldSchema,
  activeFieldsFor,
  buildLeadsCsv,
  normalizeFieldKey,
  validateLeadValues,
  type Lead,
  type LeadField,
  type LeadFieldError,
} from "@foto-booth/shared";

import { authenticate } from "../auth.ts";
import type { ServerContext } from "../context.ts";
import { leadLimiter } from "../leadLimiter.ts";
import { newId } from "../secrets.ts";
import {
  countLeadFields,
  deleteLead,
  deleteLeadField,
  getEvent,
  getGallery,
  getGalleryByHash,
  getLeadField,
  insertLead,
  insertLeadField,
  listEvents,
  listGalleries,
  listLeadFields,
  listLeads,
  updateLeadField,
} from "../store.ts";

const INVALID = (message: string) => ({ error: "invalid_request", message, statusCode: 400 });
const NOT_FOUND = (message: string) => ({ error: "not_found", message, statusCode: 404 });
const UNAUTHORIZED = (status: number, message: string) => ({
  error: "unauthorized",
  message,
  statusCode: status,
});

/** Kunci yang belum dipakai di lingkup ini; `nama` → `nama_2`, `nama_3`, … */
function uniqueKey(scope: LeadField[], label: string): string {
  const base = normalizeFieldKey(label);
  const taken = new Set(scope.map((field) => field.key));
  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base.slice(0, 36)}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Praktis tidak tercapai (batas field 40), tapi lebih baik kunci acak
  // daripada menimpa field yang sudah ada tanpa error.
  return `${base.slice(0, 32)}_${newId("k", undefined, 3).slice(2)}`;
}

export interface LeadInput {
  galleryHash?: string | undefined;
  eventId?: string | undefined;
  values: Record<string, unknown>;
  /**
   * Persetujuan UU PDP. Wajib `true`; kalau tidak, penyimpanan ditolak.
   *
   * Ditaruh di sini — bukan hanya di skema rute — karena form HTML galeri
   * memanggil `storeLead` langsung tanpa lewat skema. Kalau cek consent hanya
   * ada di skema, jalur form akan menyimpan data tanpa persetujuan sama
   * sekali, dan itu pelanggaran yang tidak kelihatan sampai ada audit.
   */
  consent?: boolean | undefined;
}

export type LeadStoreResult =
  | { ok: true; lead: Lead }
  | { ok: false; status: number; error: string; message: string; errors?: LeadFieldError[] };

/**
 * Simpan satu kiriman lead.
 *
 * Dipisah dari handler karena ada **dua** pintu masuk: API JSON (`POST /v1/leads`,
 * untuk klien yang bisa menangani error per-field) dan form HTML di halaman
 * galeri (harus jalan tanpa JavaScript). Dua implementasi validasi akan
 * menyimpang — yang satu menerima nomor telepon yang ditolak yang lain.
 */
export function storeLead(ctx: ServerContext, input: LeadInput): LeadStoreResult {
  let eventId: string | null = input.eventId ?? null;
  let galleryId: string | null = null;

  if (input.galleryHash !== undefined) {
    const gallery = getGalleryByHash(ctx.db, input.galleryHash);
    if (gallery === null) {
      return { ok: false, status: 404, error: "not_found", message: "galeri tidak ditemukan" };
    }
    eventId = gallery.eventId;
    galleryId = gallery.id;
  } else if (eventId !== null && getEvent(ctx.db, eventId) === null) {
    return { ok: false, status: 404, error: "not_found", message: "acara tidak ditemukan" };
  }

  // Validasi terhadap definisi field, bukan terhadap apa yang dikirim tamu:
  // field wajib yang tidak ada di body tetap harus muncul sebagai error.
  const fields = activeFieldsFor(listLeadFields(ctx.db, { eventId }), eventId);
  const checked = validateLeadValues(fields, input.values);
  if (!checked.ok) {
    return {
      ok: false,
      status: 400,
      error: "invalid_values",
      message: "ada isian yang belum benar",
      errors: checked.errors,
    };
  }

  if (input.consent !== true) {
    return {
      ok: false,
      status: 400,
      error: "consent_required",
      message: "persetujuan pemakaian data wajib dicentang",
    };
  }

  const lead = insertLead(
    ctx.db,
    newId("lead"),
    {
      eventId,
      galleryId,
      values: checked.values,
      // Consent sudah diperiksa di atas; di sini nilainya pasti `true`.
      consent: true,
      consentText: LEAD_CONSENT_TEXT,
      consentVersion: LEAD_CONSENT_VERSION,
      source: galleryId === null ? "form" : "gallery",
    },
    ctx.now().toISOString(),
  );

  return { ok: true, lead };
}

export async function leadRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  // Pembatasnya dipakai bersama dengan form tamu di halaman galeri; lihat
  // `leadLimiter.ts` untuk alasan kenapa ia tidak dibuat di sini.
  const limiter = leadLimiter(ctx);

  /* ================================================================ *
   * Publik — dipakai halaman galeri tamu
   * ================================================================ */

  /**
   * Field yang harus ditanyakan.
   *
   * `galleryHash` dipakai halaman galeri (tamunya cuma punya URL itu);
   * `eventId` dipakai form lain yang sudah tahu acaranya. Kalau keduanya tidak
   * dikenal, yang keluar hanya field global — form tetap bisa dirender.
   */
  app.get<{ Querystring: { galleryHash?: string; eventId?: string } }>(
    "/v1/leads/fields",
    async (request, reply) => {
      let eventId: string | null = request.query.eventId ?? null;

      if (request.query.galleryHash !== undefined) {
        const gallery = getGalleryByHash(ctx.db, request.query.galleryHash);
        if (gallery === null) return reply.status(404).send(NOT_FOUND("galeri tidak ditemukan"));
        eventId = gallery.eventId;
      }

      return reply.send({ fields: activeFieldsFor(listLeadFields(ctx.db, { eventId }), eventId) });
    },
  );

  /** Kiriman form tamu. */
  app.post("/v1/leads", async (request, reply) => {
    const verdict = limiter.check(request.ip);
    if (!verdict.allowed) {
      reply.header("retry-after", String(verdict.retryAfterSeconds));
      return reply.status(429).send({
        error: "rate_limited",
        message: "terlalu banyak kiriman — coba lagi nanti",
        statusCode: 429,
      });
    }

    const parsed = LeadSubmissionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));
    }
    const body = parsed.data;

    // Honeypot: balas seolah sukses supaya bot tidak belajar, tapi jangan tulis
    // apa pun. Ini satu-satunya tempat di mana "berbohong" adalah perilaku benar.
    if (body.website !== undefined && body.website.trim() !== "") {
      app.log.warn({ ip: request.ip }, "lead ditolak honeypot");
      return reply.status(201).send({ received: true, stored: false });
    }

    const stored = storeLead(ctx, {
      galleryHash: body.galleryHash,
      eventId: body.eventId,
      values: body.values,
      // Skema sudah memaksa `consent === true`; diteruskan eksplisit supaya
      // `storeLead` jadi satu-satunya tempat aturan consent hidup.
      consent: true,
    });
    if (!stored.ok) {
      return reply.status(stored.status).send({
        error: stored.error,
        message: stored.message,
        statusCode: stored.status,
        ...(stored.errors === undefined ? {} : { errors: stored.errors }),
      });
    }

    return reply.status(201).send({ received: true, stored: true, id: stored.lead.id });
  });

  /* ================================================================ *
   * Operator — konfigurasi field
   * ================================================================ */

  app.get<{ Querystring: { eventId?: string } }>("/v1/leads/admin/fields", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    // Tanpa `eventId`: semua field (global + per event) — ini yang dipakai
    // layar pengaturan, yang harus memperlihatkan field global juga.
    const fields =
      request.query.eventId === undefined
        ? listLeadFields(ctx.db)
        : listLeadFields(ctx.db, { eventId: request.query.eventId });

    return reply.send({ fields, maxFields: LEAD_MAX_FIELDS });
  });

  app.post("/v1/leads/admin/fields", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const parsed = CreateLeadFieldSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));
    }
    const body = parsed.data;
    const eventId = body.eventId ?? null;

    if (eventId !== null && getEvent(ctx.db, eventId) === null) {
      return reply.status(404).send(NOT_FOUND("acara tidak ditemukan"));
    }
    if (countLeadFields(ctx.db, eventId) >= LEAD_MAX_FIELDS) {
      return reply.status(409).send({
        error: "too_many_fields",
        message: `maksimal ${LEAD_MAX_FIELDS} field per lingkup`,
        statusCode: 409,
      });
    }

    // `key` diturunkan server dari label, dan dibuat unik di lingkupnya. Klien
    // tidak pernah mengirim key: kalau boleh, satu klien bisa menulis dua field
    // dengan key sama dan nilainya saling menimpa tanpa error.
    const key = uniqueKey(listLeadFields(ctx.db, { eventId }), body.label);
    const field = insertLeadField(
      ctx.db,
      newId("lf"),
      {
        eventId,
        key,
        label: body.label,
        type: body.type,
        required: body.required,
        options: body.options,
        helpText: body.helpText ?? null,
        sortOrder: body.sortOrder ?? 0,
        active: body.active,
      },
      ctx.now().toISOString(),
    );

    return reply.status(201).send(field);
  });

  app.patch<{ Params: { id: string } }>("/v1/leads/admin/fields/:id", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const parsed = UpdateLeadFieldSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));
    }

    const current = getLeadField(ctx.db, request.params.id);
    if (current === null) return reply.status(404).send(NOT_FOUND("field tidak ditemukan"));

    // `select` tanpa pilihan akan menolak semua kiriman; lebih baik ditolak di
    // sini, saat operator masih melihat formnya.
    const options = parsed.data.options ?? current.options;
    if (current.type === "select" && options.length === 0) {
      return reply.status(400).send(INVALID("field select harus punya minimal satu pilihan"));
    }

    const updated = updateLeadField(ctx.db, request.params.id, parsed.data);
    return reply.send(updated);
  });

  app.delete<{ Params: { id: string } }>("/v1/leads/admin/fields/:id", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const removed = deleteLeadField(ctx.db, request.params.id);
    if (removed === 0) return reply.status(404).send(NOT_FOUND("field tidak ditemukan"));
    return reply.send({ deleted: true });
  });

  /* ================================================================ *
   * Operator — data masuk
   * ================================================================ */

  app.get<{ Querystring: { eventId?: string; galleryId?: string; from?: string; limit?: string } }>(
    "/v1/leads/admin/leads",
    async (request, reply) => {
      const auth = authenticate(request, ctx);
      if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        return reply.status(400).send(INVALID("limit harus angka positif"));
      }

      const leads = listLeads(ctx.db, {
        eventId: request.query.eventId,
        galleryId: request.query.galleryId,
        from: request.query.from,
        limit,
      });

      // Definisi field ikut dikirim supaya tabel di UI bisa menampilkan label
      // yang benar tanpa permintaan kedua — dan supaya nilai dari field yang
      // sudah dihapus tetap punya kolom (label jatuh ke `key`).
      const eventId = request.query.eventId ?? null;
      return reply.send({
        leads,
        fields: eventId === null ? listLeadFields(ctx.db) : listLeadFields(ctx.db, { eventId }),
      });
    },
  );

  /**
   * Ekspor CSV.
   *
   * Kolomnya diambil dari definisi field, bukan dari kunci yang kebetulan ada
   * di baris-baris itu: spreadsheet dengan kolom yang berubah-ubah antar
   * ekspor tidak bisa dipakai untuk membandingkan bulan.
   */
  app.get<{ Querystring: { eventId?: string; from?: string } }>(
    "/v1/leads/admin/export.csv",
    async (request, reply) => {
      const auth = authenticate(request, ctx);
      if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

      const eventId = request.query.eventId;
      const fields = eventId === undefined ? listLeadFields(ctx.db) : listLeadFields(ctx.db, { eventId });

      const leads = listLeads(ctx.db, {
        eventId,
        from: request.query.from,
        limit: LEAD_EXPORT_LIMIT,
      });

      const events = listEvents(ctx.db);
      const galleries = listGalleries(ctx.db);
      const csv = buildLeadsCsv(fields, leads, {
        eventNames: Object.fromEntries(events.map((event) => [event.id, event.name])),
        galleryLabels: Object.fromEntries(galleries.map((gallery) => [gallery.id, gallery.hash])),
      });

      const stamp = ctx.now().toISOString().slice(0, 10);
      const name = eventId === undefined ? `leads-${stamp}.csv` : `leads-${eventId}-${stamp}.csv`;

      reply.type("text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="${name}"`);
      return reply.send(csv);
    },
  );

  /**
   * Hapus satu kiriman.
   *
   * Ini hak penghapusan UU PDP: tamu minta datanya dibuang, operator bisa
   * benar-benar membuangnya. Bukan "sembunyikan dari daftar" — barisnya hilang.
   */
  app.delete<{ Params: { id: string } }>("/v1/leads/admin/leads/:id", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const removed = deleteLead(ctx.db, request.params.id);
    if (removed === 0) return reply.status(404).send(NOT_FOUND("kiriman tidak ditemukan"));
    return reply.send({ deleted: true });
  });
}

/** Dipakai tes untuk memeriksa penurunan kunci tanpa lewat HTTP. */
export { uniqueKey };

/** Nama galeri untuk label CSV: hash-nya, karena itu yang tamu lihat di URL. */
export function galleryLabel(hash: string): string {
  return hash;
}

/** Dipakai tes: apakah galeri ini memang ada dan punya event. */
export function galleryEventId(ctx: ServerContext, galleryId: string): string | null {
  const gallery = getGallery(ctx.db, galleryId);
  return gallery === null ? null : gallery.eventId;
}

export type { LeadField };
