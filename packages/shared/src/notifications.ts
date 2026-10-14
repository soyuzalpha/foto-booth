/**
 * Notifikasi booking (Fase 11) — teks pesan murni, tanpa pengiriman.
 *
 * Fase 11 sebelumnya menunda konfirmasi email/WhatsApp karena "kanal kirimnya
 * belum ada". Yang sebenarnya belum ada bukan teksnya, melainkan **kabel ke
 * SMTP**. Memisahkan keduanya di sini membuat bagian yang bisa diuji (teks +
 * tautan) tidak ikut tertahan oleh bagian yang tidak bisa (kredensial SMTP):
 * pengiriman tinggal memanggil `Notifier` di API, sedangkan isi pesan sudah
 * final dan terbukti di tes.
 *
 * Dua keputusan yang menentukan bentuk modul ini:
 *
 *   · **Nomor WA dinormalkan ke `62…`.** Tamu menulis `0812…`, `+62 812-…`,
 *     atau `62812…`. `wa.me` hanya menerima digit dengan kode negara; salah
 *     satu bentuk lolos apa adanya berarti tautannya membuka kontak yang salah.
 *   · **Tautan WA disiapkan, tidak dikirim otomatis.** Operator yang menekan
 *     kirim, jadi tidak ada pesan yang lolos tanpa dilihat manusia — penting
 *     selama belum ada Business API resmi.
 */

import { BOOKING_STATUS_LABELS, formatDateTimeId, type BookingStatus } from "./booking.ts";
import { formatIdr } from "./license.ts";

export interface BookingMessageInput {
  booking: {
    name: string;
    packageName: string;
    /** Instant UTC ISO. */
    start: string;
    priceIdr: number;
    depositIdr: number;
    status: BookingStatus;
    reason?: string | undefined;
  };
  timezoneOffsetMinutes: number;
  /** URL halaman status ber-token, kalau ada. */
  statusUrl?: string | undefined;
  /** Nama usaha dari branding. */
  businessName?: string;
}

export interface BookingMessage {
  subject: string;
  body: string;
}

/**
 * `0812-3456-7890` / `+62 812 3456 7890` / `62812…` → `62812345678 90` (digit).
 *
 * Aturan: buang semua non-digit, lalu petakan awalan Indonesia. Nomor yang
 * tidak dikenali dikembalikan apa adanya (digit saja) supaya tautan tetap
 * dibentuk — `wa.me` yang menolak lebih mudah dilacak daripada nomor yang
 * diam-diam diubah jadi nomor orang lain.
 */
export function normalizePhoneId(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits === "") return "";
  if (digits.startsWith("62")) return digits;
  if (digits.startsWith("0")) return `62${digits.slice(1)}`;
  if (digits.startsWith("8")) return `62${digits}`;
  return digits;
}

/** Tautan `wa.me` dengan teks siap kirim. Digit kosong → tautan tetap dibentuk tanpa tujuan. */
export function whatsappLink(phone: string, text: string): string {
  const target = normalizePhoneId(phone);
  return `https://wa.me/${target}?text=${encodeURIComponent(text)}`;
}

/** Konfirmasi saat booking disetujui operator. */
export function buildBookingConfirmation(input: BookingMessageInput): BookingMessage {
  const when = formatDateTimeId(input.booking.start, input.timezoneOffsetMinutes);
  const business = input.businessName ?? "Foto Booth";
  const lines = [
    `Halo ${input.booking.name},`,
    "",
    `Booking kamu sudah dikonfirmasi.`,
    "",
    `Paket  : ${input.booking.packageName}`,
    `Jadwal : ${when}`,
    `Harga  : ${formatIdr(input.booking.priceIdr)}`,
  ];
  if (input.booking.depositIdr > 0) {
    lines.push(`Deposit: ${formatIdr(input.booking.depositIdr)}`);
  }
  if (input.statusUrl !== undefined) {
    lines.push("", `Cek status / ubah jadwal: ${input.statusUrl}`);
  }
  lines.push("", `Terima kasih,\n${business}`);
  return {
    subject: `Booking dikonfirmasi — ${input.booking.packageName}`,
    body: lines.join("\n"),
  };
}

/** Pengingat H-1 sebelum sesi. */
export function buildBookingReminder(input: BookingMessageInput): BookingMessage {
  const when = formatDateTimeId(input.booking.start, input.timezoneOffsetMinutes);
  const business = input.businessName ?? "Foto Booth";
  const lines = [
    `Halo ${input.booking.name},`,
    "",
    `Pengingat: sesi foto kamu tinggal sehari lagi.`,
    "",
    `Paket  : ${input.booking.packageName}`,
    `Jadwal : ${when}`,
  ];
  if (input.statusUrl !== undefined) {
    lines.push("", `Detail & perubahan jadwal: ${input.statusUrl}`);
  }
  lines.push("", `Sampai jumpa,\n${business}`);
  return {
    subject: `Pengingat sesi — ${input.booking.packageName}`,
    body: lines.join("\n"),
  };
}

/** Ringkasan satu baris untuk log operator. */
export function bookingStatusLine(status: BookingStatus, name: string): string {
  return `${name} · ${BOOKING_STATUS_LABELS[status]}`;
}
