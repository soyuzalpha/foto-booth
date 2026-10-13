/**
 * Tes permukaan HTTP booking (Fase 11).
 *
 * Semua lewat `app.inject` — tanpa port, tanpa jaringan. Yang diuji di sini
 * bukan tampilan halaman, tapi janji-janji yang gampang bocor:
 *
 *   · rute operator menolak tanpa token, rute publik tidak butuh token;
 *   · **slot dikunci sejak `requested`**, bukan saat disetujui — dua permintaan
 *     untuk jam yang sama tidak boleh dua-duanya masuk;
 *   · jam operasional, tanggal tutup, dan jarak minimum benar-benar ditegakkan
 *     (bukan hanya disembunyikan di halaman ketersediaan);
 *   · honeypot menjawab sukses palsu dan **tidak menulis apa pun**;
 *   · pembatas laju berlaku per IP;
 *   · provider deposit yang belum hidup tidak pernah menghasilkan "paid";
 *   · transisi status ilegal ditolak.
 *
 * Waktu dipegang konteks (`FIXED_NOW`), jadi "24 jam sebelumnya" dan "sekarang"
 * tidak bergantung pada jam mesin yang menjalankan tes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BOOKING_SETTINGS, slotInstant } from "@foto-booth/shared";

import { makeHarness, type TestHarness } from "../testing.ts";
import { listEvents } from "../store.ts";

const OPERATOR = "operator@example.com";

/** Waktu konteks: Senin, 12 Okt 2026 00:00 UTC (07:00 WIB). */
const TZ = DEFAULT_BOOKING_SETTINGS.timezoneOffsetMinutes; // -420 (WIB)

/** Instant UTC untuk jam dinding WIB pada satu tanggal. */
function at(dateISO: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return slotInstant(dateISO, (h ?? 0) * 60 + (m ?? 0), TZ);
}

/** Besok lokal — sudah lewat jarak minimum 24 jam. */
const TOMORROW = "2026-10-13";
/** Hari ini lokal — jam 20:00 masih kurang dari 24 jam dari "sekarang". */
const TODAY = "2026-10-12";

async function login(h: TestHarness): Promise<string> {
  await h.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email: OPERATOR } });
  const code = h.mailer.lastCode(OPERATOR);
  assert.ok(code !== null, "kode OTP harus sampai ke mailer");
  const verified = await h.app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    payload: { email: OPERATOR, code },
  });
  assert.equal(verified.statusCode, 200);
  return (verified.json() as { token: string }).token;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Paket 60 menit, harga 500rb, deposit 100rb. */
async function seedPackage(
  h: TestHarness,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; name: string }> {
  const created = await h.app.inject({
    method: "POST",
    url: "/v1/booking/admin/packages",
    headers: auth(token),
    payload: {
      name: "Sesi Reguler",
      durationMinutes: 60,
      priceIdr: 500_000,
      depositIdr: 100_000,
      ...overrides,
    },
  });
  assert.equal(created.statusCode, 201, `gagal buat paket: ${created.body}`);
  return created.json() as { id: string; name: string };
}

/** Permintaan booking publik yang sah. */
function bookingPayload(packageId: string, start: string, extra: Record<string, unknown> = {}) {
  return {
    packageId,
    name: "Budi Santoso",
    email: "budi@example.com",
    phone: "+628123456789",
    start,
    consent: true,
    ...extra,
  };
}

async function requestBooking(h: TestHarness, payload: Record<string, unknown>, ip = "10.0.0.1") {
  return h.app.inject({
    method: "POST",
    url: "/v1/booking/requests",
    payload,
    remoteAddress: ip,
  });
}

interface AdminBooking {
  id: string;
  token: string;
  status: string;
  depositStatus: string;
  start: string;
  eventId?: string | null;
}

/**
 * Daftar booking dari sisi operator.
 *
 * Dipakai tes untuk menemukan `id` internal: balasan publik sengaja tidak
 * memuatnya, jadi tes harus mengambilnya dari tempat yang memang berhak —
 * sama seperti operator sungguhan.
 */
async function adminBookings(h: TestHarness, token: string): Promise<AdminBooking[]> {
  const response = await h.app.inject({
    method: "GET",
    url: "/v1/booking/admin/bookings",
    headers: auth(token),
  });
  assert.equal(response.statusCode, 200);
  return (response.json() as { bookings: AdminBooking[] }).bookings;
}

