/**
 * Invoice + kwitansi booking (Fase 11) — logika murni, tanpa I/O.
 *
 * Yang dibangun di sini bukan sekadar "cetak angka": inti masalahnya adalah
 * **melacak pelunasan** ketika uangnya belum lewat gateway. Booking hanya
 * menyimpan `depositStatus`, jadi satu-satunya cara jujur menyatakan "sudah
 * lunas" adalah membandingkan deposit yang benar-benar masuk dengan harga
 * paket — dan itu keputusan yang harus bisa diuji tanpa database.
 *
 * Tiga aturan yang dipegang:
 *
 *   · **Angka invoice diambil dari snapshot booking**, bukan paket hidup.
 *     `priceIdr` dan `packageName` sudah dibekukan saat booking dibuat; memakai
 *     harga paket sekarang berarti mengubah tagihan lama diam-diam.
 *   · **Nomor invoice deterministik.** `INV-YYYYMM-XXXX` dihitung dari id
 *     booking, bukan urutan baris. Menjalankan ulang fungsi ini untuk booking
 *     yang sama selalu menghasilkan nomor yang sama — halaman publik yang
 *     di-refresh tidak boleh menerbitkan nomor kedua.
 *   · **Refund bukan "belum bayar".** Deposit yang dikembalikan punya status
 *     sendiri supaya tagihan tidak terlihat seperti tunggakan.
 */

import {
  BOOKING_STATUS_LABELS,
  DEPOSIT_STATUS_LABELS,
  formatDateTimeId,
  type BookingStatus,
  type DepositStatus,
} from "./booking.ts";
import { formatIdr } from "./license.ts";

/* ------------------------------------------------------------------ *
 * Status pelunasan
 * ------------------------------------------------------------------ */

export const INVOICE_STATUSES = ["unpaid", "partial", "paid", "refunded"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  unpaid: "Belum dibayar",
  partial: "Deposit masuk — sisa belum lunas",
  paid: "Lunas",
  refunded: "Dana dikembalikan",
};

/**
 * Ringkas pelunasan dari harga + deposit yang benar-benar masuk.
 *
 * Deposit dijepit ke `[0, price]`: data yang salah (deposit > harga karena
 * paket pernah diubah) tidak boleh menghasilkan "kelebihan bayar" atau saldo
 * negatif di tagihan.
 */
export function invoiceStatusFor(
  priceIdr: number,
  depositIdr: number,
  depositStatus: DepositStatus,
): { status: InvoiceStatus; paidIdr: number; balanceDueIdr: number } {
  const price = Math.max(0, Math.round(priceIdr));
  const deposit = Math.max(0, Math.min(price, Math.round(depositIdr)));

  if (depositStatus === "refunded") {
    return { status: "refunded", paidIdr: 0, balanceDueIdr: price };
  }

  const paid = depositStatus === "paid" ? deposit : 0;
  const balance = price - paid;

  if (price > 0 && paid >= price) return { status: "paid", paidIdr: paid, balanceDueIdr: 0 };
  if (paid > 0) return { status: "partial", paidIdr: paid, balanceDueIdr: balance };
  return { status: "unpaid", paidIdr: 0, balanceDueIdr: balance };
}

/* ------------------------------------------------------------------ *
 * Nomor invoice
 * ------------------------------------------------------------------ */

/** FNV-1a 32-bit → basis-36 huruf besar. Cukup untuk membedakan id dalam satu bulan. */
function shortCode(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(4, "0").slice(-6);
}

/**
 * `INV-202611-4KQ2` — bulan dari **tanggal sesi**, bukan tanggal cetak.
 *
 * Memakai tanggal sesi membuat nomor invoice sejalan dengan jadwal yang
 * ditagih, jadi dua booking untuk sesi yang sama di bulan berbeda tidak
 * tertukar saat direkap.
 */
export function invoiceNumber(bookingId: string, startISO: string): string {
  const month = startISO.slice(0, 7).replace("-", "");
  return `INV-${month}-${shortCode(bookingId)}`;
}

/* ------------------------------------------------------------------ *
 * Invoice
 * ------------------------------------------------------------------ */

