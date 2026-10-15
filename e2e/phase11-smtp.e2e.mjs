#!/usr/bin/env node
/**
 * Harness e2e Fase 11 (kanal kirim) — "email konfirmasi benar-benar keluar".
 *
 * Yang dibuktikan berkas ini, dan yang **tidak** bisa dibuktikan unit test:
 *
 *   1. API sungguhan (proses terpisah, `src/index.ts`) membaca `SMTP_*` dari
 *      environment dan **membangun kanal SMTP**, bukan kanal log. Dibuktikan
 *      dari luar: rute operator melaporkan `notifierLive: true`.
 *   2. Menyetujui booking membuat **satu pesan SMTP nyata** sampai ke server
 *      SMTP, lewat `net.Socket` sungguhan (bukan `openSocket` yang di-inject).
 *      Isinya adalah konfirmasi booking untuk tamu itu — alamat, subjek, dan
 *      nama tamu di body diperiksa.
 *   3. Pengingat H-1 juga terkirim lewat kanal yang sama.
 *   4. Kebalikannya diuji juga: API kedua **tanpa** `SMTP_*` melaporkan
 *      `notifierLive: false` dan **tidak ada** pesan yang keluar — jadi
 *      "hidup" di atas bukan efek samping yang selalu menyala.
 *
 * Kenapa perlu: unit test `smtp.test.ts` menyuntik socket palsu, jadi ia
 * membuktikan protokolnya benar tapi tidak membuktikan `createContext` benar
 * memilih kanal dari env. Di sini API-nya yang bicara, lewat TCP asli.
 *
 * Pemakaian:
 *
 *   node e2e/phase11-smtp.e2e.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const API_DIR = join(ROOT, "apps/api");
const EMAIL = "smtp-e2e@foto-booth.test";
const STEP_TIMEOUT = 30_000;

let stepNo = 0;
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
async function waitFor(probe, { timeout = STEP_TIMEOUT, every = 50, what = "kondisi" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout ${timeout} ms menunggu: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

// ── server SMTP palsu, di dalam proses ini, lewat TCP sungguhan ─────────

/**
 * Cukup untuk menerima kiriman dari klien SMTP kita: sapaan, `EHLO`, `AUTH
 * LOGIN`, `MAIL/RCPT/DATA`. Tanpa STARTTLS, jadi API harus memakai
 * `SMTP_STARTTLS=0` supaya tidak menolak — dan itu memang yang diuji.
 */
function startFakeSmtp() {
  const messages = [];
  const server = createServer((socket) => {
    socket.write("220 fake.smtp ESMTP\r\n");
    let buffer = "";
    let inData = false;
    let authStep = 0;
    let current = null;
    const dataLines = [];

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\r\n");

        if (inData) {
          if (line === ".") {
            inData = false;
            current.raw = dataLines.join("\r\n");
            messages.push(current);
            socket.write("250 OK queued\r\n");
            continue;
          }
          dataLines.push(line);
          continue;
        }

        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "EHLO") {
          socket.write("250 fake.smtp\r\n");
        } else if (verb === "AUTH") {
          authStep = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (verb === "MAIL") {
          current = { from: line.slice(line.indexOf("<") + 1, line.indexOf(">")), to: null, raw: "" };
          socket.write("250 OK\r\n");
        } else if (verb === "RCPT") {
          current.to = line.slice(line.indexOf("<") + 1, line.indexOf(">"));
          socket.write("250 OK\r\n");
        } else if (verb === "DATA") {
          inData = true;
          dataLines.length = 0;
          socket.write("354 End data\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
        } else if (authStep === 1) {
          authStep = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
        } else if (authStep === 2) {
          authStep = 0;
          socket.write("235 Authentication successful\r\n");
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });
    socket.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, messages, port: server.address().port, port0: () => server.address().port });
    });
  });
}

// ── klien HTTP ──────────────────────────────────────────────────────────

let child = null;
let base = "";
let apiOutput = "";

