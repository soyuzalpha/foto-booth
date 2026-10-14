/**
 * Analytics (Fase 9) — angka per acara untuk dasbor operator.
 *
 * Prinsipnya: **satu angka, satu definisi.** "Kunjungan" berarti "halaman
 * galeri dibuka oleh orang yang belum membukanya hari ini" — kalau definisi itu
 * berubah, ia berubah di satu tempat (halaman galeri yang memanggil
 * `bumpGalleryView`), bukan di sini.
 *
 * Rentang tanggal menyaring **acara berdasarkan tanggal acaranya**, bukan
 * tanggal barisnya dibuat: operator bertanya "acara bulan lalu bagaimana", dan
 * acara bisa dibuat jauh sebelum hari-H.
 */

import type { FastifyInstance } from "fastify";

import { type EventAnalytics } from "@foto-booth/shared";

import { authenticate } from "../auth.ts";
import type { ServerContext } from "../context.ts";
import { eventCounts, listEvents } from "../store.ts";

const DAY_MS = 86_400_000;

export async function analyticsRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.get<{ Querystring: { from?: string; to?: string } }>("/v1/analytics/overview", async (request, reply) => {
    const auth = authenticate(request, ctx);
    if (!auth.ok) {
      return reply.status(auth.status).send({ error: "unauthorized", message: auth.message, statusCode: auth.status });
    }

    const now = ctx.now();
    // Jendela bawaan 90 hari ke belakang: cukup untuk "musim ini", tidak
    // memaksa dasbor memuat seluruh riwayat setiap kali dibuka.
    const from = request.query.from ?? new Date(now.getTime() - 90 * DAY_MS).toISOString().slice(0, 10);
    const to = request.query.to ?? new Date(now.getTime() + 30 * DAY_MS).toISOString().slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return reply
        .status(400)
        .send({ error: "invalid_request", message: "from/to harus YYYY-MM-DD", statusCode: 400 });
    }

    const counts = eventCounts(ctx.db);
    const inRange = listEvents(ctx.db).filter((event) => event.date >= from && event.date <= to);

    const events: EventAnalytics[] = inRange.map((event) => {
      const entry = counts.get(event.id);
      return {
        eventId: event.id,
        name: event.name,
        date: event.date,
        galleries: entry?.galleries ?? 0,
        photos: entry?.photos ?? 0,
        views: entry?.views ?? 0,
        leads: entry?.leads ?? 0,
      };
    });

    // Terbaru dulu — dasbor dibuka untuk melihat yang baru selesai.
    events.sort((a, b) => b.date.localeCompare(a.date));

    const totals = events.reduce(
      (sum, event) => ({
        events: sum.events + 1,
        galleries: sum.galleries + event.galleries,
        photos: sum.photos + event.photos,
        views: sum.views + event.views,
        leads: sum.leads + event.leads,
      }),
      { events: 0, galleries: 0, photos: 0, views: 0, leads: 0 },
    );

    return reply.send({ from, to, totals, events });
  });
}
