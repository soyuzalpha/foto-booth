/**
 * Logika murni booking (Fase 11) — tanpa I/O, tanpa `Date.now()`.
 *
 * Kenapa dipisah dari route & store: bagian yang paling gampang salah di
 * booking bukan penyimpanannya, tapi **aritmetika waktunya** — slot yang
 * bertabrakan, buffer antar-booking, dan jam operasional yang berbeda per hari.
 * Semua itu bisa diuji tanpa database, jadi ditaruh di sini dan diuji habis.
 *
 * Tiga keputusan yang menentukan bentuk modul ini:
 *
 *   · **Waktu disimpan sebagai instant UTC (ISO penuh).** Jam operasional
 *     ditulis manusia (`"09:00"`) plus satu `timezoneOffsetMinutes` di setelan;
 *     konversinya cuma terjadi di dua fungsi (`slotInstant`, `localParts`).
 *     Menyimpan waktu sebagai "jam dinding tanpa zona" bikin perbandingan
 *     `now` vs jadwal jadi tebakan.
 *   · **Interval setengah-terbuka `[mulai, selesai)`.** Booking 14:00–15:00 dan
 *     15:00–16:00 **tidak** bertabrakan; tanpa aturan ini dua sesi berdempetan
 *     selalu ditolak.
 *   · **Buffer dihitung di kedua sisi.** Sesi butuh waktu bersih-bersih
 *     (ganti properti, cetak) — jadi booking baru harus berjarak `buffer`
 *     dari ujung booking lama, bukan cuma tidak-menimpa.
 */

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

export const BOOKING_STATUSES = [
  "requested",
  "approved",
  "rejected",
  "cancelled",
  "completed",
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Label Indonesia untuk UI & halaman publik. */
export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  requested: "Menunggu konfirmasi",
  approved: "Terkonfirmasi",
  rejected: "Ditolak",
  cancelled: "Dibatalkan",
  completed: "Selesai",
};

/**
 * Status akhir — tidak ada transisi keluar.
 *
 * `cancelled` dan `completed` sengaja sama-sama akhir: mengubah booking yang
 * sudah dibatalkan jadi "selesai" berarti mencatat pendapatan untuk sesi yang
 * tidak pernah terjadi.
 */
export function isTerminal(status: BookingStatus): boolean {
  return status === "rejected" || status === "cancelled" || status === "completed";
}

/* ------------------------------------------------------------------ *
 * Deposit
 *
 * Fase 11 hanya menyiapkan **mekanismenya**: status deposit dilacak, tapi
 * pembayarannya belum tersambung ke gateway apa pun (lihat `DepositProvider`
 * di `apps/api/src/deposit.ts`). Bentuk datanya sengaja sama seperti nanti
 * setelah QRIS masuk, jadi menyambungkannya tidak perlu migrasi.
 * ------------------------------------------------------------------ */

export const DEPOSIT_STATUSES = ["unpaid", "pending", "paid", "refunded"] as const;

export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

export const DEPOSIT_STATUS_LABELS: Record<DepositStatus, string> = {
  unpaid: "Belum bayar",
  pending: "Menunggu pembayaran",
  paid: "Deposit masuk",
  refunded: "Dikembalikan",
};

const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["cancelled", "completed"],
  rejected: [],
  cancelled: [],
  completed: [],
};

/**
 * Apakah `from → to` transisi yang sah?
 *
 * Dipakai route sebelum menulis, supaya operator tidak bisa "menyetujui"
 * booking yang sudah dibatalkan klien satu detik sebelumnya.
 */
export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/* ------------------------------------------------------------------ *
 * Waktu: jam dinding ↔ instant
 * ------------------------------------------------------------------ */

