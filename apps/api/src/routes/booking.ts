/**
 * Rute booking (Fase 11): form publik + panel operator.
 *
 * Dua permukaan yang sengaja dipisah tegas:
 *
 *   · **`/v1/booking/*`** — publik. Tamu boleh melihat paket, ketersediaan,
 *     mengirim permintaan, lalu memantau statusnya lewat token.
 *   · **`/v1/booking/admin/*`** — operator. Butuh token sesi, seperti rute
 *     galeri. Prefix `admin` dipakai supaya tidak ada rute publik yang bisa
 *     "naik" jadi operator karena salah bentuk URL.
 *
 * Yang dijaga di sini, dan kenapa:
 *
 *   · **Double-booking ditolak 409, bukan diam-diam diterima.** Dua permintaan
 *     untuk slot yang sama tidak boleh dua-duanya masuk; yang kedua diberi tahu
 *     ia bentrok dengan sesi mana.
 *   · **`requested` juga mengunci slot.** Kalau hanya `approved` yang mengunci,
 *     dua tamu bisa sama-sama meminta jam 14:00 dan operator baru tahu saat
 *     menyetujui yang kedua.
 *   · **Honeypot menjawab seolah sukses.** Bot yang mengisi field tersembunyi
 *     mendapat 202 dengan bentuk balasan yang sama, tapi tidak ada baris yang
 *     tersimpan. Menjawab 400 justru memberi tahu bot bahwa jebakannya kena.
 *   · **Deposit belum tersambung.** `DepositProvider` (lihat `deposit.ts`) yang
 *     menentukan; provider yang tidak hidup tidak pernah menghasilkan status
 *     "paid".
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  BOOKING_RATE_LIMIT,
  BOOKING_RATE_WINDOW_MS,
  BOOKING_REASON_MAX,
  BOOKING_TOKEN_BYTES,
  BOOKING_TOKEN_RE,
  BookingRequestSchema,
  CancelBookingSchema,
  CreateBookingPackageSchema,
  DEFAULT_BOOKING_SETTINGS,
  RescheduleBookingSchema,
  UpdateBookingPackageSchema,
  UpdateBookingSettingsSchema,
  UpdateBookingStatusSchema,
  buildIcs,
  canTransition,
  findConflict,
  generateSlots,
  localParts,
  occupancyReport,
  slotInstant,
  type Booking,
  type BookingAvailability,
  type BookingPackage,
  type BookingSettings,
  type BookingStatus,
  type PaymentProvider,
  type SlotWindow,
} from "@foto-booth/shared";

import { authenticate } from "../auth.ts";
import type { ServerContext } from "../context.ts";
import { DepositUnavailableError, formatIdr, resolveDepositProvider } from "../deposit.ts";
import { createRateLimiter } from "../rateLimit.ts";
import { newId, newToken } from "../secrets.ts";
import {
  getBooking,
  getBookingByToken,
  getBookingPackage,
  getBookingSettings,
  insertBooking,
  insertBookingPackage,
  insertEvent,
  listBookingPackages,
  listBookings,
  listBookingsInRange,
  saveBookingSettings,
  updateBooking,
  updateEventDate,
  updateBookingPackage,
} from "../store.ts";

const INVALID = (message: string) => ({ error: "invalid_request", message, statusCode: 400 });
const NOT_FOUND = (message: string) => ({ error: "not_found", message, statusCode: 404 });
const UNAUTHORIZED = (status: number, message: string) => ({ error: "unauthorized", message, statusCode: status });

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Jam lokal (offset zona) untuk satu instant. */
function localDate(instant: string, settings: BookingSettings): string {
  return localParts(instant, settings.timezoneOffsetMinutes).date;
}

function settingsOf(ctx: ServerContext): BookingSettings {
  return getBookingSettings(ctx.db) ?? DEFAULT_BOOKING_SETTINGS;
}