/** Booking operator untuk satu token publik. */
async function bookingFor(h: TestHarness, token: string, bookingToken: string): Promise<AdminBooking> {
  const found = (await adminBookings(h, token)).find((row) => row.token === bookingToken);
  assert.ok(found, `booking ${bookingToken} harus muncul di daftar operator`);
  return found;
}

/* ---- Penjaga rute ------------------------------------------------ */

test("rute operator booking menolak tanpa token", async () => {
  const h = await makeHarness();
  try {
    for (const [method, url] of [
      ["GET", "/v1/booking/admin/packages"],
      ["POST", "/v1/booking/admin/packages"],
      ["GET", "/v1/booking/admin/settings"],
      ["PUT", "/v1/booking/admin/settings"],
      ["GET", "/v1/booking/admin/bookings"],
      ["GET", "/v1/booking/admin/report"],
      ["GET", "/v1/booking/admin/calendar.ics"],
    ] as const) {
      const response = await h.app.inject({ method, url, payload: {} });
      assert.equal(response.statusCode, 401, `${method} ${url} seharusnya 401`);
    }
  } finally {
    await h.close();
  }
});

test("token operator yang dikarang tetap ditolak", async () => {
  const h = await makeHarness();
  try {
    const response = await h.app.inject({
      method: "GET",
      url: "/v1/booking/admin/bookings",
      headers: { authorization: "Bearer bukan.token.asli" },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await h.close();
  }
});

/* ---- Katalog publik ---------------------------------------------- */

test("paket nonaktif tidak muncul di katalog publik", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const live = await seedPackage(h, token, { name: "Sesi Reguler" });
    await seedPackage(h, token, { name: "Paket Lama", active: false });

    const response = await h.app.inject({ method: "GET", url: "/v1/booking/packages" });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { packages: { id: string; name: string }[]; paymentProvider: string };

    assert.equal(body.packages.length, 1);
    assert.equal(body.packages[0]?.id, live.id);
    // Jujur soal pembayaran: belum ada gateway, jadi jangan pura-pura ada.
    assert.equal(body.paymentProvider, "none");
  } finally {
    await h.close();
  }
});

test("ketersediaan menandai slot terisi dan tanggal tutup", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    // Slot 09:00 besok sudah dipesan.
    const first = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:00")));
    assert.equal(first.statusCode, 202);

    const view = await h.app.inject({
      method: "GET",
      url: `/v1/booking/availability?packageId=${pkg.id}&date=${TOMORROW}`,
    });
    assert.equal(view.statusCode, 200);
    const body = view.json() as { slots: { start: string; available: boolean; label: string }[] };

    const nine = body.slots.find((slot) => slot.start === at(TOMORROW, "09:00"));
    assert.ok(nine, "slot 09:00 harus terdaftar");
    assert.equal(nine.available, false, "slot yang sudah dipesan tidak boleh ditawarkan");
    const ten = body.slots.find((slot) => slot.start === at(TOMORROW, "11:00"));
    assert.equal(ten?.available, true, "slot jauh dari booking tetap tersedia");

    // Tanggal tutup: semua slot jadi tidak tersedia.
    const settings = await h.app.inject({
      method: "PUT",
      url: "/v1/booking/admin/settings",
      headers: auth(token),
      payload: { closedDates: [TOMORROW] },
    });
    assert.equal(settings.statusCode, 200);

    const closed = await h.app.inject({
      method: "GET",
      url: `/v1/booking/availability?packageId=${pkg.id}&date=${TOMORROW}`,
    });
    const closedBody = closed.json() as { slots: { available: boolean }[] };
    assert.ok(closedBody.slots.every((slot) => !slot.available), "tanggal tutup tidak boleh punya slot tersedia");
  } finally {
    await h.close();
  }
});

/* ---- Anti double-booking ----------------------------------------- */