/** `"09:30"` → 570. `null` kalau bentuknya tidak dikenali. */
export function parseTimeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 570 → `"09:30"`. Nilai di luar 0..1439 dijepit ke hari itu. */
export function minutesToTime(value: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.trunc(value)));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * `"2026-11-01"` + 570 menit + offset zona → instant UTC ISO.
 *
 * Offset ditulis seperti `getTimezoneOffset()` Java: menit yang **harus
 * ditambahkan** ke waktu lokal untuk mendapat UTC. WIB (UTC+7) = `-420`.
 */
export function slotInstant(dateISO: string, minutes: number, timezoneOffsetMinutes: number): string {
  const day = Date.parse(`${dateISO}T00:00:00.000Z`);
  if (Number.isNaN(day)) throw new Error(`tanggal tidak valid: ${dateISO}`);
  return new Date(day + minutes * 60_000 + timezoneOffsetMinutes * 60_000).toISOString();
}

/** Instant ISO → bagian jam dinding di zona operator. */
export function localParts(
  instant: string,
  timezoneOffsetMinutes: number,
): { date: string; time: string; minutes: number } {
  const shifted = new Date(new Date(instant).getTime() - timezoneOffsetMinutes * 60_000);
  const date = shifted.toISOString().slice(0, 10);
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return { date, time: minutesToTime(minutes), minutes };
}

/** Hari dalam minggu untuk `"YYYY-MM-DD"`: 0 = Minggu … 6 = Sabtu (UTC). */
export function weekdayOf(dateISO: string): number {
  return new Date(`${dateISO}T00:00:00.000Z`).getUTCDay();
}

const DAY_NAMES_ID = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"] as const;
const MONTH_NAMES_ID = [
  "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
  "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
] as const;

/**
 * Instant ISO → `"Senin, 2 Nov 2026 · 14:00"` di zona operator.
 *
 * Ditulis tangan, bukan lewat `Intl.DateTimeFormat("id-ID")`: halaman status
 * booking dirender server di dalam image Node minimal, dan daftar locale yang
 * tersedia di sana berbeda-beda. Jam janji yang bergeser karena data locale
 * tidak lengkap adalah bug yang hanya muncul di produksi.
 */