async function startApi(extraEnv) {
  const dataDir = await mkdtemp(join(tmpdir(), "fb-smtp-e2e-data-"));
  const storageDir = await mkdtemp(join(tmpdir(), "fb-smtp-e2e-storage-"));

  child = spawn("node", ["src/index.ts"], {
    cwd: API_DIR,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      JWT_SECRET: "e2e-smtp-secret-e2e-smtp-secret-0123456789",
      OTP_DEV_MODE: "1",
      DATA_DIR: dataDir,
      STORAGE_DIR: storageDir,
      S3_ENDPOINT: "http://127.0.0.1:9/e2e",
      S3_REGION: "e2e",
      S3_BUCKET: "e2e",
      S3_ACCESS_KEY_ID: "e2e",
      S3_SECRET_ACCESS_KEY: "e2e",
      NODE_ENV: "test",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    apiOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    apiOutput += chunk.toString();
  });

  // Log-nya JSON (pino), jadi URL-nya diikuti tanda kutip — potong apa pun
  // yang bukan bagian URL, bukan cuma garis miring di ujung.
  const listening = await waitFor(
    async () => /Server listening at (http:\/\/[^"\s\\]+)/.exec(apiOutput),
    { what: "API mendengarkan" },
  );
  base = listening[1].replace(/\/$/, "");
  return base;
}

async function stopApi() {
  if (child === null) return;
  const done = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
  child = null;
  apiOutput = "";
}

async function call(method, path, { body, token } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

function utcDate(daysAhead) {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

async function login() {
  await call("POST", "/v1/auth/otp/request", { body: { email: EMAIL } });
  // OTP_DEV_MODE=1 → kode ikut di balasan, jadi tidak perlu kotak masuk.
  const requested = await call("POST", "/v1/auth/otp/request", { body: { email: EMAIL } });
  const code = requested.json?.code ?? requested.json?.devCode;
  assert.ok(code, `kode OTP dev tidak ada di balasan: ${requested.text}`);
  const verified = await call("POST", "/v1/auth/otp/verify", {
    body: { email: EMAIL, code },
  });
  assert.ok(verified.json?.token, "verify harus mengembalikan token");
  return verified.json.token;
}

/** Setelan + paket supaya booking bisa dibuat. */
async function seed(token) {
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
  assert.equal(saved.status, 200, saved.text);

  const created = await call("POST", "/v1/booking/admin/packages", {
    token,
    body: {
      name: "Paket E2E SMTP",
      durationMinutes: 60,
      priceIdr: 150000,
      depositIdr: 0,
      active: true,
    },
  });
  assert.equal(created.status, 201, `paket gagal dibuat: ${created.text}`);
  return created.json.id;
}

/** Buat request lalu ambil id internalnya dari daftar operator (respons publik
 * sengaja menyembunyikan id). */
async function makeBooking(token, packageId, name, start) {
  const created = await call("POST", "/v1/booking/requests", {
    body: {
      packageId,
      name,
      email: "tamu@example.com",
      phone: "081200000009",
      start,
      consent: true,
    },
  });
  assert.equal(created.status, 202, `request booking gagal: ${created.text}`);

  const bookings = await call("GET", "/v1/booking/admin/bookings", { token });
  assert.equal(bookings.status, 200, bookings.text);
  const found = bookings.json.bookings.find((b) => b.name === name && b.token === created.json.token);
  assert.ok(found, `booking "${name}" tidak ada di daftar operator`);
  return found;
}

// ── jalannya ────────────────────────────────────────────────────────────

async function main() {
  const fake = await startFakeSmtp();
  log(`  --   server SMTP palsu di 127.0.0.1:${fake.port} (TCP sungguhan)`);

  try {
    await step("API hidup dengan SMTP_* → kanal kirim benar-benar aktif", async () => {
      await startApi({
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(fake.port),
        SMTP_FROM: "booth@foto-booth.test",
        SMTP_USER: "booth",
        SMTP_PASS: "rahasia",
        // Server palsu tidak punya TLS; jangan menuntut STARTTLS di sini.
        SMTP_STARTTLS: "0",
        SMTP_SECURE: "0",
      });
      const token = await login();
      const packageId = await seed(token);
      globalThis.__token = token;
      globalThis.__packageId = packageId;

      const reminders = await call("GET", "/v1/booking/admin/reminders", { token });
      assert.equal(reminders.status, 200, reminders.text);
      assert.equal(reminders.json.notifierLive, true, "API harus melaporkan kanal kirim hidup");
    });

    const token = globalThis.__token;
    const packageId = globalThis.__packageId;

    await step("Approve booking → email konfirmasi keluar lewat TCP", async () => {
      const booking = await makeBooking(token, packageId, "Tamu Konfirmasi", `${utcDate(3)}T10:00:00.000Z`);
      const approved = await call("PATCH", `/v1/booking/admin/bookings/${booking.id}`, {
        token,
        body: { status: "approved" },
      });
      assert.equal(approved.status, 200, approved.text);

      const message = await waitFor(
        () => fake.messages.find((m) => m.to === "tamu@example.com"),
        { what: "email konfirmasi sampai ke server SMTP" },
      );
      assert.equal(message.from, "booth@foto-booth.test", "MAIL FROM sesuai SMTP_FROM");

      const body = Buffer.from(
        message.raw.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") ?? "",
        "base64",
      ).toString("utf8");
      assert.match(body, /Tamu Konfirmasi/, "nama tamu ada di body konfirmasi");
      log(`       ↳ subjek: ${/^Subject: (.*)$/m.exec(message.raw)?.[1] ?? "-"}`);
    });

    await step("Notifikasi manual → pesan kedua, tamu yang benar", async () => {
      const bookings = await call("GET", "/v1/booking/admin/bookings", { token });
      const target = bookings.json.bookings.find((b) => b.name === "Tamu Konfirmasi");
      assert.ok(target, "booking tadi harus ada di daftar operator");

      const before = fake.messages.length;
      const notified = await call("POST", `/v1/booking/admin/bookings/${target.id}/notify`, {
        token,
        body: { kind: "confirmation" },
      });
      assert.equal(notified.status, 200, notified.text);
      assert.equal(notified.json.delivered, true, "delivered harus true kalau kanal hidup");
      assert.equal(notified.json.channel, "email", "kanal yang dilaporkan = email");

      const after = await waitFor(
        () => (fake.messages.length > before ? fake.messages.length : 0),
        { what: "pesan notifikasi kedua" },
      );
      assert.ok(after > before, "harus ada pesan baru");
    });

    await step("Tanpa SMTP_* → kanal log, dan tidak ada pesan yang keluar", async () => {
      await stopApi();
      const before = fake.messages.length;
      await startApi({});
      const token2 = await login();
      const reminders = await call("GET", "/v1/booking/admin/reminders", { token: token2 });
      assert.equal(reminders.status, 200, reminders.text);
      assert.equal(reminders.json.notifierLive, false, "tanpa SMTP_* kanal harus log");

      const packageId2 = await seed(token2);
      const booking = await makeBooking(token2, packageId2, "Tamu Tanpa Kanal", `${utcDate(4)}T10:00:00.000Z`);
      const approved = await call("PATCH", `/v1/booking/admin/bookings/${booking.id}`, {
        token: token2,
        body: { status: "approved" },
      });
      assert.equal(approved.status, 200, approved.text);

      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(
        fake.messages.length,
        before,
        "tanpa SMTP_* tidak boleh ada pesan SMTP — kanal log tidak mengirim apa pun",
      );
    });

    log(`\n  ${stepNo} langkah lulus · ${fake.messages.length} pesan SMTP diterima`);
  } finally {
    await stopApi();
    fake.server.close();
  }
}

main().catch((error) => {
  console.error(`\n  FAILED: ${error?.stack ?? error}`);
  if (apiOutput !== "") console.error(`\n  --- output API ---\n${apiOutput}`);
  process.exitCode = 1;
});