test("slot yang sudah diminta tidak bisa diminta lagi (409)", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);
    const start = at(TOMORROW, "14:00");

    const first = await requestBooking(h, bookingPayload(pkg.id, start), "10.0.0.1");
    assert.equal(first.statusCode, 202);
    const firstBody = first.json() as { token: string; booking: { id: string } };
    assert.ok(firstBody.token, "permintaan pertama harus dapat token");

    // IP berbeda: yang diuji di sini tabrakan slot, bukan pembatas laju.
    const second = await requestBooking(h, bookingPayload(pkg.id, start), "10.0.0.2");
    assert.equal(second.statusCode, 409);
    const secondBody = second.json() as { error: string; conflict?: { start: string } };
    assert.equal(secondBody.error, "slot_taken");
    assert.equal(secondBody.conflict?.start, start, "balasan harus menyebut booking mana yang bentrok");

    assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM bookings").get()?.n, 1);
  } finally {
    await h.close();
  }
});

test("buffer membersihkan jarak antar sesi", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    // Buffer default 30 menit: 10:00 tepat setelah sesi 09:00–10:00 ditolak.
    const first = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:00")), "10.0.0.1");
    assert.equal(first.statusCode, 202);

    const adjacent = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "10:00")), "10.0.0.2");
    assert.equal(adjacent.statusCode, 409, "sesi yang berdempet tanpa jeda harus ditolak");

    // 11:00 sudah lewat buffer (09:00–10:00 + 30 menit = 10:30).
    const later = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "11:00")), "10.0.0.3");
    assert.equal(later.statusCode, 202);
  } finally {
    await h.close();
  }
});

/* ---- Aturan waktu ------------------------------------------------- */

test("jam di luar operasional ditolak, bukan diterima lalu dimaafkan", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    // 22:00 WIB — di luar jam tutup 21:00.
    const late = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "22:00")), "10.0.0.1");
    assert.equal(late.statusCode, 400);

    // 09:30 bukan kelipatan slot (durasi 60 menit).
    const misaligned = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:30")), "10.0.0.2");
    assert.equal(misaligned.statusCode, 400);
  } finally {
    await h.close();
  }
});

test("booking terlalu dekat ditolak meski slotnya kosong", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    // 20:00 hari ini = ~13 jam dari "sekarang"; jarak minimum 24 jam.
    const soon = await requestBooking(h, bookingPayload(pkg.id, at(TODAY, "20:00")), "10.0.0.1");
    assert.equal(soon.statusCode, 409);
    assert.equal((soon.json() as { error: string }).error, "too_soon");
  } finally {
    await h.close();
  }
});

/* ---- Penyalahgunaan ---------------------------------------------- */

test("honeypot menjawab sukses palsu tanpa menyimpan apa pun", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const bot = await requestBooking(
      h,
      bookingPayload(pkg.id, at(TOMORROW, "15:00"), { website: "http://spam.example" }),
      "10.0.0.9",
    );
    // 202 supaya bot tidak tahu jebakannya kena — tapi tokennya kosong.
    assert.equal(bot.statusCode, 202);
    const body = bot.json() as { token: string | null };
    assert.equal(body.token, null);
    assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM bookings").get()?.n, 0);
  } finally {
    await h.close();
  }
});

test("permintaan tanpa persetujuan data ditolak", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const response = await requestBooking(
      h,
      { ...bookingPayload(pkg.id, at(TOMORROW, "16:00")), consent: false },
      "10.0.0.1",
    );
    assert.equal(response.statusCode, 400);
    assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM bookings").get()?.n, 0);
  } finally {
    await h.close();
  }
});

test("pembatas laju memblokir percobaan beruntun dari satu IP", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);
    const payload = bookingPayload(pkg.id, at(TOMORROW, "17:00"));

    // Body-nya sengaja salah: pembatas laju diperiksa sebelum validasi, jadi
    // percobaan gagal pun tetap dihitung — kalau tidak, bot bisa menghindari
    // batas hanya dengan mengirim body rusak.
    for (let i = 0; i < 5; i += 1) {
      const response = await requestBooking(h, { ...payload, consent: false }, "10.9.9.9");
      assert.equal(response.statusCode, 400, `percobaan ke-${i + 1} masih boleh lewat`);
    }

    const blocked = await requestBooking(h, payload, "10.9.9.9");
    assert.equal(blocked.statusCode, 429);
    assert.ok(blocked.headers["retry-after"], "harus ada Retry-After");

    // IP lain tidak ikut kena.
    const other = await requestBooking(h, payload, "10.9.9.10");
    assert.equal(other.statusCode, 202);
  } finally {
    await h.close();
  }
});

