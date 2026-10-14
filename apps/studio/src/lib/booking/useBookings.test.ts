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

import type {
  BookingClient,
  BookingNotification,
  BookingReminders,
  BookingReport,
  ClientInvoice,
} from "./bookingClient.ts";
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

function reminders(overrides: Partial<BookingReminders> = {}): BookingReminders {
  return { notifierLive: false, reminders: [], ...overrides };
}

function notification(overrides: Partial<BookingNotification> = {}): BookingNotification {
  return {
    kind: "reminder",
    delivered: false,
    channel: "manual",
    subject: "Pengingat sesi foto",
    body: "Halo Budi, sesi foto Anda besok.",
    whatsappUrl: "https://wa.me/628123456789",
    ...overrides,
  };
}

function invoice(overrides: Partial<ClientInvoice["invoice"]> = {}): ClientInvoice["invoice"] {
  return {
    number: "INV-202610-0001",
    issuedAt: "2026-10-12T00:00:00.000Z",
    businessName: "Foto Booth",
    customer: { name: "Budi Santoso", email: "budi@example.com", phone: "628123456789" },
    packageName: "Sesi Reguler",
    scheduledAt: "Senin, 12 Okt 2026 · 09:00",
    durationMinutes: 60,
    lines: [{ label: "Sesi Reguler · 60 menit", amountIdr: 500_000 }],
    totalIdr: 500_000,
    paidIdr: 0,
    balanceDueIdr: 500_000,
    status: "unpaid",
    statusLabel: "Belum dibayar",
    depositStatus: "unpaid",
    depositStatusLabel: "Belum dibayar",
    bookingStatus: "requested",
    bookingStatusLabel: "Menunggu konfirmasi",
    ...overrides,
  };
}

interface FakeClient extends BookingClient {
  calls: string[];
  /** Ubah hasil `listBookings` berikutnya. */
  nextBookings: () => Promise<Booking[]>;
  /** Ubah hasil `report` berikutnya. */
  nextReport: () => Promise<BookingReport>;
  /** Ubah hasil `reminders` berikutnya. */
  nextReminders: () => Promise<BookingReminders>;
  /** Ubah hasil `notify` berikutnya. */
  nextNotify: () => Promise<BookingNotification>;
}

