/**
 * Tes klien HTTP panel booking.
 *
 * Janji yang diuji:
 *
 *   1. **Satu baris rusak tidak mengosongkan seluruh panel.** Balasan
 *      divalidasi per-item; yang gagal dibuang, sisanya tetap tampil.
 *   2. **Setiap request membawa token.** Tanpa header itu semua route
 *      mengembalikan 401 dan panel tampak "rusak" tanpa sebab yang jelas.
 *   3. **Setelan yang tidak dikenali jatuh ke default**, bukan `undefined`
 *      di tiap kolom formulir.
 *   4. **Nilai tambahan dari API tidak jadi `undefined` di layar.**
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_BOOKING_SETTINGS } from "@foto-booth/shared";

import {
  BookingHttpError,
  createBookingClient,
  parseBookingSettings,
  parsePackageReport,
  type BookingClientOptions,
} from "./bookingClient.ts";

const TOKEN = "tok-123";

function packageRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pkg-1",
    name: "Sesi Reguler",
    durationMinutes: 60,
    priceIdr: 500_000,
    depositIdr: 100_000,
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function bookingRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "bkg-1",
    token: "Tok3nBooking00000000000",
    packageId: "pkg-1",
    packageName: "Sesi Reguler",
    name: "Budi Santoso",
    email: "budi@example.com",
    phone: "+628123456789",
    start: "2026-10-13T02:00:00.000Z",
    end: "2026-10-13T03:00:00.000Z",
    durationMinutes: 60,
    priceIdr: 500_000,
    depositIdr: 100_000,
    depositStatus: "unpaid",
    status: "requested",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Klien dengan `fetch` palsu; `calls` mencatat setiap request. */
function clientWith(
  respond: (call: Call) => Response | Promise<Response>,
  options: Partial<BookingClientOptions> = {},
): { client: ReturnType<typeof createBookingClient>; calls: Call[] } {
  const calls: Call[] = [];
  const client = createBookingClient({
    token: TOKEN,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init };
      calls.push(call);
      return respond(call);
    }) as typeof globalThis.fetch,
    ...options,
  });
  return { client, calls };
}

/* ---- Penjaga autentikasi ----------------------------------------- */

test("setiap request membawa token Bearer", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ packages: [] }));
  await client.listPackages();

  assert.equal(calls.length, 1);
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
});

/* ---- Paket -------------------------------------------------------- */

test("daftar paket membuang baris rusak, sisanya tetap tampil", async () => {
  const { client } = clientWith(() =>
    jsonResponse({
      packages: [
        packageRaw({ id: "pkg-1", name: "Sesi Reguler" }),
        // Deposit > harga: melanggar refine skema → harus dibuang.
        packageRaw({ id: "pkg-2", priceIdr: 100_000, depositIdr: 900_000 }),
        packageRaw({ id: "pkg-3", name: "Sesi Premium" }),
      ],
    }),
  );

  const packages = await client.listPackages();
  assert.equal(packages.length, 2);
  assert.deepEqual(
    packages.map((pkg) => pkg.id),
    ["pkg-1", "pkg-3"],
  );
});

test("balasan paket yang bukan daftar menghasilkan daftar kosong, bukan lemparan", async () => {
  const { client } = clientWith(() => jsonResponse({ packages: "bukan-daftar" }));
  assert.deepEqual(await client.listPackages(), []);
});

test("buat paket mem-POST body dan memvalidasi balasannya", async () => {
  const { client, calls } = clientWith(() => jsonResponse(packageRaw({ id: "pkg-baru" }), 201));

  const created = await client.createPackage({
    name: "Sesi Reguler",
    durationMinutes: 60,
    priceIdr: 500_000,
    depositIdr: 100_000,
    active: true,
  });

  assert.equal(created.id, "pkg-baru");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.match(calls[0]?.url ?? "", /\/v1\/booking\/admin\/packages$/);
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
});

test("balasan paket yang tidak dikenali jadi BookingHttpError", async () => {
  const { client } = clientWith(() => jsonResponse({ paket: "aneh" }, 201));
  await assert.rejects(
    () => client.createPackage({ name: "X", durationMinutes: 60, priceIdr: 1, depositIdr: 0, active: true }),
    (error: unknown) => error instanceof BookingHttpError && error.status === 201,
  );
});

test("galat HTTP memakai pesan dari server, bukan status telanjang", async () => {
  const { client } = clientWith(() =>
    jsonResponse({ error: "slot_taken", message: "slot sudah dipakai booking lain", statusCode: 409 }, 409),
  );

  await assert.rejects(
    () => client.setStatus("bkg-1", { status: "approved" }),
    (error: unknown) => error instanceof BookingHttpError && error.message === "slot sudah dipakai booking lain",
  );
});

