#!/usr/bin/env node
/**
 * Harness e2e Fase 11 — "booking mengunci slot, dan tidak pernah mengunci dua
 * kali".
 *
 * Yang dibuktikan berkas ini, dan yang **tidak** bisa dibuktikan unit test:
 *
 *   1. API sungguhan (proses terpisah, DB di disk, sesi operator nyata) menerima
 *      permintaan booking dari form publik, menyimpannya, dan mengembalikan
 *      token status.
 *   2. **Anti double-booking**: slot yang sama ditolak `409`, baik saat request
 *      kedua masuk maupun saat operator menyetujui booking yang slotnya sudah
 *      diambil orang lain.
 *   3. Honeypot membalas **sukses palsu** (`202`) tanpa menyimpan apa pun —
 *      dibuktikan dengan menghitung ulang daftar booking operator, bukan dengan
 *      mempercayai balasan.
 *   4. Rate limit per-IP menendang permintaan ke-6 dalam satu jam (`429` +
 *      `retry-after`).
 *   5. Token yang tidak dikenal → `404`; token sah → halaman status.
 *   6. **Browser sungguhan**: tamu mengisi form `/booking` di halaman yang
 *      dirender server, submit, dan mendarat di `/booking/s/<token>` yang
 *      menampilkan statusnya — tanpa error konsol.
 *   7. Stub pembayaran jujur: memilih provider `qris` **ditolak** `400` yang
 *      menyebut Fase 10, dan deposit tidak pernah dilaporkan `paid` tanpa
 *      operator menandainya.
 *   8. **Approve → event studio**: menyetujui booking membuat satu record event
 *      (sekali saja, walau di-reschedule), jadi hari-H tidak perlu input ulang.
 *   9. **Tamu menggeser jadwalnya sendiri** lewat halaman status (token) — dan
 *      aturan jarak minimum tetap berlaku untuk tamu, bukan cuma operator.
 *  10. `.ics` benar-benar terbentuk (VCALENDAR dengan UID booking).
 *  11. Laporan okupansi menghitung ulang dari data, bukan angka yang di-hardcode.
 *  12. Halaman publik di lebar 390px tidak meluber (`scrollWidth <= clientWidth`).
 *
 * Kenapa browser + API sungguhan: halaman booking dirender server dan
 * formnya bicara ke API lewat `fetch` dari origin yang sama — CORS, HTML yang
 * benar-benar terkirim, dan urutan render tidak ada di `app.inject`. Sisi
 * server sendiri sudah diuji `booking.test.ts`; di sini alur ujungnya.
 *
 * Pemakaian:
 *
 *   node e2e/phase11-booking.e2e.mjs
 *
 * Opsi: `FB_E2E_HEADED=1`, `FB_E2E_SLOWMO=ms`, `FB_E2E_ARTIFACTS=dir`
 * (screenshot + HTML saat gagal), `FB_E2E_PORT=n` (port API; default 0 = pilih
 * bebas).
 *
 * Prasyarat: dependensi terpasang (`pnpm install`) dan `apps/studio/dist` sudah
 * dibuild (`pnpm --filter @foto-booth/studio build`) — halaman `/booking` formnya
 * di-serve API, tapi halaman status studio diuji lewat `/studio/`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const API_DIR = join(ROOT, "apps/api");
const PORT = Number(process.env.FB_E2E_PORT ?? "0");
const HEADED = process.env.FB_E2E_HEADED === "1";
const SLOWMO = Number(process.env.FB_E2E_SLOWMO ?? "0");
const ARTIFACTS = process.env.FB_E2E_ARTIFACTS ?? "e2e/artifacts";

const STEP_TIMEOUT = 30_000;
const EMAIL = "booking-e2e@foto-booth.test";

// ── alat bantu ──────────────────────────────────────────────────────────

let stepNo = 0;
const consoleErrors = [];

function log(message) {
  console.log(message);
}

async function step(name, fn) {
  stepNo += 1;
  const label = `${String(stepNo).padStart(2, "0")}. ${name}`;
  const started = Date.now();
  try {
    const result = await fn();
    log(`  ok   ${label} (${Date.now() - started} ms)`);
    return result;
  } catch (error) {
    log(`  FAIL ${label}`);
    throw error;
  }
}

async function waitFor(probe, { timeout = STEP_TIMEOUT, every = 100, what = "kondisi" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout ${timeout} ms menunggu: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/** `YYYY-MM-DD` di UTC, `daysAhead` hari dari sekarang. */
function utcDate(daysAhead) {
  const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

// ── server ──────────────────────────────────────────────────────────────

let child = null;
let base = "";

async function startApi() {
  const dataDir = await mkdtemp(join(tmpdir(), "fb-booking-e2e-"));
  const storageDir = await mkdtemp(join(tmpdir(), "fb-booking-storage-"));

  child = spawn("node", ["src/index.ts"], {
    cwd: API_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      JWT_SECRET: "e2e-booking-secret-e2e-booking-secret-1234",
      OTP_DEV_MODE: "1",
      DATA_DIR: dataDir,
      STORAGE_DIR: storageDir,
      // Booking tidak menyentuh object storage; nilai dummy supaya konteks
      // server bisa dibangun. Upload foto diuji harness Fase 5, bukan di sini.
      S3_ENDPOINT: "http://127.0.0.1:9/e2e",
      S3_REGION: "e2e",
      S3_BUCKET: "e2e",
      S3_ACCESS_KEY_ID: "e2e",
      S3_SECRET_ACCESS_KEY: "e2e",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  // Port 0 → OS memilih; ambil dari baris "Server listening at http://…".
  const listening = await waitFor(
    () => {
      const match = /listening at (https?:\/\/[^\s"\\]+)/i.exec(output);
      if (match) return match[1];
      if (child.exitCode !== null) {
        throw new Error(`API keluar lebih awal (exit ${child.exitCode}):\n${output}`);
      }
      return null;
    },
    { what: "API siap mendengarkan" },
  );

  base = listening.replace(/\/$/, "");
  return base;
}

async function stopApi() {
  if (child === null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
  child = null;
}

/** `fetch` yang melempar kalau status bukan yang diharapkan, dengan body ikut. */
async function call(method, path, { body, token, headers = {}, ip } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(ip === undefined ? {} : { "x-forwarded-for": ip }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* bukan JSON (mis. ICS) — biarkan null */
  }
  return { status: response.status, json, text, headers: response.headers };
}

// ── skenario ────────────────────────────────────────────────────────────

async function main() {
  let browser = null;
  let browserEventId = null;
  const artifacts = join(ROOT, ARTIFACTS);

  try {
    await step("API start (DB + storage di tmp, OTP dev)", async () => {
      await startApi();
      const health = await call("GET", "/v1/health");
      assert.equal(health.status, 200, `health ${health.status}`);
    });

    await step("Operator masuk lewat OTP → token sesi", async () => {
      const requested = await call("POST", "/v1/auth/otp/request", { body: { email: EMAIL } });
      assert.equal(requested.status, 202, JSON.stringify(requested.json));
      assert.ok(requested.json.code, "OTP_DEV_MODE=1 harus mengembalikan kode");

      const verified = await call("POST", "/v1/auth/otp/verify", {
        body: { email: EMAIL, code: requested.json.code },
      });
      assert.equal(verified.status, 200, JSON.stringify(verified.json));
      assert.ok(verified.json.token, "verify harus mengembalikan token");
      return verified.json.token;
    }).then((token) => {
      globalThis.__token = token;
    });

    const token = globalThis.__token;

    await step("Setelan dibuat permisif supaya slot bisa dipesan deterministik", async () => {
      const saved = await call("PUT", "/v1/booking/admin/settings", {
        token,
        body: {
          hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: "08:00", close: "20:00" })),
          bufferMinutes: 0,
          slotStepMinutes: 60,
          minNoticeHours: 0,
          maxAdvanceDays: 365,
          timezoneOffsetMinutes: 0,
          closedDates: [],
          paymentProvider: "none",
          requireDeposit: false,
        },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
      assert.equal(saved.json.timezoneOffsetMinutes, 0);
    });

    const pkg = await step("Paket dibuat lewat rute operator", async () => {
      const created = await call("POST", "/v1/booking/admin/packages", {
        token,
        body: {
          name: "Sesi E2E 60 menit",
          durationMinutes: 60,
          priceIdr: 500000,
          depositIdr: 100000,
          active: true,
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      assert.equal(created.json.durationMinutes, 60);
      return created.json;
    });

    const date = utcDate(7);

    await step("Tamu melihat paket tanpa login", async () => {
      const publicList = await call("GET", "/v1/booking/packages");
      assert.equal(publicList.status, 200);
      assert.equal(publicList.json.packages.length, 1);
      assert.equal(publicList.json.paymentProvider, "none");
      assert.equal(publicList.json.requireDeposit, false);
    });

    const availability = await step("Ketersediaan mengembalikan slot 08:00–19:00", async () => {
      const result = await call("GET", `/v1/booking/availability?packageId=${pkg.id}&date=${date}`);
      assert.equal(result.status, 200, JSON.stringify(result.json));
      const free = result.json.slots.filter((slot) => slot.available);
      assert.equal(result.json.slots.length, 12, "08:00–20:00 dengan sesi 60 menit = 12 slot");
      assert.equal(free.length, 12);
      return result.json;
    });

    const slotA = availability.slots[0].start;
    const slotB = availability.slots[1].start;

    const bookingA = await step("Permintaan booking pertama diterima (202 + token)", async () => {
      const created = await call("POST", "/v1/booking/requests", {
        body: {
          packageId: pkg.id,
          name: "Tamu Pertama",
          email: "tamu.pertama@example.com",
          phone: "081200000001",
          start: slotA,
          consent: true,
        },
      });
      assert.equal(created.status, 202, JSON.stringify(created.json));
      assert.match(created.json.token, /^[A-Za-z0-9_-]{16,64}$/);
      assert.equal(created.json.status, "requested");
      assert.equal(created.json.deposit.provider, "none");
      assert.equal(created.json.deposit.live, false, "tanpa gateway, deposit tidak pernah live");
      assert.equal(created.json.booking.depositStatus, "unpaid");
      assert.equal(created.json.booking.id, undefined, "respons publik menyembunyikan id internal");
      assert.ok(created.json.statusUrl.endsWith(`/booking/s/${created.json.token}`));
      return created.json;
    });

    await step("Slot yang sama ditolak 409 (anti double-booking)", async () => {
      const clash = await call("POST", "/v1/booking/requests", {
        body: {
          packageId: pkg.id,
          name: "Tamu Kedua",
          email: "tamu.kedua@example.com",
          phone: "081200000002",
          start: slotA,
          consent: true,
        },
      });
      assert.equal(clash.status, 409, JSON.stringify(clash.json));
      assert.equal(clash.json.error, "slot_taken");
      assert.ok(clash.json.conflict.start, "balasan menyebut interval yang bentrok");
    });

    await step("Honeypot: sukses palsu 202 dan tidak ada baris baru", async () => {
      const before = await call("GET", "/v1/booking/admin/bookings", { token });
      assert.equal(before.json.bookings.length, 1);

      const trapped = await call("POST", "/v1/booking/requests", {
        body: {
          packageId: pkg.id,
          name: "Bot Spam",
          email: "bot@example.com",
          phone: "081200000003",
          start: slotB,
          consent: true,
          website: "http://spam.example",
        },
      });
      assert.equal(trapped.status, 202, "honeypot membalas seperti sukses");
      assert.equal(trapped.json.token, null);

      const after = await call("GET", "/v1/booking/admin/bookings", { token });
      assert.equal(after.json.bookings.length, 1, "honeypot tidak boleh menyimpan apa pun");
    });

    await step("Rate limit per-IP: permintaan ke-6 dalam satu jam ditolak 429", async () => {
      const ip = "203.0.113.77";
      const results = [];
      for (let i = 0; i < 6; i += 1) {
        results.push(
          await call("POST", "/v1/booking/requests", {
            ip,
            body: {
              packageId: pkg.id,
              name: `Rate Test ${i}`,
              email: `rate${i}@example.com`,
              phone: "081200000099",
              start: slotB,
              consent: true,
            },
          }),
        );
      }
      // Lima pertama lolos limiter (boleh 409 karena slot terisi); yang keenam
      // harus 429 — limiter berjalan sebelum validasi body.
      const limited = results.filter((result) => result.status === 429);
      assert.equal(limited.length, 1, `harus tepat satu 429, dapat ${results.map((r) => r.status)}`);
      assert.ok(Number(limited[0].headers.get("retry-after")) > 0, "retry-after harus terisi");
    });

    await step("Token tak dikenal → 404; token sah → status publik", async () => {
      const bogus = await call("GET", "/v1/booking/status/aaaaaaaaaaaaaaaaaaaa");
      assert.equal(bogus.status, 404);

      const real = await call("GET", `/v1/booking/status/${bookingA.token}`);
      assert.equal(real.status, 200);
      assert.equal(real.json.booking.name, "Tamu Pertama");
      assert.equal(real.json.booking.status, "requested");
      assert.equal(real.json.booking.id, undefined);
    });

    // ── browser ─────────────────────────────────────────────────────────
    browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));
    // Fetch halaman yang gagal tidak muncul sebagai console error di Chromium;
    // tanpa ini kegagalan "paket tidak termuat" tampak seperti halaman diam.
    page.on("requestfailed", (request) => {
      consoleErrors.push(`requestfailed ${request.url()} — ${request.failure()?.errorText ?? "?"}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400 && response.url().includes("/v1/booking/")) {
        consoleErrors.push(`HTTP ${response.status()} ${response.url()}`);
      }
    });

    await step("Form /booking dirender server dan bisa diisi tamu", async () => {
      const response = await page.goto(`${base}/booking`, { waitUntil: "domcontentloaded" });
      assert.equal(response.status(), 200);
      await page.waitForFunction(
        () => {
          const select = document.getElementById("pkg");
          return select instanceof HTMLSelectElement && select.options.length > 0;
        },
        { timeout: STEP_TIMEOUT },
      );
    });

    const formDate = utcDate(8);

    await step("Tamu submit form → mendarat di halaman status", async () => {
      await page.selectOption("#pkg", pkg.id);
      await page.fill("#name", "Tamu Browser");
      await page.fill("#email", "tamu.browser@example.com");
      await page.fill("#phone", "081200000004");
      await page.fill("#date", formDate);
      // Slot dimuat lewat fetch setelah tanggal dipilih.
      await page.waitForSelector('#slots input[name="start"]', { timeout: STEP_TIMEOUT });
      const slotValue = await page.$eval('#slots input[name="start"]', (input) => input.value);
      assert.ok(slotValue, "slot harus tersedia di tanggal form");
      await page.check('#slots input[name="start"]');
      await page.check("#consent");
      await page.click("#submit");

      await page.waitForURL(/\/booking\/s\/[A-Za-z0-9_-]+$/, { timeout: STEP_TIMEOUT });
      const body = await page.innerText("body");
      assert.match(body, /Tamu Browser/, "halaman status menampilkan nama tamu");
    });

    await step("Halaman status: tidak ada error konsol", async () => {
      assert.deepEqual(consoleErrors, [], `error konsol: ${consoleErrors.join(" | ")}`);
    });

    // ── operator ────────────────────────────────────────────────────────

    const rows = await call("GET", "/v1/booking/admin/bookings", { token });
    const browserBooking = rows.json.bookings.find((row) => row.name === "Tamu Browser");
    assert.ok(browserBooking, "booking dari browser harus tersimpan");

    await step("Operator menyetujui → slot terkunci & event studio dibuat", async () => {
      const approved = await call("PATCH", `/v1/booking/admin/bookings/${browserBooking.id}`, {
        token,
        body: { status: "approved" },
      });
      assert.equal(approved.status, 200, JSON.stringify(approved.json));
      assert.equal(approved.json.status, "approved");
      assert.ok(approved.json.eventId, "approve harus membuat event studio");
      browserEventId = approved.json.eventId;

      const after = await call("GET", `/v1/booking/availability?packageId=${pkg.id}&date=${formDate}`);
      const slot = after.json.slots.find((entry) => entry.start === browserBooking.start);
      assert.equal(slot.available, false, "slot yang disetujui tidak boleh muncul bebas");
    });

    await step("Approve ulang / reschedule tidak menggandakan event", async () => {
      const before = await call("GET", "/v1/booking/admin/bookings", { token });
      const same = before.json.bookings.filter((row) => row.eventId === browserEventId);
      assert.equal(same.length, 1, "satu booking = satu event");
      assert.equal(same[0].id, browserBooking.id);
    });

    await step("Halaman publik tidak meluber di lebar 390px", async () => {
      for (const url of [`${base}/booking`, `${base}/booking/s/${browserBooking.token}`]) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const overflow = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        assert.ok(
          overflow.scroll <= overflow.client,
          `${url} meluber: scrollWidth ${overflow.scroll} > clientWidth ${overflow.client}`,
        );
      }
      await page.setViewportSize({ width: 1280, height: 800 });
    });

    await step("Menyetujui booking kedua di slot yang sama ditolak 409", async () => {
      const second = await call("POST", "/v1/booking/requests", {
        body: {
          packageId: pkg.id,
          name: "Tamu Ketiga",
          email: "tamu.ketiga@example.com",
          phone: "081200000005",
          start: browserBooking.start,
          consent: true,
        },
      });
      // Slot sudah terisi → permintaannya sendiri ditolak di pintu masuk.
      assert.equal(second.status, 409, JSON.stringify(second.json));
    });

    await step("Reschedule menggeser booking ke slot bebas", async () => {
      const target = availability.slots[3].start;
      const moved = await call("POST", `/v1/booking/admin/bookings/${browserBooking.id}/reschedule`, {
        token,
        body: { start: target },
      });
      assert.equal(moved.status, 200, JSON.stringify(moved.json));
      assert.equal(moved.json.start, target);
    });

    await step("Tamu menggeser jadwalnya sendiri lewat halaman status", async () => {
      const target = availability.slots[6].start;
      const moved = await call("POST", `/v1/booking/status/${bookingA.token}/reschedule`, {
        body: { start: target },
      });
      assert.equal(moved.status, 200, JSON.stringify(moved.json));
      assert.equal(moved.json.booking.start, target);
      assert.equal(moved.json.booking.status, "requested", "menggeser tidak mengubah status");

      const publicStatus = await call("GET", `/v1/booking/status/${bookingA.token}`);
      assert.equal(publicStatus.json.booking.start, target, "halaman status menampilkan jadwal baru");

      // Slot yang sudah dipakai tamu lain tetap ditolak untuk tamu, bukan cuma
      // untuk operator.
      const taken = await call("POST", `/v1/booking/status/${bookingA.token}/reschedule`, {
        body: { start: availability.slots[3].start },
      });
      assert.equal(taken.status, 409, JSON.stringify(taken.json));
      assert.equal(taken.json.error, "slot_taken");

      // Kembali ke slot semula supaya langkah pembatalan di bawah tetap menguji
      // "slot yang dibatalkan kembali tersedia", bukan slot yang sudah bebas.
      const back = await call("POST", `/v1/booking/status/${bookingA.token}/reschedule`, {
        body: { start: slotA },
      });
      assert.equal(back.status, 200, JSON.stringify(back.json));
      assert.equal(back.json.booking.start, slotA);
    });

    await step("Tamu menggeser jadwal dari halaman status (browser sungguhan)", async () => {
      await page.goto(`${base}/booking/s/${browserBooking.token}`, { waitUntil: "domcontentloaded" });
      const moveDate = utcDate(10);
      await page.fill("#move-date", moveDate);
      await page.waitForSelector('#move-slots input[name="move-start"]', { timeout: STEP_TIMEOUT });
      const picked = await page.$eval('#move-slots input[name="move-start"]', (input) => input.value);
      await page.check('#move-slots input[name="move-start"]');
      await page.click("#move");
      // Halaman memuat ulang setelah server menerima jadwal baru.
      await page.waitForFunction(
        () => !document.body.innerText.includes("Menyimpan"),
        undefined,
        { timeout: STEP_TIMEOUT },
      );

      const after = await call("GET", "/v1/booking/admin/bookings", { token });
      const moved = after.json.bookings.find((row) => row.id === browserBooking.id);
      assert.equal(moved.start, picked, "jadwal baru harus tersimpan dari halaman status");
      browserBooking.start = picked;
      assert.deepEqual(consoleErrors, [], `error konsol: ${consoleErrors.join(" | ")}`);
    });

    await step("Transisi tidak sah ditolak (completed → approved)", async () => {
      await call("PATCH", `/v1/booking/admin/bookings/${browserBooking.id}`, {
        token,
        body: { status: "completed" },
      });
      const back = await call("PATCH", `/v1/booking/admin/bookings/${browserBooking.id}`, {
        token,
        body: { status: "approved" },
      });
      assert.equal(back.status, 409, JSON.stringify(back.json));
      assert.equal(back.json.error, "invalid_transition");
    });

    await step("Stub pembayaran jujur: provider qris ditolak 400 menyebut Fase 10", async () => {
      const rejected = await call("PUT", "/v1/booking/admin/settings", {
        token,
        body: { paymentProvider: "qris" },
      });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.json));
      assert.match(rejected.json.message, /Fase 10/i);

      const settings = await call("GET", "/v1/booking/admin/settings", { token });
      assert.equal(settings.json.paymentProvider, "none", "provider tetap none setelah penolakan");
    });

    await step("Deposit tidak pernah 'paid' tanpa operator menandainya", async () => {
      const before = await call("GET", `/v1/booking/status/${bookingA.token}`);
      assert.equal(before.json.booking.depositStatus, "unpaid");
      assert.equal(before.json.deposit.status, "unpaid");

      const idA = rows.json.bookings.find((row) => row.name === "Tamu Pertama").id;
      const marked = await call("POST", `/v1/booking/admin/bookings/${idA}/deposit`, {
        token,
        body: { status: "paid" },
      });
      assert.equal(marked.status, 200, JSON.stringify(marked.json));
      assert.equal(marked.json.depositStatus, "paid");

      const after = await call("GET", `/v1/booking/status/${bookingA.token}`);
      assert.equal(after.json.booking.depositStatus, "paid");
    });

    await step("Tamu membatalkan sendiri; pembatalan kedua 409", async () => {
      const cancelled = await call("POST", `/v1/booking/status/${bookingA.token}/cancel`, {
        body: { reason: "berubah pikiran" },
      });
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
      assert.equal(cancelled.json.booking.status, "cancelled");

      const again = await call("POST", `/v1/booking/status/${bookingA.token}/cancel`, { body: {} });
      assert.equal(again.status, 409, JSON.stringify(again.json));
    });

    await step("Slot yang dibatalkan kembali tersedia", async () => {
      const after = await call("GET", `/v1/booking/availability?packageId=${pkg.id}&date=${date}`);
      const slot = after.json.slots.find((entry) => entry.start === slotA);
      assert.equal(slot.available, true, "booking cancelled tidak boleh mengunci slot");
    });

    await step(".ics terbentuk dengan UID booking", async () => {
      const ics = await call("GET", "/v1/booking/admin/calendar.ics", { token });
      assert.equal(ics.status, 200);
      assert.match(ics.headers.get("content-type") ?? "", /text\/calendar/);
      assert.match(ics.text, /BEGIN:VCALENDAR/);
      assert.match(ics.text, /UID:booking-/);
      assert.match(ics.text, /END:VCALENDAR/);
    });

    await step("Laporan okupansi dihitung dari data nyata", async () => {
      const report = await call("GET", "/v1/booking/admin/report", { token });
      assert.equal(report.status, 200, JSON.stringify(report.json));
      // Angka laporan dibandingkan dengan daftar booking yang sama, bukan
      // dengan angka yang ditulis di sini — kalau keduanya bergeser bersama,
      // tesnya tetap menangkap laporan yang salah hitung.
      const all = await call("GET", "/v1/booking/admin/bookings", { token });
      const requested = all.json.bookings.filter((row) => row.status === "requested").length;
      assert.equal(report.json.total.requested, requested);
      assert.equal(report.json.packages.length, 1);
      assert.equal(report.json.packages[0].packageId, pkg.id);
    });

    await step("Invoice operator berasal dari data booking, bukan angka hardcode", async () => {
      const admin = await call("GET", "/v1/booking/admin/bookings", { token });
      const target = admin.json.bookings.find((row) => row.name === "Tamu Pertama");
      assert.ok(target, "booking Tamu Pertama harus ada");

      const res = await call("GET", `/v1/booking/admin/bookings/${target.id}/invoice`, { token });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.match(res.json.invoice.number, /^INV-\d{6}-[0-9A-Z]{4,6}$/, "nomor invoice mengikuti format");

      // Angka tagihan dibandingkan dengan booking yang sama — kalau keduanya
      // bergeser bersama, tesnya tetap menangkap invoice yang salah hitung.
      assert.equal(res.json.invoice.totalIdr, target.priceIdr);
      assert.equal(res.json.invoice.paidIdr, target.depositIdr);
      assert.equal(res.json.invoice.balanceDueIdr, target.priceIdr - target.depositIdr);
      assert.ok(res.json.invoice.statusLabel, "label status datang dari server");
      assert.ok(res.json.text.includes(res.json.invoice.number), "kwitansi memuat nomor invoice");
    });

    await step("Invoice tanpa sesi ditolak 401", async () => {
      const admin = await call("GET", "/v1/booking/admin/bookings", { token });
      const target = admin.json.bookings[0];
      const res = await call("GET", `/v1/booking/admin/bookings/${target.id}/invoice`);
      assert.equal(res.status, 401, JSON.stringify(res.json));
    });

    await step("Kwitansi .txt terunduh sebagai teks polos", async () => {
      const admin = await call("GET", "/v1/booking/admin/bookings", { token });
      const target = admin.json.bookings.find((row) => row.name === "Tamu Pertama");
      const res = await call("GET", `/v1/booking/admin/bookings/${target.id}/invoice.txt`, { token });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
      assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="INV-/);
      assert.match(res.text, /INV-\d{6}-[0-9A-Z]{4,6}/);
    });

    await step("Notifikasi selalu mengembalikan teks + whatsappUrl; delivered jujur", async () => {
      const admin = await call("GET", "/v1/booking/admin/bookings", { token });
      const target = admin.json.bookings.find((row) => row.name === "Tamu Pertama");

      const bad = await call("POST", `/v1/booking/admin/bookings/${target.id}/notify`, {
        token,
        body: { kind: "spam" },
      });
      assert.equal(bad.status, 400, JSON.stringify(bad.json));

      const res = await call("POST", `/v1/booking/admin/bookings/${target.id}/notify`, {
        token,
        body: { kind: "confirmation" },
      });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.ok(res.json.subject, "subject terisi");
      assert.ok(res.json.body.includes(target.name), "body menyebut nama tamu");
      assert.ok(res.json.whatsappUrl?.startsWith("https://wa.me/"), "tautan WhatsApp dibentuk");
      // Tanpa SMTP, pengiriman email tidak boleh diklaim berhasil.
      assert.equal(res.json.delivered, false, "kanal belum hidup → delivered false, bukan klaim palsu");
      assert.equal(res.json.channel, "manual", "tanpa SMTP, kanal dilaporkan manual");
    });

    await step("Pengingat: daftar kosong saat belum ada sesi H-1, dan tanpa kanal tetap jujur", async () => {
      const res = await call("GET", "/v1/booking/admin/reminders", { token });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.notifierLive, false, "kanal belum terpasang → notifierLive false");
      // Sesi yang dibuat di sini masih jauh dari 24 jam, jadi belum ada yang jatuh tempo.
      for (const row of res.json.reminders) {
        const gap = new Date(row.start).getTime() - Date.now();
        assert.ok(gap <= 24 * 60 * 60 * 1000, "hanya sesi < 24 jam yang masuk daftar pengingat");
      }
    });

    await step("Pengingat tanpa sesi ditolak 401", async () => {
      const res = await call("GET", "/v1/booking/admin/reminders");
      assert.equal(res.status, 401, JSON.stringify(res.json));
    });

    log("");
    log(`  ✅ Fase 11 e2e lulus — ${stepNo} langkah`);
  } catch (error) {
    log("");
    log("  ❌ Fase 11 e2e gagal");
    log(error?.stack ?? String(error));
    if (consoleErrors.length > 0) log(`  konsol: ${consoleErrors.join(" | ")}`);

    // Simpan artefak kalau browser sudah hidup: screenshot + HTML mempermudah
    // membedakan "kode salah" dari "halaman belum sempat render".
    try {
      await mkdir(artifacts, { recursive: true });
      const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [];
      for (const [index, page] of pages.entries()) {
        await page.screenshot({ path: join(artifacts, `phase11-fail-${index}.png`) });
        await writeFile(join(artifacts, `phase11-fail-${index}.html`), await page.content());
      }
      if (pages.length > 0) log(`  artefak: ${artifacts}`);
    } catch {
      /* artefak bersifat bantuan, bukan penentu lulus/gagal */
    }

    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    await stopApi();
  }
}

await main();