export interface InvoiceBookingInput {
  id: string;
  packageName: string;
  name: string;
  email: string;
  phone: string;
  /** Instant UTC ISO. */
  start: string;
  durationMinutes: number;
  priceIdr: number;
  depositIdr: number;
  depositStatus: DepositStatus;
  status: BookingStatus;
}

export interface InvoiceInput {
  booking: InvoiceBookingInput;
  /** Offset zona operator (WIB = −420) supaya jam sesi ditulis jam dinding. */
  timezoneOffsetMinutes: number;
  /** ISO — waktu terbit. */
  issuedAt: string;
  /** Nama usaha dari branding; default `"Foto Booth"`. */
  businessName?: string;
}

export interface InvoiceLine {
  label: string;
  amountIdr: number;
}

export interface Invoice {
  number: string;
  issuedAt: string;
  businessName: string;
  customer: { name: string; email: string; phone: string };
  packageName: string;
  /** Jam dinding zona operator, mis. `"Senin, 2 Nov 2026 · 14:00"`. */
  scheduledAt: string;
  durationMinutes: number;
  lines: InvoiceLine[];
  totalIdr: number;
  paidIdr: number;
  balanceDueIdr: number;
  status: InvoiceStatus;
  statusLabel: string;
  depositStatus: DepositStatus;
  depositStatusLabel: string;
  bookingStatus: BookingStatus;
  bookingStatusLabel: string;
}

/**
 * Bangun invoice dari satu booking.
 *
 * Barisnya sengaja hanya dua — sesi dan deposit — karena itu satu-satunya
 * komponen harga yang benar-benar diketahui sistem. Mengarang baris pajak atau
 * biaya tambahan yang tidak pernah ditagih akan membuat invoice berbohong.
 */
export function buildInvoice(input: InvoiceInput): Invoice {
  const { booking } = input;
  const settlement = invoiceStatusFor(booking.priceIdr, booking.depositIdr, booking.depositStatus);

  const lines: InvoiceLine[] = [
    {
      label: `${booking.packageName} · ${booking.durationMinutes} menit`,
      amountIdr: booking.priceIdr,
    },
  ];
  if (settlement.paidIdr > 0) {
    lines.push({ label: "Deposit diterima", amountIdr: -settlement.paidIdr });
  }

  return {
    number: invoiceNumber(booking.id, booking.start),
    issuedAt: input.issuedAt,
    businessName: input.businessName ?? "Foto Booth",
    customer: { name: booking.name, email: booking.email, phone: booking.phone },
    packageName: booking.packageName,
    scheduledAt: formatDateTimeId(booking.start, input.timezoneOffsetMinutes),
    durationMinutes: booking.durationMinutes,
    lines,
    totalIdr: booking.priceIdr,
    paidIdr: settlement.paidIdr,
    balanceDueIdr: settlement.balanceDueIdr,
    status: settlement.status,
    statusLabel: INVOICE_STATUS_LABELS[settlement.status],
    depositStatus: booking.depositStatus,
    depositStatusLabel: DEPOSIT_STATUS_LABELS[booking.depositStatus],
    bookingStatus: booking.status,
    bookingStatusLabel: BOOKING_STATUS_LABELS[booking.status],
  };
}

/* ------------------------------------------------------------------ *
 * Kwitansi (teks siap kirim)
 * ------------------------------------------------------------------ */

/**
 * Teks invoice/kwitansi untuk email atau WhatsApp.
 *
 * Ditulis tangan, bukan dari template i18n: pesan ini keluar dari server tanpa
 * UI, dan teks yang bergantung pada berkas locale yang mungkin tidak ikut
 * ter-deploy adalah cara paling cepat membuat pesan klien jadi kosong.
 */
export function invoiceText(invoice: Invoice, options: { title?: string } = {}): string {
  const title = options.title ?? "Invoice";
  const rows = [
    `${title} ${invoice.number}`,
    `${invoice.businessName}`,
    "",
    `Nama    : ${invoice.customer.name}`,
    `Paket   : ${invoice.packageName}`,
    `Jadwal  : ${invoice.scheduledAt}`,
    "",
    `Total   : ${formatIdr(invoice.totalIdr)}`,
    `Dibayar : ${formatIdr(invoice.paidIdr)}`,
    `Sisa    : ${formatIdr(invoice.balanceDueIdr)}`,
    `Status  : ${invoice.statusLabel}`,
  ];
  return rows.join("\n");
}