function fakeClient(initialBookings: () => Promise<Booking[]> = async () => []): FakeClient {
  let nextBookings = initialBookings;
  let nextReport: () => Promise<BookingReport> = async () => report();
  let nextReminders: () => Promise<BookingReminders> = async () => reminders();
  let nextNotify: () => Promise<BookingNotification> = async () => notification();
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
    get nextReminders() {
      return nextReminders;
    },
    set nextReminders(value: () => Promise<BookingReminders>) {
      nextReminders = value;
    },
    get nextNotify() {
      return nextNotify;
    },
    set nextNotify(value: () => Promise<BookingNotification>) {
      nextNotify = value;
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
    async invoice(id) {
      calls.push(`invoice:${id}`);
      return { invoice: invoice(), text: "Invoice INV-202610-0001" };
    },
    async invoiceText(id) {
      calls.push(`invoiceText:${id}`);
      return "Invoice INV-202610-0001";
    },
    async notify(id, kind) {
      calls.push(`notify:${id}:${kind}`);
      return nextNotify();
    },
    async reminders() {
      calls.push("reminders");
      return nextReminders();
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

/* ---- Pengingat H-1 ------------------------------------------------- */

test("refreshReminders menyimpan daftar + status kanal", async () => {
  const client = fakeClient();
  client.nextReminders = async () => ({
    notifierLive: true,
    reminders: [
      {
        bookingId: "bkg-1",
        name: "Budi Santoso",
        email: "budi@example.com",
        phone: "628123456789",
        start: "2026-10-13T02:00:00.000Z",
        subject: "Pengingat sesi foto",
        body: "Halo Budi",
        whatsappUrl: "https://wa.me/628123456789",
      },
    ],
  });
  const controller = createBookingsController({ client });

  await controller.refreshReminders();

  const state = controller.getState();
  assert.equal(state.reminders?.notifierLive, true);
  assert.equal(state.reminders?.reminders.length, 1);
  assert.equal(state.reminders?.reminders[0]?.bookingId, "bkg-1");
});

test("gagal memuat pengingat tidak mengosongkan daftar booking", async () => {
  const client = fakeClient(async () => [booking("bkg-1")]);
  const controller = createBookingsController({ client });
  await controller.refresh();

  client.nextReminders = async () => {
    throw new Error("pengingat tidak tersedia");
  };
  await controller.refreshReminders();

  const state = controller.getState();
  assert.equal(state.bookings.length, 1, "daftar booking tidak boleh hilang");
  assert.equal(state.reminders, null);
  assert.equal(state.error, "pengingat tidak tersedia");
});

test("tanpa klien, refreshReminders tidak memanggil API", async () => {
  const controller = createBookingsController({ client: null });
  await controller.refreshReminders();
  assert.equal(controller.getState().reminders, null);
  assert.equal(controller.getState().loading, false);
});

test("pengingat yang benar-benar terkirim menyusutkan daftar pengingat", async () => {
  const client = fakeClient();
  let reminderCalls = 0;
  client.nextReminders = async () => {
    reminderCalls += 1;
    // Panggilan pertama masih berisi booking; sesudah terkirim, server tidak
    // lagi melaporkannya — dan state harus ikut menyusut.
    return reminders({
      reminders:
        reminderCalls === 1
          ? [
              {
                bookingId: "bkg-1",
                name: "Budi",
                email: "budi@example.com",
                phone: "628123456789",
                start: "2026-10-13T02:00:00.000Z",
                subject: "s",
                body: "b",
                whatsappUrl: "https://wa.me/628123456789",
              },
            ]
          : [],
    });
  };
  client.nextNotify = async () => notification({ delivered: true, channel: "email" });

  const controller = createBookingsController({ client });
  await controller.refreshReminders();
  assert.equal(controller.getState().reminders?.reminders.length, 1);

  const result = await controller.notify("bkg-1", "reminder");
  assert.equal(result.delivered, true);
  assert.equal(controller.getState().reminders?.reminders.length, 0);
});

test("pengingat yang hanya disiapkan tidak menyusutkan daftar", async () => {
  const client = fakeClient();
  client.nextReminders = async () =>
    reminders({
      reminders: [
        {
          bookingId: "bkg-1",
          name: "Budi",
          email: "budi@example.com",
          phone: "628123456789",
          start: "2026-10-13T02:00:00.000Z",
          subject: "s",
          body: "b",
          whatsappUrl: "https://wa.me/628123456789",
        },
      ],
    });
  client.nextNotify = async () => notification({ delivered: false, channel: "manual" });

  const controller = createBookingsController({ client });
  await controller.refreshReminders();

  await controller.notify("bkg-1", "reminder");

  // Belum benar-benar keluar: booking tetap menunggu, dan tidak ada panggilan
  // `reminders` kedua yang tidak perlu.
  assert.equal(controller.getState().reminders?.reminders.length, 1);
  assert.equal(client.calls.filter((entry) => entry === "reminders").length, 1);
});

/* ---- Invoice ------------------------------------------------------ */

test("loadInvoice membaca dari server tanpa memuat ulang daftar", async () => {
  const client = fakeClient();
  const controller = createBookingsController({ client });

  const result = await controller.loadInvoice("bkg-1");

  assert.equal(result.invoice.number, "INV-202610-0001");
  assert.ok(client.calls.includes("invoice:bkg-1"));
  // Membaca invoice bukan perubahan data: daftar tidak perlu dimuat ulang.
  assert.equal(client.calls.includes("listBookings"), false);
});

test("loadInvoice tanpa klien ditolak, bukan mengembalikan kosong", async () => {
  const controller = createBookingsController({ client: null });
  await assert.rejects(() => controller.loadInvoice("bkg-1"), /belum login/);
});