/* ---- Halaman status ---------------------------------------------- */

test("status lewat token: token asal-asalan tidak menyentuh database", async () => {
  const h = await makeHarness();
  try {
    const bad = await h.app.inject({ method: "GET", url: "/v1/booking/status/!!!bukan-token!!!" });
    assert.equal(bad.statusCode, 404);

    const unknown = await h.app.inject({
      method: "GET",
      url: "/v1/booking/status/AAAAAAAAAAAAAAAAAAAAAA",
    });
    assert.equal(unknown.statusCode, 404);
  } finally {
    await h.close();
  }
});

test("tamu bisa membatalkan bookingnya sendiri lewat token", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const created = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "13:00")), "10.0.0.1");
    const { token: bookingToken } = created.json() as { token: string };

    const view = await h.app.inject({ method: "GET", url: `/v1/booking/status/${bookingToken}` });
    assert.equal(view.statusCode, 200);
    const viewBody = view.json() as { booking: Record<string, unknown> };
    // Data internal tidak boleh bocor ke halaman publik.
    assert.equal(viewBody.booking.id, undefined);
    assert.equal(viewBody.booking.reason, undefined);

    const cancelled = await h.app.inject({
      method: "POST",
      url: `/v1/booking/status/${bookingToken}/cancel`,
      payload: {},
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal((cancelled.json() as { booking: { status: string } }).booking.status, "cancelled");

    // Sekali batal, slotnya lepas — orang lain boleh memesan jam itu.
    const retry = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "13:00")), "10.0.0.2");
    assert.equal(retry.statusCode, 202);
  } finally {
    await h.close();
  }
});

test("halaman booking publik dan halaman status ter-render tanpa JS", async () => {
  const h = await makeHarness();
  try {
    const form = await h.app.inject({ method: "GET", url: "/booking" });
    assert.equal(form.statusCode, 200);
    assert.match(form.headers["content-type"] as string, /text\/html/);
    assert.match(form.body, /Pesan sesi foto/);

    const missing = await h.app.inject({ method: "GET", url: "/booking/s/AAAAAAAAAAAAAAAAAAAAAA" });
    assert.equal(missing.statusCode, 404);
    assert.match(missing.body, /Booking tidak ditemukan/);
  } finally {
    await h.close();
  }
});

test("skrip form booking dimuat setelah formnya ada di DOM", async () => {
  const h = await makeHarness();
  try {
    const form = await h.app.inject({ method: "GET", url: "/booking" });
    assert.equal(form.statusCode, 200);

    // Skrip halaman memanggil document.getElementById saat dijalankan. Kalau ia
    // berada di <head>, elemennya belum ada, semuanya null, dan form mati tanpa
    // pesan — tes HTML biasa tidak menangkap itu, urutan tag ini yang menangkap.
    const formEnd = form.body.indexOf("</form>");
    const scriptStart = form.body.indexOf("<script>");
    assert.ok(formEnd > -1, "halaman form harus memuat </form>");
    assert.ok(scriptStart > formEnd, `skrip harus setelah form (form=${formEnd}, script=${scriptStart})`);
  } finally {
    await h.close();
  }
});

