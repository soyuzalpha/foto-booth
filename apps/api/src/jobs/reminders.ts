/**
 * Job pengingat H-1 (Fase 11).
 *
 * Satu aturan yang menentukan seluruh bentuk job ini: **jangan menandai
 * "sudah diingatkan" kalau pesannya tidak benar-benar keluar.** Kalau
 * `notifier.live` masih `false` (SMTP belum dipasang), menandai booking berarti
 * tamu tidak pernah menerima pengingat sementara sistem menganggap urusannya
 * selesai — kegagalan yang tidak terlihat sampai orangnya tidak datang.
 *
 * Jadi ketika notifier belum hidup, job ini **tidak mengirim dan tidak
 * menandai**: ia hanya melaporkan berapa booking yang menunggu, dan operator
 * melihat daftarnya lewat `GET /v1/booking/admin/reminders` untuk dikirimi
 * manual (WhatsApp). Begitu SMTP dipasang, jalur yang sama langsung bekerja
 * tanpa perubahan.
 */

import {
  buildBookingReminder,
  DEFAULT_BOOKING_SETTINGS,
  type BookingSettings,
} from "@foto-booth/shared";

import type { ServerContext } from "../context.ts";
import { getBookingSettings, listBookingsDueForReminder, markBookingReminded } from "../store.ts";

/** Jendela pengingat: 24 jam sebelum sesi. */
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

/** Sapuan tiap jam: cukup rapat untuk jendela 24 jam, cukup jarang untuk murah. */
export const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

export interface ReminderReport {
  /** Booking `approved` dalam jendela yang belum pernah diingatkan. */
  due: number;
  /** Pesan yang benar-benar terkirim (notifier hidup). */
  sent: number;
  /** Ditandai sudah diingatkan (hanya yang benar-benar terkirim). */
  marked: number;
  /** Masih menunggu kanal kirim — operator perlu mengirim manual. */
  pending: { bookingId: string; name: string; email: string; phone: string; start: string }[];
  failures: { bookingId: string; message: string }[];
}

export interface ReminderOptions {
  /** Jendela pengingat (ms). Default 24 jam. */
  leadMs?: number;
  logger?: { info: (payload: object, message: string) => void; error: (payload: object, message: string) => void };
}

/**
 * Satu kali sapuan pengingat.
 *
 * Setelan dibaca sekali di depan (bukan per booking) supaya semua pesan dalam
 * satu sapuan memakai zona waktu yang sama — kalau operator mengubah zona di
 * tengah sapuan, pesan yang sudah terkirim tidak boleh tiba-tiba berbeda jam
 * dengan yang belum.
 */
export async function runBookingReminders(
  ctx: ServerContext,
  options: ReminderOptions = {},
): Promise<ReminderReport> {
  const settings: BookingSettings = getBookingSettings(ctx.db) ?? DEFAULT_BOOKING_SETTINGS;
  const now = ctx.now();
  const from = now.toISOString();
  const to = new Date(now.getTime() + (options.leadMs ?? REMINDER_LEAD_MS)).toISOString();

  const due = listBookingsDueForReminder(ctx.db, from, to);
  const report: ReminderReport = {
    due: due.length,
    sent: 0,
    marked: 0,
    pending: [],
    failures: [],
  };

  for (const booking of due) {
    const message = buildBookingReminder({
      booking: {
        name: booking.name,
        packageName: booking.packageName,
        start: booking.start,
        priceIdr: booking.priceIdr,
        depositIdr: booking.depositIdr,
        status: booking.status,
      },
      timezoneOffsetMinutes: settings.timezoneOffsetMinutes,
    });

    if (!ctx.notifier.live) {
      report.pending.push({
        bookingId: booking.id,
        name: booking.name,
        email: booking.email,
        phone: booking.phone,
        start: booking.start,
      });
      continue;
    }

    try {
      await ctx.notifier.email(booking.email, message.subject, message.body);
      markBookingReminded(ctx.db, booking.id, now.toISOString());
      report.sent += 1;
      report.marked += 1;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      report.failures.push({ bookingId: booking.id, message: text });
      options.logger?.error({ err: error, bookingId: booking.id }, "gagal mengirim pengingat booking");
    }
  }

  if (report.due > 0) {
    options.logger?.info(
      { due: report.due, sent: report.sent, pending: report.pending.length },
      "sapuan pengingat booking selesai",
    );
  }
  return report;
}

/**
 * Jalankan sapuan berkala. Mengembalikan fungsi penghenti.
 *
 * Timer `unref()`-ed seperti job TTL: pengingat tidak boleh menahan proses hidup
 * saat server dimatikan.
 */
export function scheduleBookingReminders(
  ctx: ServerContext,
  options: ReminderOptions & { intervalMs?: number } = {},
): () => void {
  const interval = options.intervalMs ?? REMINDER_INTERVAL_MS;

  const tick = () => {
    void runBookingReminders(ctx, options).catch((error: unknown) => {
      options.logger?.error({ err: error }, "job pengingat booking gagal");
    });
  };

  const timer = setInterval(tick, interval);
  timer.unref();
  tick();

  return () => clearInterval(timer);
}