/** Rentang instant yang menutupi satu hari lokal, dilebihkan satu buffer di kiri. */
function dayBounds(dateISO: string, settings: BookingSettings, bufferMinutes: number) {
  const start = slotInstant(dateISO, 0, settings.timezoneOffsetMinutes);
  const end = slotInstant(dateISO, 24 * 60, settings.timezoneOffsetMinutes);
  return {
    from: new Date(new Date(start).getTime() - bufferMinutes * MINUTE_MS).toISOString(),
    to: new Date(new Date(end).getTime() + bufferMinutes * MINUTE_MS).toISOString(),
  };
}

/**
 * Slot yang benar-benar boleh dipesan pada satu tanggal.
 *
 * Tiga saringan berturut-turut: jam operasional → booking yang sudah ada →
 * jarak waktu (`minNoticeHours`). Yang terakhir sengaja dihitung di sini, bukan
 * di route, supaya halaman ketersediaan dan `POST /requests` memakai aturan yang
 * sama persis — kalau tidak, tamu bisa melihat slot "tersedia" yang selalu
 * ditolak saat dikirim.
 */
function slotsFor(
  ctx: ServerContext,
  pkg: BookingPackage,
  dateISO: string,
  settings: BookingSettings,
  now: Date,
): { slots: SlotWindow[]; available: SlotWindow[] } {
  const slots = generateSlots({
    dateISO,
    hours: settings.hours,
    durationMinutes: pkg.durationMinutes,
    ...(settings.slotStepMinutes === null ? {} : { stepMinutes: settings.slotStepMinutes }),
    timezoneOffsetMinutes: settings.timezoneOffsetMinutes,
  });

  if (settings.closedDates.includes(dateISO)) return { slots, available: [] };

  const bounds = dayBounds(dateISO, settings, settings.bufferMinutes);
  const taken = listBookingsInRange(ctx.db, bounds.from, bounds.to).map((booking) => ({
    start: booking.start,
    end: booking.end,
  }));

  const earliest = now.getTime() + settings.minNoticeHours * 60 * MINUTE_MS;
  const available = slots.filter(
    (slot) =>
      findConflict(slot, taken, settings.bufferMinutes) === null &&
      new Date(slot.start).getTime() >= earliest,
  );

  return { slots, available };
}

/** Balasan ketersediaan: slot yang terisi tetap dikirim, ditandai `available: false`. */
function availability(
  ctx: ServerContext,
  pkg: BookingPackage,
  dateISO: string,
  settings: BookingSettings,
  now: Date,
): BookingAvailability {
  const { slots, available } = slotsFor(ctx, pkg, dateISO, settings, now);
  const free = new Set(available.map((slot) => slot.start));
  return {
    date: dateISO,
    timezoneOffsetMinutes: settings.timezoneOffsetMinutes,
    slots: slots.map((slot) => ({ ...slot, available: free.has(slot.start) })),
  };
}

/** Info deposit yang dikirim ke tamu — tanpa pernah menyebut status "paid". */
interface DepositView {
  amountIdr: number;
  status: string;
  provider: PaymentProvider;
  live: boolean;
  instructions: string | null;
  redirectUrl: string | null;
}

function depositView(
  booking: Booking,
  provider: PaymentProvider,
  live: boolean,
  extra: { instructions?: string | null; redirectUrl?: string | null } = {},
): DepositView {
  return {
    amountIdr: booking.depositIdr,
    status: booking.depositStatus,
    provider,
    live,
    instructions: extra.instructions ?? null,
    redirectUrl: extra.redirectUrl ?? null,
  };
}

/** Yang boleh dilihat tamu: tanpa `id` internal dan tanpa alasan internal. */
function publicBooking(booking: Booking) {
  const { id: _id, reason: _reason, ...rest } = booking;
  return rest;
}