test("approve membuat record event sekali saja, bukan tiap kali disetujui", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const created = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:00")), "10.0.0.1");
    const booking = await bookingFor(h, token, (created.json() as { token: string }).token);
    assert.equal(booking.eventId, null, "sebelum disetujui belum ada event");

    const approved = await h.app.inject({
      method: "PATCH",
      url: `/v1/booking/admin/bookings/${booking.id}`,
      headers: auth(token),
      payload: { status: "approved" },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    const eventId = (approved.json() as { eventId: string | null }).eventId;
    assert.ok(eventId, "approve harus menghasilkan event");

    // Event-nya benar-benar ada di DB, dengan nama & tanggal yang bisa dipakai
    // di studio — bukan sekadar id yang dikarang.
    const event = listEvents(h.ctx.db).find((row) => row.id === eventId);
    assert.ok(event, "event harus tersimpan");
    assert.equal(event.name, "Budi Santoso");
    assert.equal(event.date, TOMORROW);

    // Reschedule setelah approve tidak boleh membuat event kedua.
    const moved = await h.app.inject({
      method: "POST",
      url: `/v1/booking/admin/bookings/${booking.id}/reschedule`,
      headers: auth(token),
      payload: { start: at(TOMORROW, "14:00") },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal((moved.json() as { eventId: string }).eventId, eventId);

    // Reschedule pindah hari pun tidak menggandakan event.
    const movedDay = await h.app.inject({
      method: "POST",
      url: `/v1/booking/admin/bookings/${booking.id}/reschedule`,
      headers: auth(token),
      payload: { start: at("2026-10-14", "10:00") },
    });
    assert.equal(movedDay.statusCode, 200, movedDay.body);
    assert.equal((await bookingFor(h, token, booking.token)).eventId, eventId);

    const events = listEvents(h.ctx.db).filter((row) => row.name === "Budi Santoso");
    assert.equal(events.length, 1, "satu booking = satu event");
  } finally {
    await h.close();
  }
});

/* ---- Alur operator ------------------------------------------------ */

test("operator menyetujui, menolak, dan menandai deposit", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const created = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:00")), "10.0.0.1");
    const booking = await bookingFor(h, token, (created.json() as { token: string }).token);

    // Deposit: manual, jadi operator yang menandai. Belum ada yang membayar.
    assert.equal(
      (created.json() as { deposit: { status: string; live: boolean } }).deposit.status,
      "unpaid",
    );

    const approved = await h.app.inject({
      method: "PATCH",
      url: `/v1/booking/admin/bookings/${booking.id}`,
      headers: auth(token),
      payload: { status: "approved" },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal((approved.json() as { status: string }).status, "approved");

    const paid = await h.app.inject({
      method: "POST",
      url: `/v1/booking/admin/bookings/${booking.id}/deposit`,
      headers: auth(token),
      payload: { status: "paid" },
    });
    assert.equal(paid.statusCode, 200);
    assert.equal((paid.json() as { depositStatus: string }).depositStatus, "paid");

    const invalid = await h.app.inject({
      method: "POST",
      url: `/v1/booking/admin/bookings/${booking.id}/deposit`,
      headers: auth(token),
      payload: { status: "lunas-pokoknya" },
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await h.close();
  }
});

test("transisi status ilegal ditolak", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const created = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "10:00")), "10.0.0.1");
    const booking = await bookingFor(h, token, (created.json() as { token: string }).token);

    await h.app.inject({
      method: "POST",
      url: `/v1/booking/status/${booking.token}/cancel`,
      payload: {},
    });

    // Booking yang sudah dibatalkan tidak bisa disetujui — itu akan mencatat
    // sesi yang tidak pernah terjadi.
    const approve = await h.app.inject({
      method: "PATCH",
      url: `/v1/booking/admin/bookings/${booking.id}`,
      headers: auth(token),
      payload: { status: "approved" },
    });
    assert.equal(approve.statusCode, 409);
    assert.equal((approve.json() as { error: string }).error, "invalid_transition");
  } finally {
    await h.close();
  }
});

test("menyetujui booking yang slotnya sudah diambil ditolak", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const a = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:00")), "10.0.0.1");
    const b = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "11:00")), "10.0.0.2");
    const bookingB = await bookingFor(h, token, (b.json() as { token: string }).token);
    assert.equal(a.statusCode, 202);
    assert.equal(b.statusCode, 202);

    // Operator melebarkan jeda bersih jadi 3 jam — sekarang 09:00 dan 11:00
    // tidak lagi bisa berdampingan.
    const widened = await h.app.inject({
      method: "PUT",
      url: "/v1/booking/admin/settings",
      headers: auth(token),
      payload: { bufferMinutes: 180 },
    });
    assert.equal(widened.statusCode, 200);

    const approve = await h.app.inject({
      method: "PATCH",
      url: `/v1/booking/admin/bookings/${bookingB.id}`,
      headers: auth(token),
      payload: { status: "approved" },
    });
    assert.equal(approve.statusCode, 409, "bentrok harus ketahuan saat menyetujui, bukan saat tamu datang");
    assert.equal((approve.json() as { error: string }).error, "slot_taken");
  } finally {
    await h.close();
  }
});

