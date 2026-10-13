/**
 * Tes pengendali daftar booking (`createBookingsController`).
 *
 * Logikanya sengaja dipisah dari React supaya janji yang tidak kelihatan di UI
 * bisa dibuktikan di sini:
 *
 *   1. **Tanpa token, jangan memanggil API.** Kiosk yang belum login akan
 *      menembakkan 401 beruntun kalau `refresh` tetap jalan.
 *   2. **Balapan respons dibuang.** Operator menekan "Muat ulang" dua kali;
 *      respons pertama yang datang belakangan tidak boleh menimpa yang baru.
 *   3. **Aksi yang mengubah data memuat ulang dari server**, bukan menambal
 *      lokal — angka di layar harus sama dengan yang dilihat server.
 *   4. **Satu kegagalan tidak mengosongkan yang lain.** Laporan gagal tidak
 *      menghapus daftar booking yang sudah tampil.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_BOOKING_SETTINGS, type Booking, type BookingPackage } from "@foto-booth/shared";

import type { BookingClient, BookingReport } from "./bookingClient.ts";
import { createBookingsController, type BookingsState } from "./useBookings.ts";

function booking(id: string, overrides: Partial<Booking> = {}): Booking {
  return {
    id,
    token: `tok-${id}`,
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

function pkg(id: string, overrides: Partial<BookingPackage> = {}): BookingPackage {
  return {
    id,
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

function report(): BookingReport {
  return {
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-11-01T00:00:00.000Z",
    total: {
      booked: 0,
      requested: 0,
      cancelled: 0,
      rejected: 0,
      bookedHours: 0,
      revenueIdr: 0,
      depositIdr: 0,
    },
    packages: [],
  };
}

interface FakeClient extends BookingClient {
  calls: string[];
  /** Ubah hasil `listBookings` berikutnya. */
  nextBookings: () => Promise<Booking[]>;
  /** Ubah hasil `report` berikutnya. */
  nextReport: () => Promise<BookingReport>;
}

function fakeClient(initialBookings: () => Promise<Booking[]> = async () => []): FakeClient {
  let nextBookings = initialBookings;
  let nextReport: () => Promise<BookingReport> = async () => report();
  const calls: string[] = [];

  return {
    calls,
    get nextBookings() {
      return nextBookings;
    },
    set nextBookings(value: () => Promise<Booking[]>) {
      nextBookings = value;
    },
    get nextReport() {
      return nextReport;
    },
    set nextReport(value: () => Promise<BookingReport>) {
      nextReport = value;
    },

    async listPackages() {
      calls.push("listPackages");
      return [pkg("pkg-1")];
    },
    async createPackage(body) {
      calls.push("createPackage");
      return pkg("pkg-baru", { name: body.name });
    },
    async updatePackage(id, body) {
      calls.push(`updatePackage:${id}`);
      return pkg(id, { name: body.name ?? "Sesi Reguler" });
    },
    async getSettings() {
      calls.push("getSettings");
      return DEFAULT_BOOKING_SETTINGS;
    },
    async updateSettings(body) {
      calls.push("updateSettings");
      return { ...DEFAULT_BOOKING_SETTINGS, ...body };
    },
    async listBookings() {
      calls.push("listBookings");
      return nextBookings();
    },
    async setStatus(id, body) {
      calls.push(`setStatus:${id}:${body.status}`);
      return booking(id, { status: body.status });
    },
    async setDeposit(id, status) {
      calls.push(`setDeposit:${id}:${status}`);
      return booking(id, { depositStatus: status });
    },
    async reschedule(id, body) {
      calls.push(`reschedule:${id}`);
      return booking(id, { start: body.start });
    },
    async report() {
      calls.push("report");
      return nextReport();
    },
  };
}

/* ---- Penjaga token ------------------------------------------------ */

test("tanpa klien (belum login), refresh tidak memanggil API", async () => {
  const states: BookingsState[] = [];
  const controller = createBookingsController({
    client: null,
    onState: (state) => states.push(state),
  });

  await controller.refresh();

  const last = controller.getState();
  assert.deepEqual(last.bookings, []);
  assert.deepEqual(last.packages, []);
  assert.equal(last.settings, DEFAULT_BOOKING_SETTINGS);
  assert.equal(last.loading, false);
  // Yang penting: tidak ada state "memuat" yang tak pernah selesai.
  assert.ok(states.every((state) => state.loading === false));
});