export async function bookingRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const limiter = createRateLimiter(
    { limit: BOOKING_RATE_LIMIT, windowMs: BOOKING_RATE_WINDOW_MS },
    ctx.now,
  );

  /* ================================================================ *
   * Publik
   * ================================================================ */

  /** Paket yang sedang ditawarkan. Paket nonaktif tidak muncul di sini. */
  app.get("/v1/booking/packages", async (_request, reply) => {
    const settings = settingsOf(ctx);
    return reply.send({
      packages: listBookingPackages(ctx.db, true),
      timezoneOffsetMinutes: settings.timezoneOffsetMinutes,
      requireDeposit: settings.requireDeposit,
      paymentProvider: settings.paymentProvider,
    });
  });

  app.get<{ Querystring: { packageId?: string; date?: string } }>(
    "/v1/booking/availability",
    async (request, reply) => {
      const { packageId, date } = request.query;
      if (packageId === undefined || date === undefined) {
        return reply.status(400).send(INVALID("packageId dan date wajib diisi"));
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return reply.status(400).send(INVALID("date harus YYYY-MM-DD"));
      }

      const pkg = getBookingPackage(ctx.db, packageId);
      if (pkg === null || !pkg.active) {
        return reply.status(404).send(NOT_FOUND("paket tidak ditemukan"));
      }

      const settings = settingsOf(ctx);
      return reply.send(availability(ctx, pkg, date, settings, ctx.now()));
    },
  );

  /** Permintaan booking dari form publik. */
  app.post("/v1/booking/requests", async (request, reply) => {
    const verdict = limiter.check(request.ip);
    if (!verdict.allowed) {
      reply.header("retry-after", String(verdict.retryAfterSeconds));
      return reply.status(429).send({
        error: "rate_limited",
        message: "terlalu banyak permintaan booking — coba lagi nanti",
        statusCode: 429,
      });
    }

    const parsed = BookingRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));
    }
    const body = parsed.data;

    // Honeypot: balas seperti sukses, tapi jangan sentuh database.
    if (body.website !== undefined && body.website.trim() !== "") {
      app.log.warn({ ip: request.ip }, "booking ditolak honeypot");
      return reply.status(202).send({
        received: true,
        token: null,
        status: "requested",
        message: "permintaan diterima — cek WhatsApp/email untuk konfirmasi",
      });
    }

    const pkg = getBookingPackage(ctx.db, body.packageId);
    if (pkg === null || !pkg.active) {
      return reply.status(404).send(NOT_FOUND("paket tidak ditemukan"));
    }

    const startMs = Date.parse(body.start);
    if (Number.isNaN(startMs)) return reply.status(400).send(INVALID("waktu mulai tidak valid"));
    const start = new Date(startMs).toISOString();
    const end = new Date(startMs + pkg.durationMinutes * MINUTE_MS).toISOString();

    const settings = settingsOf(ctx);
    const now = ctx.now();
    const date = localDate(start, settings);

    if (settings.closedDates.includes(date)) {
      return reply.status(409).send({
        error: "closed",
        message: `tanggal ${date} tutup`,
        statusCode: 409,
      });
    }

    const { slots, available } = slotsFor(ctx, pkg, date, settings, now);
    const matchesSlot = slots.some((slot) => slot.start === start);
    if (!matchesSlot) {
      return reply.status(400).send(
        INVALID("waktu mulai di luar jam operasional atau tidak sejajar dengan slot"),
      );
    }
    if (!available.some((slot) => slot.start === start)) {
      // Sudah lewat jarak minimum atau sudah terisi — dua-duanya "tidak bisa".
      const taken = listBookingsInRange(
        ctx.db,
        dayBounds(date, settings, settings.bufferMinutes).from,
        dayBounds(date, settings, settings.bufferMinutes).to,
      );
      const conflict = findConflict({ start, end }, taken, settings.bufferMinutes);
      if (conflict !== null) {
        return reply.status(409).send({
          error: "slot_taken",
          message: `slot ${body.start} bentrok dengan booking yang sudah ada`,
          statusCode: 409,
          conflict: { start: conflict.start, end: conflict.end },
        });
      }
      return reply.status(409).send({
        error: "too_soon",
        message: `booking minimal ${settings.minNoticeHours} jam sebelumnya`,
        statusCode: 409,
      });
    }

    const token = newToken(BOOKING_TOKEN_BYTES);
    const booking = insertBooking(
      ctx.db,
      newId("bkg"),
      {
        token,
        packageId: pkg.id,
        packageName: pkg.name,
        name: body.name,
        email: body.email,
        phone: body.phone,
        start,
        end,
        durationMinutes: pkg.durationMinutes,
        priceIdr: pkg.priceIdr,
        depositIdr: pkg.depositIdr,
        status: "requested",
        notes: body.notes,
      },
      now.toISOString(),
    );

    // Deposit dicoba **setelah** booking tersimpan: slot sudah terkunci lebih
    // dulu, jadi kegagalan provider tidak menghilangkan permintaan tamu.
    const provider = resolveDepositProvider(settings.paymentProvider);
    let deposit = depositView(booking, provider.name, provider.live);

    if (booking.depositIdr > 0 && provider.live) {
      try {
        const intent = await provider.createIntent({
          bookingId: booking.id,
          token: booking.token,
          amountIdr: booking.depositIdr,
          customerName: booking.name,
          expiresAt: new Date(now.getTime() + settings.minNoticeHours * 60 * MINUTE_MS).toISOString(),
        });
        const updated = updateBooking(
          ctx.db,
          booking.id,
          { depositStatus: intent.outcome === "paid" ? "paid" : "pending" },
          now.toISOString(),
        );
        deposit = depositView(updated ?? booking, provider.name, true, {
          instructions: intent.instructions,
          redirectUrl: intent.redirectUrl,
        });
      } catch (error) {
        if (!(error instanceof DepositUnavailableError)) throw error;
        app.log.warn({ err: error, bookingId: booking.id }, "provider deposit tidak tersedia");
      }
    }

    return reply.status(202).send({
      received: true,
      token: booking.token,
      status: booking.status,
      booking: publicBooking(booking),
      deposit,
      statusUrl: `${request.protocol}://${request.host}/booking/s/${booking.token}`,
      message: "permintaan diterima — operator akan mengonfirmasi",
    });
  });

  /** Status booking lewat token. Ini yang dibuka tamu dari WhatsApp. */
  app.get<{ Params: { token: string } }>("/v1/booking/status/:token", async (request, reply) => {
    const { token } = request.params;
    if (!BOOKING_TOKEN_RE.test(token)) return reply.status(404).send(NOT_FOUND("booking tidak ditemukan"));

    const booking = getBookingByToken(ctx.db, token);
    if (booking === null) return reply.status(404).send(NOT_FOUND("booking tidak ditemukan"));

    const settings = settingsOf(ctx);
    const provider = resolveDepositProvider(settings.paymentProvider);
    return reply.send({ booking: publicBooking(booking), deposit: depositView(booking, provider.name, provider.live) });
  });

  /** Tamu membatalkan bookingnya sendiri. */
  app.post<{ Params: { token: string } }>("/v1/booking/status/:token/cancel", async (request, reply) => {
    const { token } = request.params;
    if (!BOOKING_TOKEN_RE.test(token)) return reply.status(404).send(NOT_FOUND("booking tidak ditemukan"));

    const booking = getBookingByToken(ctx.db, token);
    if (booking === null) return reply.status(404).send(NOT_FOUND("booking tidak ditemukan"));

    if (!canTransition(booking.status, "cancelled")) {
      return reply.status(409).send({
        error: "not_cancellable",
        message: `booking berstatus ${booking.status} tidak bisa dibatalkan`,
        statusCode: 409,
      });
    }

    const parsed = CancelBookingSchema.safeParse(request.body ?? {});
    const reason = parsed.success ? parsed.data.reason : undefined;

    const updated = updateBooking(
      ctx.db,
      booking.id,
      { status: "cancelled", reason: reason ?? "dibatalkan oleh pemesan" },
      ctx.now().toISOString(),
    );

    return reply.send({ booking: publicBooking(updated ?? booking) });
  });

  /**
   * Geser jadwal booking yang sudah disetujui: event studio-nya harus ikut pindah
   * hari, kalau tidak operator mencari klien di tanggal lama.
   */
  function syncEventDate(booking: Booking, start: string, settings: BookingSettings): void {
    if (booking.eventId === null || booking.eventId === undefined) return;
    updateEventDate(ctx.db, booking.eventId, localDate(start, settings));
  }

  /** Tamu menggeser jadwalnya sendiri — dibatasi `minNoticeHours`. */
  app.post<{ Params: { token: string } }>("/v1/booking/status/:token/reschedule", async (request, reply) => {
    const { token } = request.params;
    if (!BOOKING_TOKEN_RE.test(token)) return reply.status(404).send(NOT_FOUND("booking tidak ditemukan"));

    const booking = getBookingByToken(ctx.db, token);
    if (booking === null) return reply.status(404).send(NOT_FOUND("booking tidak ditemukan"));

    if (booking.status !== "requested" && booking.status !== "approved") {
      return reply.status(409).send({
        error: "not_reschedulable",
        message: `booking berstatus ${booking.status} tidak bisa digeser`,
        statusCode: 409,
      });
    }

    const parsed = RescheduleBookingSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));

    const startMs = Date.parse(parsed.data.start);
    if (Number.isNaN(startMs)) return reply.status(400).send(INVALID("waktu mulai tidak valid"));

    const settings = settingsOf(ctx);
    const now = ctx.now();
    // Aturan jarak minimum sama dengan saat memesan: tamu tidak bisa memindahkan
    // sesinya ke satu jam lagi lalu mengharapkan operator siap.
    const earliest = now.getTime() + settings.minNoticeHours * 60 * MINUTE_MS;
    if (startMs < earliest) {
      return reply.status(409).send({
        error: "too_soon",
        message: `pindah jadwal minimal ${settings.minNoticeHours} jam sebelumnya`,
        statusCode: 409,
      });
    }

    const start = new Date(startMs).toISOString();
    const end = new Date(startMs + booking.durationMinutes * MINUTE_MS).toISOString();
    const date = localDate(start, settings);

    if (settings.closedDates.includes(date)) {
      return reply.status(409).send({ error: "closed", message: `tanggal ${date} tutup`, statusCode: 409 });
    }

    const bounds = dayBounds(date, settings, settings.bufferMinutes);
    const taken = listBookingsInRange(ctx.db, bounds.from, bounds.to).filter((row) => row.id !== booking.id);
    const conflict = findConflict({ start, end }, taken, settings.bufferMinutes);
    if (conflict !== null) {
      return reply.status(409).send({
        error: "slot_taken",
        message: "slot tujuan sudah dipakai",
        statusCode: 409,
        conflict: { start: conflict.start, end: conflict.end },
      });
    }

    const updated = updateBooking(ctx.db, booking.id, { start, end }, now.toISOString()) ?? booking;
    syncEventDate(updated, start, settings);

    return reply.send({ booking: publicBooking(updated) });
  });

  /* ================================================================ *
   * Operator
   * ================================================================ */

  const guard = (request: FastifyRequest) => {
    const auth = authenticate(request, ctx);
    return auth;
  };

  /* ---- Paket ---- */

  app.get("/v1/booking/admin/packages", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));
    return reply.send({ packages: listBookingPackages(ctx.db, false) });
  });

  app.post("/v1/booking/admin/packages", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const parsed = CreateBookingPackageSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));

    const pkg = insertBookingPackage(ctx.db, newId("pkg"), parsed.data, ctx.now().toISOString());
    return reply.status(201).send(pkg);
  });

  app.patch<{ Params: { id: string } }>("/v1/booking/admin/packages/:id", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const parsed = UpdateBookingPackageSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));

    const current = getBookingPackage(ctx.db, request.params.id);
    if (current === null) return reply.status(404).send(NOT_FOUND("paket tidak ditemukan"));

    // Batas `deposit ≤ harga` diperiksa pada hasil gabungan: satu field boleh
    // tidak dikirim, jadi memeriksa `parsed.data` saja bisa meloloskan deposit
    // yang melebihi harga lama.
    const price = parsed.data.priceIdr ?? current.priceIdr;
    const deposit = parsed.data.depositIdr ?? current.depositIdr;
    if (deposit > price) {
      return reply.status(400).send(INVALID("deposit tidak boleh melebihi harga paket"));
    }

    const updated = updateBookingPackage(ctx.db, request.params.id, parsed.data, ctx.now().toISOString());
    if (updated === null) return reply.status(404).send(NOT_FOUND("paket tidak ditemukan"));
    return reply.send(updated);
  });

  /* ---- Setelan ---- */

  app.get("/v1/booking/admin/settings", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));
    return reply.send(settingsOf(ctx));
  });

  app.put("/v1/booking/admin/settings", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const parsed = UpdateBookingSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));

    // QRIS belum ada. Menerima setelannya berarti operator bisa memilih
    // pembayaran yang tidak akan pernah jalan — lebih jujur menolak di sini.
    if (parsed.data.paymentProvider === "qris") {
      return reply.status(400).send(
        INVALID("provider qris belum diimplementasikan (menunggu Fase 10) — pakai \"manual\" atau \"none\""),
      );
    }

    const merged: BookingSettings = { ...settingsOf(ctx), ...parsed.data };
    const now = ctx.now().toISOString();
    saveBookingSettings(ctx.db, merged, now);
    return reply.send(merged);
  });

  /* ---- Booking ---- */

  app.get<{ Querystring: { from?: string; to?: string; status?: string } }>(
    "/v1/booking/admin/bookings",
    async (request, reply) => {
      const auth = guard(request);
      if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

      const { from, to, status } = request.query;
      const bookings = listBookings(ctx.db, {
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(status === undefined ? {} : { status: status as BookingStatus }),
      });
      return reply.send({ bookings });
    },
  );

  app.patch<{ Params: { id: string } }>("/v1/booking/admin/bookings/:id", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const parsed = UpdateBookingStatusSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));

    const booking = getBooking(ctx.db, request.params.id);
    if (booking === null) return reply.status(404).send(NOT_FOUND("booking tidak ditemukan"));

    const target = parsed.data.status;
    if (!canTransition(booking.status, target)) {
      return reply.status(409).send({
        error: "invalid_transition",
        message: `${booking.status} → ${target} tidak diizinkan`,
        statusCode: 409,
      });
    }

    // Menyetujui = mengunci slot. Kalau slotnya sudah diambil booking lain
    // sejak permintaan masuk, operator harus tahu sekarang, bukan saat tamu
    // datang dan mendapati ruangannya terpakai.
    if (target === "approved") {
      const settings = settingsOf(ctx);
      const taken = listBookingsInRange(
        ctx.db,
        dayBounds(localDate(booking.start, settings), settings, settings.bufferMinutes).from,
        dayBounds(localDate(booking.start, settings), settings, settings.bufferMinutes).to,
      ).filter((row) => row.id !== booking.id);
      const conflict = findConflict({ start: booking.start, end: booking.end }, taken, settings.bufferMinutes);
      if (conflict !== null) {
        return reply.status(409).send({
          error: "slot_taken",
          message: "slot sudah dipakai booking lain — geser jadwalnya dulu",
          statusCode: 409,
          conflict: { start: conflict.start, end: conflict.end },
        });
      }
    }

    const reason =
      parsed.data.reason === undefined
        ? undefined
        : parsed.data.reason.slice(0, BOOKING_REASON_MAX);

    let updated = updateBooking(
      ctx.db,
      booking.id,
      { status: target, ...(reason === undefined ? {} : { reason }) },
      ctx.now().toISOString(),
    );

    // Booking yang disetujui jadi event di studio: hari-H tinggal pakai, tidak
    // perlu input ulang nama & tanggal. Idempoten — `event_id` disimpan di
    // booking, jadi approve kedua (atau reschedule) tidak membuat event ganda.
    if (target === "approved" && updated !== null && updated.eventId == null) {
      const settings = settingsOf(ctx);
      const event = insertEvent(
        ctx.db,
        newId("evt"),
        { name: updated.name, date: localDate(updated.start, settings) },
        ctx.now().toISOString(),
      );
      updated = updateBooking(ctx.db, booking.id, { eventId: event.id }, ctx.now().toISOString());
    }

    // Fase 9 (leads + notifikasi) yang akan mengirim email/WA di sini. Sampai
    // itu ada, jejaknya masuk log supaya operator masih bisa menelusuri.
    app.log.info({ bookingId: booking.id, from: booking.status, to: target }, "status booking diubah");

    return reply.send(updated);
  });

  app.post<{ Params: { id: string } }>("/v1/booking/admin/bookings/:id/reschedule", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const parsed = RescheduleBookingSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));

    const booking = getBooking(ctx.db, request.params.id);
    if (booking === null) return reply.status(404).send(NOT_FOUND("booking tidak ditemukan"));
    if (booking.status === "cancelled" || booking.status === "completed" || booking.status === "rejected") {
      return reply.status(409).send({
        error: "invalid_transition",
        message: `booking berstatus ${booking.status} tidak bisa digeser`,
        statusCode: 409,
      });
    }

    const startMs = Date.parse(parsed.data.start);
    if (Number.isNaN(startMs)) return reply.status(400).send(INVALID("waktu mulai tidak valid"));
    const start = new Date(startMs).toISOString();
    const end = new Date(startMs + booking.durationMinutes * MINUTE_MS).toISOString();

    const settings = settingsOf(ctx);
    const date = localDate(start, settings);
    if (settings.closedDates.includes(date)) {
      return reply.status(409).send({ error: "closed", message: `tanggal ${date} tutup`, statusCode: 409 });
    }

    const bounds = dayBounds(date, settings, settings.bufferMinutes);
    const taken = listBookingsInRange(ctx.db, bounds.from, bounds.to).filter((row) => row.id !== booking.id);
    const conflict = findConflict({ start, end }, taken, settings.bufferMinutes);
    if (conflict !== null) {
      return reply.status(409).send({
        error: "slot_taken",
        message: "slot tujuan sudah dipakai",
        statusCode: 409,
        conflict: { start: conflict.start, end: conflict.end },
      });
    }

    const updated = updateBooking(
      ctx.db,
      booking.id,
      { start, end, ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }) },
      ctx.now().toISOString(),
    );
    if (updated !== null) syncEventDate(updated, start, settings);
    return reply.send(updated);
  });

  /**
   * Operator menandai deposit.
   *
   * Inilah pengganti gateway untuk sekarang: `paymentProvider: "manual"` berarti
   * ada manusia yang memeriksa mutasi rekening lalu menekan tombol ini. Route
   * sengaja **tidak** menerima `paid` dari pemanggil anonim — butuh sesi.
   */
  app.post<{ Params: { id: string } }>("/v1/booking/admin/bookings/:id/deposit", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const body = request.body as { status?: string } | undefined;
    const allowed = ["unpaid", "pending", "paid", "refunded"] as const;
    if (body?.status === undefined || !allowed.includes(body.status as (typeof allowed)[number])) {
      return reply.status(400).send(INVALID(`status deposit harus salah satu dari: ${allowed.join(", ")}`));
    }

    const booking = getBooking(ctx.db, request.params.id);
    if (booking === null) return reply.status(404).send(NOT_FOUND("booking tidak ditemukan"));

    const updated = updateBooking(
      ctx.db,
      booking.id,
      { depositStatus: body.status as (typeof allowed)[number] },
      ctx.now().toISOString(),
    );
    app.log.info(
      { bookingId: booking.id, from: booking.depositStatus, to: body.status, by: auth.operator.email },
      "status deposit diubah manual",
    );
    return reply.send(updated);
  });

  /* ---- Kalender & laporan ---- */

  function icsFor(bookings: Booking[], nowIso: string): string {
    return buildIcs(
      bookings.map((booking) => ({
        uid: `booking-${booking.id}@foto-booth`,
        start: booking.start,
        end: booking.end,
        summary: `${booking.packageName} — ${booking.name}`,
        description: `Status: ${booking.status}. Deposit: ${formatIdr(booking.depositIdr)} (${booking.depositStatus}).`,
        cancelled: booking.status === "cancelled" || booking.status === "rejected",
      })),
      { now: nowIso },
    );
  }

  app.get<{ Querystring: { from?: string; to?: string } }>("/v1/booking/admin/calendar.ics", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const now = ctx.now();
    const from = request.query.from ?? new Date(now.getTime() - 30 * DAY_MS).toISOString();
    const to = request.query.to ?? new Date(now.getTime() + 180 * DAY_MS).toISOString();

    const bookings = listBookings(ctx.db, { from, to }).filter(
      (booking) => booking.status === "approved" || booking.status === "requested",
    );

    reply.type("text/calendar; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="booking-foto-booth.ics"');
    return reply.send(icsFor(bookings, now.toISOString()));
  });

  app.get<{ Params: { id: string } }>("/v1/booking/admin/bookings/:id/ics", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const booking = getBooking(ctx.db, request.params.id);
    if (booking === null) return reply.status(404).send(NOT_FOUND("booking tidak ditemukan"));

    reply.type("text/calendar; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="booking-${booking.id}.ics"`);
    return reply.send(icsFor([booking], ctx.now().toISOString()));
  });

  app.get<{ Querystring: { from?: string; to?: string } }>("/v1/booking/admin/report", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const now = ctx.now();
    const from = request.query.from ?? new Date(now.getTime() - 30 * DAY_MS).toISOString();
    const to = request.query.to ?? new Date(now.getTime() + 180 * DAY_MS).toISOString();

    const bookings = listBookings(ctx.db, { from, to });
    // Satu laporan per paket: durasi berbeda antar paket, jadi "jam terpakai"
    // tidak bisa dihitung sekali untuk semua.
    const byPackage = new Map<string, { name: string; durationMinutes: number; bookings: Booking[] }>();
    for (const booking of bookings) {
      const entry = byPackage.get(booking.packageId) ?? {
        name: booking.packageName,
        durationMinutes: booking.durationMinutes,
        bookings: [],
      };
      entry.bookings.push(booking);
      byPackage.set(booking.packageId, entry);
    }

    const packages = [...byPackage.entries()].map(([packageId, entry]) => ({
      packageId,
      packageName: entry.name,
      durationMinutes: entry.durationMinutes,
      ...occupancyReport(entry.bookings, entry.durationMinutes),
    }));

    const totals = occupancyReport(
      bookings.map((booking) => ({
        status: booking.status,
        start: booking.start,
        priceIdr: booking.priceIdr,
        depositIdr: booking.depositStatus === "paid" ? booking.depositIdr : 0,
      })),
      // Rata-rata jam hanya bermakna per paket; total di sini menjumlahkan
      // "jam terpakai" tiap paket lewat `bookedHours` di bawah.
      0,
    );

    const bookedHours = Math.round(packages.reduce((sum, entry) => sum + entry.bookedHours, 0) * 100) / 100;

    return reply.send({
      from,
      to,
      total: { ...totals, bookedHours },
      packages,
    });
  });
}