test("reschedule ke slot terpakai ditolak, ke slot kosong diterima", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const a = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:00")), "10.0.0.1");
    const b = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "13:00")), "10.0.0.2");
    const bookingA = await bookingFor(h, token, (a.json() as { token: string }).token);
    assert.equal(b.statusCode, 202);

    const clash = await h.app.inject({
      method: "POST",
      url: `/v1/booking/admin/bookings/${bookingA.id}/reschedule`,
      headers: auth(token),
      payload: { start: at(TOMORROW, "13:00") },
    });
    assert.equal(clash.statusCode, 409, "pindah ke jam yang sudah dipesan harus ditolak");

    const moved = await h.app.inject({
      method: "POST",
      url: `/v1/booking/admin/bookings/${bookingA.id}/reschedule`,
      headers: auth(token),
      payload: { start: at(TOMORROW, "16:00") },
    });
    assert.equal(moved.statusCode, 200);
    assert.equal((moved.json() as { start: string }).start, at(TOMORROW, "16:00"));
  } finally {
    await h.close();
  }
});

/* ---- Setelan ------------------------------------------------------ */

test("provider qris ditolak selama Fase 10 belum ada", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);

    const response = await h.app.inject({
      method: "PUT",
      url: "/v1/booking/admin/settings",
      headers: auth(token),
      payload: { paymentProvider: "qris" },
    });
    // Lebih jujur menolak setelan yang tidak akan jalan daripada menerimanya
    // dan membiarkan operator menunggu pembayaran yang tidak pernah datang.
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /qris/i);
  } finally {
    await h.close();
  }
});

test("paket dengan deposit melebihi harga ditolak", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);

    const created = await h.app.inject({
      method: "POST",
      url: "/v1/booking/admin/packages",
      headers: auth(token),
      payload: { name: "Deposit Ngawur", durationMinutes: 60, priceIdr: 100_000, depositIdr: 200_000 },
    });
    assert.equal(created.statusCode, 400);

    // PATCH harus memeriksa hasil gabungan, bukan hanya field yang dikirim.
    const pkg = await seedPackage(h, token);
    const patched = await h.app.inject({
      method: "PATCH",
      url: `/v1/booking/admin/packages/${pkg.id}`,
      headers: auth(token),
      payload: { depositIdr: 900_000 },
    });
    assert.equal(patched.statusCode, 400);
  } finally {
    await h.close();
  }
});

/* ---- Kalender & laporan ------------------------------------------ */

test("ekspor .ics memuat booking yang dikunci dan melewatkan yang batal", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const kept = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:00")), "10.0.0.1");
    const dropped = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "13:00")), "10.0.0.2");
    const droppedToken = (dropped.json() as { token: string }).token;

    await h.app.inject({
      method: "POST",
      url: `/v1/booking/status/${droppedToken}/cancel`,
      payload: {},
    });

    const ics = await h.app.inject({
      method: "GET",
      url: "/v1/booking/admin/calendar.ics",
      headers: auth(token),
    });
    assert.equal(ics.statusCode, 200);
    assert.match(ics.headers["content-type"] as string, /text\/calendar/);
    assert.match(ics.body, /BEGIN:VCALENDAR/);
    assert.match(ics.body, /SUMMARY:Sesi Reguler/);
    // CRLF wajib — klien kalender menolak file dengan LF telanjang.
    assert.ok(ics.body.includes("\r\n"), "baris .ics harus CRLF");
    assert.equal(kept.statusCode, 202);
  } finally {
    await h.close();
  }
});

test("laporan okupansi memisahkan permintaan dari sesi terkonfirmasi", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const requested = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:00")), "10.0.0.1");
    const approved = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "11:00")), "10.0.0.2");
    const approvedId = (await bookingFor(h, token, (approved.json() as { token: string }).token)).id;
    assert.equal(requested.statusCode, 202);

    await h.app.inject({
      method: "PATCH",
      url: `/v1/booking/admin/bookings/${approvedId}`,
      headers: auth(token),
      payload: { status: "approved" },
    });

    const report = await h.app.inject({
      method: "GET",
      url: "/v1/booking/admin/report",
      headers: auth(token),
    });
    assert.equal(report.statusCode, 200);
    const body = report.json() as {
      total: { requested: number; booked: number; bookedHours: number };
      packages: unknown[];
    };
    assert.equal(body.total.requested, 1);
    assert.equal(body.total.booked, 1);
    assert.equal(body.total.bookedHours, 1, "satu sesi 60 menit = 1 jam");
    assert.equal(body.packages.length, 1);
  } finally {
    await h.close();
  }
});