/* ---- Setelan ------------------------------------------------------ */

test("setelan yang tidak dikenali jatuh ke default", () => {
  assert.deepEqual(parseBookingSettings({ aneh: true }), DEFAULT_BOOKING_SETTINGS);
  assert.deepEqual(parseBookingSettings(null), DEFAULT_BOOKING_SETTINGS);
  assert.deepEqual(parseBookingSettings("bukan objek"), DEFAULT_BOOKING_SETTINGS);
});

test("setelan yang sah diteruskan apa adanya", () => {
  const parsed = parseBookingSettings({
    ...DEFAULT_BOOKING_SETTINGS,
    bufferMinutes: 45,
    paymentProvider: "manual",
  });
  assert.equal(parsed.bufferMinutes, 45);
  assert.equal(parsed.paymentProvider, "manual");
});

test("PUT setelan mengirim body dan membaca balasan", async () => {
  const { client, calls } = clientWith(() =>
    jsonResponse({ ...DEFAULT_BOOKING_SETTINGS, bufferMinutes: 45 }),
  );

  const settings = await client.updateSettings({ bufferMinutes: 45 });
  assert.equal(settings.bufferMinutes, 45);
  assert.equal(calls[0]?.init?.method, "PUT");
  assert.match(calls[0]?.url ?? "", /\/v1\/booking\/admin\/settings$/);
});

/* ---- Booking ------------------------------------------------------ */

test("daftar booking menyusun query dan membuang baris rusak", async () => {
  const { client, calls } = clientWith(() =>
    jsonResponse({
      bookings: [
        bookingRaw({ id: "bkg-1" }),
        // Status di luar daftar dikenal → dibuang.
        bookingRaw({ id: "bkg-2", status: "entah" }),
        bookingRaw({ id: "bkg-3" }),
      ],
    }),
  );

  const bookings = await client.listBookings({ from: "2026-10-01", to: "2026-10-31", status: "requested" });
  assert.equal(bookings.length, 2);
  assert.deepEqual(
    bookings.map((booking) => booking.id),
    ["bkg-1", "bkg-3"],
  );

  const url = calls[0]?.url ?? "";
  assert.match(url, /from=2026-10-01/);
  assert.match(url, /to=2026-10-31/);
  assert.match(url, /status=requested/);
});

test("tanpa filter, daftar booking tidak menambah query string", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ bookings: [] }));
  await client.listBookings();
  assert.match(calls[0]?.url ?? "", /\/v1\/booking\/admin\/bookings$/);
});

test("tandai deposit mem-POST status ke rute deposit", async () => {
  const { client, calls } = clientWith(() =>
    jsonResponse(bookingRaw({ depositStatus: "paid" })),
  );

  const updated = await client.setDeposit("bkg-1", "paid");
  assert.equal(updated.depositStatus, "paid");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.match(calls[0]?.url ?? "", /\/bookings\/bkg-1\/deposit$/);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { status: "paid" });
});

test("reschedule mem-POST waktu mulai baru", async () => {
  const { client, calls } = clientWith(() => jsonResponse(bookingRaw()));

  await client.reschedule("bkg-1", { start: "2026-10-14T02:00:00.000Z" });
  assert.match(calls[0]?.url ?? "", /\/bookings\/bkg-1\/reschedule$/);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { start: "2026-10-14T02:00:00.000Z" });
});

test("id booking di-encode supaya tidak merusak path", async () => {
  const { client, calls } = clientWith(() => jsonResponse(bookingRaw()));
  await client.setStatus("bkg/1 2", { status: "approved" });
  assert.match(calls[0]?.url ?? "", /\/bookings\/bkg%2F1%202$/);
});

/* ---- Laporan ------------------------------------------------------ */

test("laporan merapikan angka yang hilang jadi 0", async () => {
  const { client } = clientWith(() =>
    jsonResponse({
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
      total: { booked: 2, requested: 1 },
      packages: [
        { packageId: "pkg-1", packageName: "Sesi Reguler", durationMinutes: 60, booked: 2, bookedHours: 2 },
        { packageName: "Tanpa id" },
      ],
    }),
  );

  const report = await client.report();
  assert.equal(report.total.booked, 2);
  assert.equal(report.total.cancelled, 0);
  assert.equal(report.total.bookedHours, 0);
  // Baris tanpa `packageId` dibuang.
  assert.equal(report.packages.length, 1);
  assert.equal(report.packages[0]?.revenueIdr, 0);
});

test("parsePackageReport menolak bentuk asing", () => {
  assert.equal(parsePackageReport(null), null);
  assert.equal(parsePackageReport({ packageName: "tanpa id" }), null);
  assert.equal(parsePackageReport({ packageId: "pkg-1" })?.booked, 0);
});
