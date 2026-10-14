/**
 * Tes invoice + pelacakan pelunasan (Fase 11).
 *
 * Yang paling penting diuji di sini bukan format teksnya, tapi **kapan sebuah
 * tagihan disebut lunas**. Salah di situ berarti menagih klien yang sudah
 * membayar (atau sebaliknya, melepas sesi yang belum dibayar).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildInvoice,
  invoiceNumber,
  invoiceStatusFor,
  invoiceText,
  INVOICE_STATUS_LABELS,
  type InvoiceInput,
} from "./invoice.ts";

const WIB = -420;

const BOOKING = {
  id: "bkg-abc123",
  packageName: "Paket Wisuda",
  name: "Budi Santoso",
  email: "budi@example.com",
  phone: "081234567890",
  start: "2026-11-01T07:00:00.000Z", // 14:00 WIB
  durationMinutes: 60,
  priceIdr: 750_000,
  depositIdr: 200_000,
  depositStatus: "unpaid" as const,
  status: "approved" as const,
};

function input(overrides: Partial<InvoiceInput["booking"]> = {}, issuedAt = "2026-10-20T03:00:00.000Z"): InvoiceInput {
  return { booking: { ...BOOKING, ...overrides }, timezoneOffsetMinutes: WIB, issuedAt };
}

/* ---- pelunasan ---------------------------------------------------- */

test("tanpa deposit, tagihan belum dibayar sepenuhnya", () => {
  const settlement = invoiceStatusFor(750_000, 200_000, "unpaid");
  assert.equal(settlement.status, "unpaid");
  assert.equal(settlement.paidIdr, 0);
  assert.equal(settlement.balanceDueIdr, 750_000);
});

test("deposit masuk tapi kurang dari harga → partial, bukan lunas", () => {
  const settlement = invoiceStatusFor(750_000, 200_000, "paid");
  assert.equal(settlement.status, "partial");
  assert.equal(settlement.paidIdr, 200_000);
  assert.equal(settlement.balanceDueIdr, 550_000);
});

test("deposit yang menutup seluruh harga → lunas", () => {
  const settlement = invoiceStatusFor(500_000, 500_000, "paid");
  assert.equal(settlement.status, "paid");
  assert.equal(settlement.balanceDueIdr, 0);
});

test("deposit dikembalikan punya status sendiri, bukan tunggakan", () => {
  const settlement = invoiceStatusFor(750_000, 200_000, "refunded");
  assert.equal(settlement.status, "refunded");
  assert.equal(settlement.paidIdr, 0);
});

test("deposit lebih besar dari harga dijepit — tidak ada saldo negatif", () => {
  const settlement = invoiceStatusFor(300_000, 500_000, "paid");
  assert.equal(settlement.status, "paid");
  assert.equal(settlement.paidIdr, 300_000);
  assert.equal(settlement.balanceDueIdr, 0);
});

test("paket gratis (harga 0) tidak pernah disebut lunas", () => {
  const settlement = invoiceStatusFor(0, 0, "paid");
  assert.equal(settlement.status, "unpaid");
  assert.equal(settlement.balanceDueIdr, 0);
});

/* ---- nomor invoice ------------------------------------------------ */

test("nomor invoice deterministik dan memakai bulan sesi", () => {
  const first = invoiceNumber("bkg-abc123", "2026-11-01T07:00:00.000Z");
  const again = invoiceNumber("bkg-abc123", "2026-11-01T07:00:00.000Z");
  assert.equal(first, again);
  assert.match(first, /^INV-202611-[0-9A-Z]{4,6}$/);
});

test("booking berbeda menghasilkan nomor berbeda", () => {
  const a = invoiceNumber("bkg-aaa", "2026-11-01T07:00:00.000Z");
  const b = invoiceNumber("bkg-bbb", "2026-11-01T07:00:00.000Z");
  assert.notEqual(a, b);
});

/* ---- invoice penuh ------------------------------------------------ */

test("buildInvoice memakai snapshot booking, bukan paket hidup", () => {
  const invoice = buildInvoice(input());
  assert.equal(invoice.number, invoiceNumber("bkg-abc123", BOOKING.start));
  assert.equal(invoice.totalIdr, 750_000);
  assert.equal(invoice.packageName, "Paket Wisuda");
  assert.equal(invoice.businessName, "Foto Booth");
  assert.equal(invoice.statusLabel, INVOICE_STATUS_LABELS.unpaid);
});

test("jam sesi ditulis jam dinding zona operator", () => {
  const invoice = buildInvoice(input());
  assert.equal(invoice.scheduledAt, "Minggu, 1 Nov 2026 · 14:00");
});

test("deposit yang sudah masuk muncul sebagai baris pengurang", () => {
  const invoice = buildInvoice(input({ depositStatus: "paid" }));
  assert.equal(invoice.status, "partial");
  assert.equal(invoice.paidIdr, 200_000);
  assert.equal(invoice.lines.length, 2);
  assert.equal(invoice.lines[1]?.amountIdr, -200_000);
});

test("nama usaha dari branding dipakai kalau diberikan", () => {
  const invoice = buildInvoice({ ...input(), businessName: "Studio Asep" });
  assert.equal(invoice.businessName, "Studio Asep");
});

test("invoiceText memuat nomor, sisa, dan status", () => {
  const text = invoiceText(buildInvoice(input({ depositStatus: "paid" })));
  assert.match(text, /Invoice INV-202611-/);
  assert.match(text, /Sisa {4}: Rp550\.000/);
  assert.match(text, /Dibayar : Rp200\.000/);
  assert.match(text, /Deposit masuk/);
});

test("kwitansi memakai judul yang diminta", () => {
  const text = invoiceText(buildInvoice(input({ depositStatus: "paid" })), { title: "Kwitansi" });
  assert.match(text, /^Kwitansi INV-202611-/);
});