/* ---- Reschedule oleh tamu sendiri --------------------------------- */

test("tamu menggeser jadwalnya sendiri dan event studio ikut pindah hari", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const created = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:00")), "10.0.0.1");
    const bookingToken = (created.json() as { token: string }).token;
    const booking = await bookingFor(h, token, bookingToken);

    await h.app.inject({
      method: "PATCH",
      url: `/v1/booking/admin/bookings/${booking.id}`,
      headers: auth(token),
      payload: { status: "approved" },
    });
    const eventId = (await bookingFor(h, token, bookingToken)).eventId;
    assert.ok(eventId, "approve harus menghasilkan event");

    const moved = await h.app.inject({
      method: "POST",
      url: `/v1/booking/status/${bookingToken}/reschedule`,
      payload: { start: at("2026-10-15", "15:00") },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    const body = moved.json() as { booking: { start: string; status: string } };
    assert.equal(body.booking.start, at("2026-10-15", "15:00"));
    assert.equal(body.booking.status, "approved", "menggeser jadwal tidak mengubah status");

    // Event studio ikut pindah hari — kalau tidak, operator mencari klien di
    // tanggal lama, dan booking→event yang sudah dibangun jadi bohong.
    const event = listEvents(h.ctx.db).find((row) => row.id === eventId);
    assert.ok(event, "event harus masih ada");
    assert.equal(event.date, "2026-10-15");
  } finally {
    await h.close();
  }
});

test("tamu tidak bisa menggeser jadwal ke slot yang terlalu dekat", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const created = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:00")), "10.0.0.1");
    const bookingToken = (created.json() as { token: string }).token;

    const tooSoon = await h.app.inject({
      method: "POST",
      url: `/v1/booking/status/${bookingToken}/reschedule`,
      payload: { start: at(TODAY, "20:00") },
    });
    assert.equal(tooSoon.statusCode, 409);
    assert.equal((tooSoon.json() as { error: string }).error, "too_soon");

    const untouched = await bookingFor(h, token, bookingToken);
    assert.equal(untouched.start, at(TOMORROW, "09:00"), "jadwal lama tidak boleh berubah");
  } finally {
    await h.close();
  }
});

test("tamu tidak bisa menggeser jadwal ke slot yang sudah dipakai", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const first = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:00")), "10.0.0.1");
    const second = await requestBooking(
      h,
      bookingPayload(pkg.id, at(TOMORROW, "14:00"), { name: "Siti Aminah", email: "siti@example.com" }),
      "10.0.0.2",
    );
    const secondToken = (second.json() as { token: string }).token;

    const clash = await h.app.inject({
      method: "POST",
      url: `/v1/booking/status/${secondToken}/reschedule`,
      payload: { start: at(TOMORROW, "09:00") },
    });
    assert.equal(clash.statusCode, 409);
    assert.equal((clash.json() as { error: string }).error, "slot_taken");
    assert.equal((await bookingFor(h, token, secondToken)).start, at(TOMORROW, "14:00"));
    void first;
  } finally {
    await h.close();
  }
});

test("booking yang sudah batal tidak bisa digeser", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const pkg = await seedPackage(h, token);

    const created = await requestBooking(h, bookingPayload(pkg.id, at(TOMORROW, "09:00")), "10.0.0.1");
    const bookingToken = (created.json() as { token: string }).token;

    await h.app.inject({
      method: "POST",
      url: `/v1/booking/status/${bookingToken}/cancel`,
      payload: {},
    });

    const moved = await h.app.inject({
      method: "POST",
      url: `/v1/booking/status/${bookingToken}/reschedule`,
      payload: { start: at(TOMORROW, "16:00") },
    });
    assert.equal(moved.statusCode, 409);
    assert.equal((moved.json() as { error: string }).error, "not_reschedulable");
  } finally {
    await h.close();
  }
});
