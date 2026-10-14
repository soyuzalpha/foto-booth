/**
 * Tes teks notifikasi booking (Fase 11).
 *
 * Fokusnya bukan gaya bahasa, tapi **normalisasi nomor** dan **keberadaan
 * tautan**: pesan konfirmasi yang tautannya salah nomor lebih buruk daripada
 * tidak ada pesan sama sekali, karena operator mengira sudah menghubungi tamu.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bookingStatusLine,
  buildBookingConfirmation,
  buildBookingReminder,
  normalizePhoneId,
  whatsappLink,
  type BookingMessageInput,
} from "./notifications.ts";

const WIB = -420;

function input(overrides: Partial<BookingMessageInput["booking"]> = {}, rest: Partial<BookingMessageInput> = {}): BookingMessageInput {
  return {
    booking: {
      name: "Budi",
      packageName: "Paket Wisuda",
      start: "2026-11-01T07:00:00.000Z",
      priceIdr: 750_000,
      depositIdr: 200_000,
      status: "approved",
      ...overrides,
    },
    timezoneOffsetMinutes: WIB,
    ...rest,
  };
}

/* ---- nomor telepon ------------------------------------------------ */

test("normalizePhoneId menyatukan semua bentuk nomor Indonesia", () => {
  assert.equal(normalizePhoneId("081234567890"), "6281234567890");
  assert.equal(normalizePhoneId("+62 812-3456-7890"), "6281234567890");
  assert.equal(normalizePhoneId("62812 3456 7890"), "6281234567890");
  assert.equal(normalizePhoneId("81234567890"), "6281234567890");
  assert.equal(normalizePhoneId("0812 3456 7890"), "6281234567890");
});

test("normalizePhoneId membuang pemisah non-digit", () => {
  assert.equal(normalizePhoneId("(0812) 3456.7890"), "6281234567890");
});

test("normalizePhoneId mengembalikan string kosong untuk input kosong", () => {
  assert.equal(normalizePhoneId(""), "");
  assert.equal(normalizePhoneId("---"), "");
});

test("nomor asing dibiarkan apa adanya (digit saja)", () => {
  assert.equal(normalizePhoneId("+1 415 555 0100"), "14155550100");
});

/* ---- tautan ------------------------------------------------------- */

test("whatsappLink memakai nomor yang sudah dinormalkan dan teks ter-encode", () => {
  const link = whatsappLink("0812-3456-7890", "Halo Budi & rekan");
  assert.match(link, /^https:\/\/wa\.me\/6281234567890\?text=/);
  assert.match(link, /Halo%20Budi%20%26%20rekan/);
});

/* ---- isi pesan ---------------------------------------------------- */

test("konfirmasi memuat nama, paket, jadwal, dan harga", () => {
  const message = buildBookingConfirmation(input());
  assert.match(message.subject, /dikonfirmasi/i);
  assert.match(message.body, /Halo Budi/);
  assert.match(message.body, /Paket Wisuda/);
  assert.match(message.body, /Rp750\.000/);
  assert.match(message.body, /Deposit: Rp200\.000/);
});

test("konfirmasi tanpa deposit tidak menulis baris deposit", () => {
  const message = buildBookingConfirmation(input({ depositIdr: 0 }));
  assert.doesNotMatch(message.body, /Deposit/);
});

test("konfirmasi menyertakan tautan status kalau ada", () => {
  const message = buildBookingConfirmation(input({}, { statusUrl: "https://contoh.test/s/tok3n" }));
  assert.match(message.body, /https:\/\/contoh\.test\/s\/tok3n/);
});

test("pengingat menyebut sesi tinggal sehari lagi", () => {
  const message = buildBookingReminder(input());
  assert.match(message.subject, /Pengingat/i);
  assert.match(message.body, /sehari lagi/);
});

test("nama usaha dari branding dipakai di tanda tangan", () => {
  const message = buildBookingConfirmation(input({}, { businessName: "Studio Asep" }));
  assert.match(message.body, /Studio Asep/);
});

test("bookingStatusLine ringkas dan memakai label Indonesia", () => {
  assert.equal(bookingStatusLine("requested", "Budi"), "Budi · Menunggu konfirmasi");
});