test("aksi tanpa klien ditolak, bukan diam-diam tidak terjadi", async () => {
  const controller = createBookingsController({ client: null });
  await assert.rejects(() => controller.setStatus("bkg-1", { status: "approved" }), /belum login/);
});

/* ---- Pemuatan ----------------------------------------------------- */

test("refresh memuat booking, paket, dan setelan sekaligus", async () => {
  const client = fakeClient(async () => [booking("bkg-1"), booking("bkg-2")]);
  const controller = createBookingsController({ client });

  await controller.refresh();

  const state = controller.getState();
  assert.deepEqual(
    state.bookings.map((row) => row.id),
    ["bkg-1", "bkg-2"],
  );
  assert.equal(state.packages.length, 1);
  assert.equal(state.settings.bufferMinutes, DEFAULT_BOOKING_SETTINGS.bufferMinutes);
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
});

test("kegagalan memuat menyimpan daftar lama dan melaporkan galat", async () => {
  const client = fakeClient(async () => [booking("bkg-1")]);
  const controller = createBookingsController({ client });
  await controller.refresh();

  client.nextBookings = async () => {
    throw new Error("jaringan putus");
  };
  await controller.refresh();

  const state = controller.getState();
  assert.equal(state.bookings.length, 1, "daftar lama tidak boleh hilang");
  assert.equal(state.error, "jaringan putus");
  assert.equal(state.loading, false);
});

test("balapan respons dibuang: yang lama tidak menimpa yang baru", async () => {
  let releaseFirst!: (rows: Booking[]) => void;
  const firstResponse = new Promise<Booking[]>((resolve) => {
    releaseFirst = resolve;
  });
  let call = 0;

  const client = fakeClient(async () => {
    call += 1;
    // Permintaan pertama sengaja menggantung sampai kita lepaskan nanti.
    if (call === 1) return firstResponse;
    return [booking("baru")];
  });

  const controller = createBookingsController({ client });

  const first = controller.refresh();
  const second = controller.refresh();
  await second;

  // Lepaskan yang pertama setelah yang kedua selesai.
  releaseFirst([booking("lama")]);
  await first;

  assert.deepEqual(
    controller.getState().bookings.map((row) => row.id),
    ["baru"],
    "respons pertama yang datang belakangan harus diabaikan",
  );
});

/* ---- Aksi --------------------------------------------------------- */

test("mengubah status memuat ulang dari server", async () => {
  const client = fakeClient(async () => [booking("bkg-1")]);
  const controller = createBookingsController({ client });

  await controller.setStatus("bkg-1", { status: "approved" });

  assert.ok(client.calls.includes("setStatus:bkg-1:approved"));
  // `refresh` memuat ulang ketiganya: perubahan status memengaruhi daftar,
  // dan ketersediaan paket bisa ikut berubah.
  assert.equal(client.calls.filter((entry) => entry === "listBookings").length, 1);
});

test("menandai deposit lalu memuat ulang", async () => {
  const client = fakeClient();
  const controller = createBookingsController({ client });

  await controller.setDeposit("bkg-1", "paid");
  assert.ok(client.calls.includes("setDeposit:bkg-1:paid"));
  assert.ok(client.calls.includes("listBookings"));
});

/* ---- Laporan ------------------------------------------------------ */

test("laporan gagal tidak mengosongkan daftar booking", async () => {
  const client = fakeClient(async () => [booking("bkg-1")]);
  const controller = createBookingsController({ client });
  await controller.refresh();

  client.nextReport = async () => {
    throw new Error("laporan tidak tersedia");
  };
  await controller.refreshReport();

  const state = controller.getState();
  assert.equal(state.bookings.length, 1);
  assert.equal(state.report, null);
  assert.equal(state.error, "laporan tidak tersedia");
});

test("laporan berhasil disimpan di state", async () => {
  const client = fakeClient();
  client.nextReport = async () => ({ ...report(), total: { ...report().total, booked: 3 } });
  const controller = createBookingsController({ client });

  await controller.refreshReport();
  assert.equal(controller.getState().report?.total.booked, 3);
});