export function formatDateTimeId(instant: string, timezoneOffsetMinutes: number): string {
  const shifted = new Date(new Date(instant).getTime() - timezoneOffsetMinutes * 60_000);
  const day = DAY_NAMES_ID[shifted.getUTCDay()] ?? "";
  const month = MONTH_NAMES_ID[shifted.getUTCMonth()] ?? "";
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${day}, ${shifted.getUTCDate()} ${month} ${shifted.getUTCFullYear()} · ${hh}:${mm}`;
}

/* ------------------------------------------------------------------ *
 * Jam operasional & slot
 * ------------------------------------------------------------------ */

/**
 * Jam buka satu hari. `null` = tutup sepanjang hari.
 *
 * `open`/`close` ditulis `"HH:MM"`. `close` boleh `"24:00"`? Tidak — dipakai
 * `23:59` supaya `parseTimeToMinutes` tetap sederhana.
 */
export interface DayHours {
  weekday: number;
  open: string;
  close: string;
}

export interface SlotWindow {
  /** Instant UTC ISO. */
  start: string;
  end: string;
  /** Jam dinding di zona operator, buat ditampilkan. */
  label: string;
}

/** Jam buka untuk `dateISO`; `null` kalau hari itu tutup. */
export function hoursForDate(hours: readonly DayHours[], dateISO: string): DayHours | null {
  const weekday = weekdayOf(dateISO);
  return hours.find((entry) => entry.weekday === weekday) ?? null;
}

/**
 * Semua slot yang **tersedia secara jam operasional** untuk satu tanggal.
 *
 * Ini belum memperhitungkan booking yang sudah ada — itu tugas
 * `findConflict`. Memisahkan keduanya penting: kalender operator mau melihat
 * semua slot (termasuk yang terisi), sedangkan form tamu hanya mau yang bebas.
 *
 * Slot terakhir yang **selesai tepat saat tutup** masih masuk (`<=`), jadi
 * buka 09:00–21:00 dengan sesi 60 menit punya slot terakhir 20:00.
 */
export function generateSlots(options: {
  dateISO: string;
  hours: readonly DayHours[];
  durationMinutes: number;
  /** Jarak antar awal slot. Default = durasi (slot berdempet). */
  stepMinutes?: number;
  timezoneOffsetMinutes: number;
}): SlotWindow[] {
  const { dateISO, hours, durationMinutes, timezoneOffsetMinutes } = options;
  const step = options.stepMinutes ?? durationMinutes;
  if (durationMinutes <= 0 || step <= 0) return [];

  const day = hoursForDate(hours, dateISO);
  if (day === null) return [];

  const open = parseTimeToMinutes(day.open);
  const close = parseTimeToMinutes(day.close);
  if (open === null || close === null || close <= open) return [];

  const slots: SlotWindow[] = [];
  for (let start = open; start + durationMinutes <= close; start += step) {
    slots.push({
      start: slotInstant(dateISO, start, timezoneOffsetMinutes),
      end: slotInstant(dateISO, start + durationMinutes, timezoneOffsetMinutes),
      label: `${minutesToTime(start)}–${minutesToTime(start + durationMinutes)}`,
    });
  }
  return slots;
}

/* ------------------------------------------------------------------ *
 * Tabrakan & buffer
 * ------------------------------------------------------------------ */

export interface Interval {
  start: string;
  end: string;
}

/** Interval setengah-terbuka: `[a.start, a.end)` vs `[b.start, b.end)`. */
export function overlaps(a: Interval, b: Interval): boolean {
  return new Date(a.start).getTime() < new Date(b.end).getTime() &&
    new Date(b.start).getTime() < new Date(a.end).getTime();
}

/**
 * Tabrakan dengan memperhitungkan buffer.
 *
 * Buffer melebar **kedua** interval, jadi jarak bersih antar sesi minimal
 * `buffer` menit dari kedua sisi — bukan hanya "booking baru tidak menimpa
 * yang lama".
 */
export function conflictsWithBuffer(
  candidate: Interval,
  existing: Interval,
  bufferMinutes: number,
): boolean {
  const pad = Math.max(0, bufferMinutes) * 60_000;
  return (
    new Date(candidate.start).getTime() < new Date(existing.end).getTime() + pad &&
    new Date(existing.start).getTime() - pad < new Date(candidate.end).getTime()
  );
}

/**
 * Booking pertama yang bertabrakan dengan `candidate`, atau `null`.
 *
 * Sengaja mengembalikan **yang bertabrakan**, bukan `boolean`: pesan ke tamu
 * ("bentrok dengan sesi 14:00") jauh lebih berguna daripada "slot tidak
 * tersedia", dan operator butuh tahu mana yang harus digeser.
 */
export function findConflict<T extends Interval>(
  candidate: Interval,
  existing: readonly T[],
  bufferMinutes: number,
): T | null {
  for (const entry of existing) {
    if (conflictsWithBuffer(candidate, entry, bufferMinutes)) return entry;
  }
  return null;
}

/** Slot yang masih bebas setelah dikurangi booking yang sudah ada. */
export function availableSlots(
  slots: readonly SlotWindow[],
  taken: readonly Interval[],
  bufferMinutes: number,
): SlotWindow[] {
  return slots.filter((slot) => findConflict(slot, taken, bufferMinutes) === null);
}

/* ------------------------------------------------------------------ *
 * Laporan okupansi
 * ------------------------------------------------------------------ */

export interface ReportInput {
  status: BookingStatus;
  start: string;
  /** Harga paket saat booking dibuat (rupiah). */
  priceIdr: number;
  depositIdr: number;
}

export interface OccupancyReport {
  /** Booking yang benar-benar memakai slot (approved + completed). */
  booked: number;
  requested: number;
  cancelled: number;
  rejected: number;
  /** Total jam yang terpakai, dibulatkan 2 desimal. */
  bookedHours: number;
  /** Pendapatan dari booking selesai. */
  revenueIdr: number;
  /** Deposit yang sudah masuk dari booking terkonfirmasi. */
  depositIdr: number;
}

/**
 * Ringkas okupansi untuk satu rentang.
 *
 * `booked` menghitung `approved` **dan** `completed`: sesi yang sudah
 * disetujui tapi belum berjalan tetap memblokir slot, jadi menghitungnya
 * sebagai "tidak terpakai" akan melaporkan kalender yang kosong padahal penuh.
 */
export function occupancyReport(
  bookings: readonly ReportInput[],
  durationMinutes: number,
): OccupancyReport {
  const report: OccupancyReport = {
    booked: 0,
    requested: 0,
    cancelled: 0,
    rejected: 0,
    bookedHours: 0,
    revenueIdr: 0,
    depositIdr: 0,
  };

  for (const booking of bookings) {
    switch (booking.status) {
      case "requested":
        report.requested += 1;
        break;
      case "approved":
        report.booked += 1;
        report.depositIdr += booking.depositIdr;
        break;
      case "completed":
        report.booked += 1;
        report.revenueIdr += booking.priceIdr;
        report.depositIdr += booking.depositIdr;
        break;
      case "cancelled":
        report.cancelled += 1;
        break;
      case "rejected":
        report.rejected += 1;
        break;
    }
  }

  report.bookedHours = Math.round((report.booked * durationMinutes) / 60 * 100) / 100;
  return report;
}

/* ------------------------------------------------------------------ *
 * Export kalender (.ics)
 * ------------------------------------------------------------------ */

export interface IcsEvent {
  uid: string;
  start: string;
  end: string;
  summary: string;
  description?: string;
  location?: string;
  /** `cancelled` → `STATUS:CANCELLED` supaya kalender tamu ikut menghapus. */
  cancelled?: boolean;
}

/** `2026-11-01T07:00:00.000Z` → `20261101T070000Z`. */
export function icsStamp(instant: string): string {
  return `${new Date(instant).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

/**
 * RFC 5545 menghendaki escape untuk `\`, `;`, `,` dan baris baru.
 * Tanpa ini, nama acara "Budi; Sarah" memecah properti jadi dua.
 */
export function icsEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\r\n", "\\n")
    .replaceAll("\n", "\\n");
}

/**
 * Panjang UTF-8 dalam oktet, tanpa `Buffer`.
 *
 * `packages/shared` juga dipakai studio (browser), jadi `Buffer` tidak boleh
 * muncul di sini — `TextEncoder` ada di Node 24 dan di semua browser.
 */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Potong baris di 75 oktet (RFC 5545 §3.1) — klien ketat menolak yang lebih. */
function fold(line: string): string {
  if (utf8Length(line) <= 75) return line;

  const out: string[] = [];
  let current = "";
  for (const char of line) {
    if (utf8Length(current + char) > 74) {
      out.push(current);
      current = ` ${char}`;
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.join("\r\n");
}

/**
 * Bangun file `.ics` dari daftar booking.
 *
 * CRLF wajib, dan `DTSTAMP` selalu ada — dua hal yang paling sering bikin file
 * "valid" ditolak Google Calendar diam-diam.
 */
export function buildIcs(events: readonly IcsEvent[], options: { now: string; productId?: string }): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${options.productId ?? "-//Foto Booth//Booking//ID"}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${icsEscape(event.uid)}`);
    lines.push(`DTSTAMP:${icsStamp(options.now)}`);
    lines.push(`DTSTART:${icsStamp(event.start)}`);
    lines.push(`DTEND:${icsStamp(event.end)}`);
    lines.push(`SUMMARY:${icsEscape(event.summary)}`);
    if (event.description !== undefined) lines.push(`DESCRIPTION:${icsEscape(event.description)}`);
    if (event.location !== undefined) lines.push(`LOCATION:${icsEscape(event.location)}`);
    lines.push(`STATUS:${event.cancelled === true ? "CANCELLED" : "CONFIRMED"}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
