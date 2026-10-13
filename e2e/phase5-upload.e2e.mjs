#!/usr/bin/env node
/**
 * Harness e2e Fase 5 — "foto tidak pernah lewat API".
 *
 * Yang dibuktikan berkas ini, dan yang **tidak** bisa dibuktikan unit test:
 *
 *   1. Studio yang sudah dibuild, dijalankan di browser sungguhan, bisa
 *      melewati alur penuh: masuk → buat galeri → pilih galeri → jepret →
 *      terima → upload → tamu membuka `/a/:hash` → unduh ZIP.
 *   2. Byte foto benar-benar pergi **langsung ke bucket**: ada PUT ke host
 *      storage, dan **tidak ada** tulis ber-body gambar ke host API.
 *   3. Antrian tahan gagal jaringan: foto diambil saat offline tetap tersimpan,
 *      selamat dari refresh halaman, lalu terkirim sendiri saat jaringan balik.
 *
 * Kenapa browser sungguhan: dua janji di atas hidup di batas yang tidak ada di
 * Node — presigned URL, CORS, IndexedDB, service worker, dan urutan render.
 * `api.test.ts` sudah menguji sisi server lewat `app.inject`; di sini sisi
 * klien yang diuji.
 *
 * Pemakaian:
 *
 *   FB_E2E_BASE=http://127.0.0.1:5080 node e2e/phase5-upload.e2e.mjs
 *
 * Opsi lain: `FB_E2E_EMAIL`, `FB_E2E_HEADED=1`, `FB_E2E_SLOWMO=ms`,
 * `FB_E2E_ARTIFACTS=dir` (screenshot saat gagal).
 *
 * Prasyarat: API sudah jalan, `apps/studio/dist` sudah dibuild dari commit ini,
 * dan `OTP_DEV_MODE=1` supaya kode OTP bisa dibaca dari balasan `otp/request`.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const BASE = (process.env.FB_E2E_BASE ?? "http://127.0.0.1:5080").replace(/\/$/, "");
const STUDIO_URL = `${BASE}/studio/?fake=webcam`;
const EMAIL = process.env.FB_E2E_EMAIL ?? "e2e-operator@foto-booth.test";
const HEADED = process.env.FB_E2E_HEADED === "1";
const SLOWMO = Number(process.env.FB_E2E_SLOWMO ?? "0");
const ARTIFACTS = process.env.FB_E2E_ARTIFACTS ?? "e2e/artifacts";

/** Sesi 2 jepretan, tanpa hitungan mundur, jeda pendek — supaya tes cepat. */
const SESSION_CONFIG = { shotCount: 2, countdownMs: 0, intervalMs: 150, reviewMs: 0 };

const STEP_TIMEOUT = 20_000;

// ── alat bantu ──────────────────────────────────────────────────────────

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

/** Tunggu sampai `probe` mengembalikan nilai truthy; kalau tidak, lempar. */
async function waitFor(probe, { timeout = STEP_TIMEOUT, every = 100, what = "kondisi" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() > deadline) {
      throw new Error(`timeout ${timeout} ms menunggu: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

const text = (page, testId) => page.locator(`[data-testid="${testId}"]`).first().innerText();

const num = async (page, testId) => Number((await text(page, testId)).trim());

// ── skenario ────────────────────────────────────────────────────────────

/**
 * Catat semua request/response yang lewat — inti bukti "foto tidak lewat API".
 *
 * `bucketHost` baru diketahui setelah `upload-url` dijawab, jadi ia diisi
 * sambil jalan.
 */
function watchNetwork(page, state) {
  const entries = new Map();

  page.on("request", (request) => {
    const url = new URL(request.url());
    const contentType = request.headers()["content-type"] ?? "";
    const entry = {
      method: request.method(),
      host: url.host,
      path: url.pathname,
      contentType,
      bytes: request.postDataBuffer()?.length ?? 0,
    };
    entries.set(request, entry);
    state.requests.push(entry);
  });

  // Body berupa `Blob` membuat `postDataBuffer()` kosong di Chromium, jadi
  // ukuran sebenarnya diambil dari `sizes()` begitu request selesai.
  page.on("requestfinished", async (request) => {
    const entry = entries.get(request);
    if (!entry) return;
    try {
      const sizes = await request.sizes();
      if (sizes.requestBodySize > 0) entry.bytes = sizes.requestBodySize;
    } catch {
      // Request gagal/dibuang: biarkan angka sebelumnya.
    }
  });

  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith("/upload-url") && response.request().method() === "POST") {
      try {
        const body = await response.json();
        const signed = body?.uploadUrl ?? body?.thumbUploadUrl;
        if (typeof signed === "string") state.bucketHost = new URL(signed).host;
      } catch {
        // Balasan gagal di-parse: bukan urusan pencatat jaringan.
      }
    }
  });
}

async function signIn(page) {
  await page.locator('[data-testid="tab-gallery"]').click();
  await page.locator('[data-testid="gallery-email"]').waitFor();

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().endsWith("/v1/auth/otp/request") && res.request().method() === "POST",
    ),
    (async () => {
      await page.locator('[data-testid="gallery-email"]').fill(EMAIL);
      await page.locator('[data-testid="gallery-request-otp"]').click();
    })(),
  ]);

  assert.equal(response.status(), 202, "otp/request harus 202");

  const body = await response.json();
  const code = body?.code;
  assert.ok(
    typeof code === "string" && code.length > 0,
    "balasan otp/request tidak memuat `code` — API harus jalan dengan OTP_DEV_MODE=1",
  );

  await page.locator('[data-testid="gallery-code"]').waitFor();
  await page.locator('[data-testid="gallery-code"]').fill(code);
  await page.locator('[data-testid="gallery-verify"]').click();

  await waitFor(
    async () => (await page.locator('[data-testid="gallery-account"]').count()) > 0,
    { what: "panel galeri setelah login" },
  );
}

async function createGallery(page, { name, date, previousUrl }) {
  await page.locator('[data-testid="gallery-event-name"]').fill(name);
  await page.locator('[data-testid="gallery-event-date"]').fill(date);
  await page.locator('[data-testid="gallery-create"]').click();

  // Galeri pertama langsung aktif; untuk yang kedua, `gallery-active` sudah ada
  // sejak awal, jadi yang ditunggu adalah URL-nya benar-benar berganti.
  await waitFor(
    async () => {
      const active = await page.locator('[data-testid="gallery-active"]').count();
      if (active === 0) return false;
      const url = (await text(page, "gallery-qr-url")).trim();
      return url !== "" && url !== (previousUrl ?? "");
    },
    { what: "galeri aktif setelah dibuat" },
  );

  const guestUrl = (await text(page, "gallery-qr-url")).trim();
  assert.match(guestUrl, /\/a\/[A-Za-z0-9_-]+$/, `URL tamu tidak seperti /a/:hash — dapat ${guestUrl}`);

  // QR harus sudah dirender di perangkat (SVG), bukan diambil dari layanan luar.
  await waitFor(async () => (await page.locator('[data-testid="gallery-qr"] svg').count()) > 0, {
    what: "SVG QR dirender",
  });

  return guestUrl;
}

/** Jepret `shotCount` frame lewat transport palsu, lalu terima sesi. */
async function captureAndAccept(page) {
  await page.locator('[data-testid="tab-capture"]').click();
  await page.locator('[data-testid="capture-device"]').waitFor();

  // Device palsu muncul setelah `init()`; `?fake=webcam` menjamin ada satu.
  await waitFor(
    async () =>
      (await page.locator('[data-testid="capture-device"] option[value="fake-webcam"]').count()) > 0,
    { what: "perangkat palsu `fake-webcam` terdaftar" },
  );
  await page.locator('[data-testid="capture-device"]').selectOption("fake-webcam");

  await waitFor(
    async () => !(await page.locator('[data-testid="capture-arm"]').isDisabled()),
    { what: "tombol arm aktif setelah kamera tersambung" },
  );
  await page.locator('[data-testid="capture-arm"]').click();
  await page.locator('[data-testid="capture-begin"]').click();

  // Sesi selesai → tombol terima hidup.
  await waitFor(
    async () => !(await page.locator('[data-testid="capture-accept"]').isDisabled()),
    { what: "sesi selesai (tombol terima aktif)", timeout: 40_000 },
  );
  await page.locator('[data-testid="capture-accept"]').click();

  await waitFor(async () => (await page.locator('[data-testid="capture-saved-note"]').count()) > 0, {
    what: "catatan tersimpan muncul setelah terima",
  });
}

/** Tunggu seluruh antrian selesai terkirim. */
async function waitAllUploaded(page, expected) {
  await waitFor(
    async () => {
      const done = await num(page, "upload-done");
      const failed = await num(page, "upload-failed");
      assert.equal(failed, 0, "ada item yang masuk `failed` — seharusnya tidak");
      return done >= expected;
    },
    { what: `${expected} foto terunggah`, timeout: 60_000 },
  );
}

/**
 * Rekam setiap request ber-body yang dikirim **halaman**.
 *
 * Kenapa tidak cukup dari sisi Playwright: untuk body `Blob`, Chromium tidak
 * mengirim `content-length` dan Playwright melaporkan `requestBodySize: 0`
 * (body-nya streaming). Server tetap menerima seluruh byte — jadi ukuran harus
 * dibaca dari sisi pengirim, tempat `blob.size` masih tersedia.
 */
async function installNetRecorder(context) {
  await context.addInitScript(() => {
    const entries = [];
    Object.defineProperty(window, "__fbNet", { value: entries, configurable: true });

    const sizeOf = (body) => {
      if (body instanceof Blob) return body.size;
      if (body instanceof ArrayBuffer) return body.byteLength;
      if (ArrayBuffer.isView(body)) return body.byteLength;
      if (typeof body === "string") return new TextEncoder().encode(body).length;
      return 0;
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      try {
        const request = typeof input === "string" ? null : input;
        const url = new URL(
          typeof input === "string" ? input : (input?.url ?? String(input)),
          location.href,
        );
        const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
        const headers = new Headers(init?.headers ?? request?.headers);
        entries.push({
          via: "fetch",
          method,
          host: url.host,
          path: url.pathname,
          contentType: headers.get("content-type") ?? "",
          hasAuthHeader: headers.has("authorization"),
          bytes: sizeOf(init?.body),
        });
      } catch {
        // Pencatatan tidak boleh mengganggu permintaan aslinya.
      }
      return originalFetch(input, init);
    };
  });
}

async function readNet(page) {
  return page.evaluate(() => window.__fbNet ?? []);
}

/** Bukti inti: byte ke bucket, bukan ke API. */
async function assertBytesWentToBucket(net, state, apiHost, expectedPhotos) {
  assert.ok(state.bucketHost !== null, "tidak pernah melihat presigned URL dari `upload-url`");

  const puts = net.filter((e) => e.method === "PUT" && e.host === state.bucketHost && e.bytes > 0);
  const dump = () =>
    net
      .filter((e) => e.method !== "GET")
      .map((e) => `      ${e.method} ${e.host}${e.path} ct=${e.contentType || "-"} bytes=${e.bytes}`)
      .join("\n");

  assert.ok(
    puts.length > 0,
    `tidak ada PUT ber-byte ke bucket ${state.bucketHost} — foto tidak sampai ke storage\n` +
      `    request ber-body yang dikirim halaman:\n${dump()}`,
  );

  // Foto besar **dan** thumbnail harus sama-sama mendarat di bucket. Kalau
  // thumbnail tidak jadi terkirim, halaman tamu akan menunjuk objek yang tidak
  // ada (API membalas 502) — jadi ini bukan detail kosmetik.
  const thumbs = puts.filter((e) => e.path.includes("thumbs/"));
  assert.equal(
    thumbs.length,
    expectedPhotos,
    `PUT thumbnail ke bucket: ${thumbs.length}, seharusnya ${expectedPhotos}\n` +
      `    request ber-body yang dikirim halaman:\n${dump()}`,
  );

  const toApiWithImage = net.filter(
    (e) =>
      e.host === apiHost &&
      ["PUT", "POST", "PATCH"].includes(e.method) &&
      e.contentType.startsWith("image/"),
  );
  assert.deepEqual(
    toApiWithImage.map((e) => `${e.method} ${e.path}`),
    [],
    "ada byte gambar yang dikirim ke API — melanggar aturan inti Fase 5",
  );

  return {
    putToBucket: puts.length,
    thumbToBucket: thumbs.length,
    bytesToBucket: puts.reduce((sum, e) => sum + e.bytes, 0),
  };
}

async function verifyGuestGallery(context, guestUrl, expectedPhotos) {
  const guest = await context.newPage();
  const response = await guest.goto(guestUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 200, "halaman tamu harus 200");

  const html = await guest.content();
  assert.match(html, /Unduh semua/, "halaman tamu harus menawarkan unduhan ZIP");
  assert.match(html, /30 hari/, "halaman tamu harus menyebut TTL galeri");

  // Bukan sekadar ada tag <img>: setiap src harus benar-benar mengembalikan
  // byte gambar. Inilah bukti objeknya sungguh ada di bucket.
  const srcs = await guest.evaluate(() =>
    [...document.querySelectorAll("img")].map((img) => img.getAttribute("src")),
  );
  assert.ok(
    srcs.length >= expectedPhotos,
    `halaman tamu menampilkan ${srcs.length} gambar, seharusnya >= ${expectedPhotos}`,
  );

  let servedBytes = 0;
  for (const src of srcs.slice(0, expectedPhotos)) {
    const res = await context.request.get(new URL(src, guestUrl).href);
    assert.equal(res.status(), 200, `gambar tamu ${src} harus 200`);
    const body = await res.body();
    assert.ok(body.length > 0, `gambar tamu ${src} kosong`);
    assert.match(
      res.headers()["content-type"] ?? "",
      /image\//,
      `gambar tamu ${src} harus ber-content-type gambar`,
    );
    servedBytes += body.length;
  }

  // Thumbnail ada, tapi foto penuhnya juga harus bisa diambil — kalau hanya
  // thumbnail yang mendarat, unduhan resolusi penuh akan 502.
  const fullSrc = srcs[0]?.replace(/[?&]thumb=1/, "") ?? "";
  assert.notEqual(fullSrc, "", "tidak menemukan URL foto penuh");
  const full = await context.request.get(new URL(fullSrc, guestUrl).href);
  assert.equal(full.status(), 200, "foto resolusi penuh harus 200");
  assert.match(full.headers()["content-type"] ?? "", /image\//, "foto penuh harus bertipe gambar");
  assert.ok((await full.body()).length > 0, "foto penuh tidak boleh kosong");

  const zipResponse = await context.request.get(`${guestUrl}/zip`);
  assert.equal(zipResponse.status(), 200, "ZIP galeri harus 200");
  assert.match(
    zipResponse.headers()["content-type"] ?? "",
    /application\/zip/,
    "ZIP harus ber-content-type application/zip",
  );

  const zip = await zipResponse.body();
  assert.ok(zip.length > 0, "ZIP tidak boleh kosong");
  assert.equal(zip.subarray(0, 2).toString("latin1"), "PK", "isi ZIP harus diawali signature PK");
  assert.equal(countZipEntries(zip), expectedPhotos, `ZIP harus memuat ${expectedPhotos} berkas`);

  await guest.close();
  return { images: srcs.length, zipBytes: zip.length, servedBytes };
}

/** Hitung entri ZIP dari End Of Central Directory (cukup untuk arsip kecil). */
function countZipEntries(zip) {
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) return zip.readUInt16LE(i + 10);
  }
  throw new Error("tidak menemukan End Of Central Directory di dalam ZIP");
}

// ── program utama ───────────────────────────────────────────────────────

async function main() {
  const apiHost = new URL(BASE).host;
  log(`Harness e2e Fase 5 — studio ${STUDIO_URL}`);

  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });

  // Bahasa Inggris + sesi pendek, dipasang sebelum aplikasi jalan.
  await context.addInitScript(
    ([config]) => {
      localStorage.setItem("foto-booth:locale", "en");
      localStorage.setItem("foto-booth:config", JSON.stringify(config));
    },
    [SESSION_CONFIG],
  );

  await installNetRecorder(context);

  const page = await context.newPage();
  const state = { requests: [], bucketHost: null };
  watchNetwork(page, state);

  let failure = null;

  try {
    // ── skenario A: alur penuh saat jaringan sehat ──────────────────────
    log("\nSkenario A — alur penuh, jaringan sehat");

    await step("buka studio", async () => {
      const res = await page.goto(STUDIO_URL, { waitUntil: "domcontentloaded" });
      assert.equal(res.status(), 200, "studio harus 200");
      await page.locator('[data-testid="tabs"]').waitFor();
    });

    await step("login operator lewat OTP", () => signIn(page));

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    let guestUrl = await step("buat galeri + QR dirender di perangkat", () =>
      createGallery(page, { name: `E2E ${stamp}`, date: "2026-10-13" }),
    );

    await step("jepret 2 foto dengan transport palsu, lalu terima", () => captureAndAccept(page));

    await step("antrian selesai terkirim", () => waitAllUploaded(page, SESSION_CONFIG.shotCount));

    const evidence = await step("byte foto pergi ke bucket, bukan ke API", async () =>
      assertBytesWentToBucket(await readNet(page), state, apiHost, SESSION_CONFIG.shotCount),
    );
    log(
      `       PUT ke bucket: ${evidence.putToBucket} (foto ${evidence.putToBucket - evidence.thumbToBucket}, thumb ${evidence.thumbToBucket}; ${evidence.bytesToBucket} B), tulis gambar ke API: 0`,
    );

    await step("halaman tamu menampilkan foto + unduh ZIP", async () => {
      const guest = await verifyGuestGallery(context, guestUrl, SESSION_CONFIG.shotCount);
      log(
        `       gambar: ${guest.images} (${guest.servedBytes} B disajikan), ZIP: ${guest.zipBytes} B`,
      );
    });

    // ── skenario B: antrian tahan gagal jaringan & refresh ──────────────
    log("\nSkenario B — antrian tahan offline dan refresh");

    await step("siapkan galeri kedua", async () => {
      await page.locator('[data-testid="tab-gallery"]').click();
      guestUrl = await createGallery(page, {
        name: `E2E offline ${stamp}`,
        date: "2026-10-13",
        previousUrl: guestUrl,
      });
    });

    // Antrian menampilkan **semua** item di perangkat, bukan cuma galeri aktif
    // (`refresh` memakai `store.allItems()`). Jadi baseline-nya dicatat dulu:
    // yang dibuktikan adalah "tidak ada yang BARU terkirim saat offline".
    let doneBaseline = 0;

    await step("jepret saat offline → foto ditahan lokal", async () => {
      await page.locator('[data-testid="tab-capture"]').click();
      doneBaseline = await num(page, "upload-done");

      await context.setOffline(true);
      await captureAndAccept(page);

      await waitFor(
        async () => {
          const pending = await num(page, "upload-pending");
          const done = await num(page, "upload-done");
          assert.equal(done, doneBaseline, "tidak boleh ada yang terkirim saat offline");
          return pending >= SESSION_CONFIG.shotCount;
        },
        { what: "foto tertahan di antrian saat offline", timeout: 30_000 },
      );
      log(`       tertahan: ${await num(page, "upload-pending")} item, terkirim: ${doneBaseline}`);
    });

    await step("jaringan balik + refresh → antrian tetap ada dan terkirim sendiri", async () => {
      await context.setOffline(false);
      await page.reload({ waitUntil: "domcontentloaded" });

      // Tanpa klik apa pun: antrian dimuat dari IndexedDB, auto-sync jalan.
      await page.locator('[data-testid="tab-capture"]').click();
      await waitFor(
        async () => (await num(page, "upload-done")) >= doneBaseline + SESSION_CONFIG.shotCount,
        { what: "antrian pulih sendiri setelah refresh", timeout: 60_000 },
      );
      assert.equal(await num(page, "upload-failed"), 0, "tidak boleh ada item yang menyerah");

      // Foto yang sempat ditahan harus lewat jalur yang sama: PUT ke bucket.
      const net = await readNet(page);
      const puts = net.filter((e) => e.method === "PUT" && e.host === state.bucketHost && e.bytes > 0);
      assert.ok(
        puts.length >= SESSION_CONFIG.shotCount,
        `hanya ${puts.length} PUT ber-byte ke bucket setelah antrian pulih`,
      );
      const thumbs = puts.filter((e) => e.path.includes("thumbs/"));
      assert.ok(
        thumbs.length >= SESSION_CONFIG.shotCount,
        `hanya ${thumbs.length} PUT thumbnail setelah antrian pulih — halaman tamu akan pecah`,
      );
      const toApiWithImage = net.filter(
        (e) =>
          e.host === apiHost &&
          ["PUT", "POST", "PATCH"].includes(e.method) &&
          e.contentType.startsWith("image/"),
      );
      assert.deepEqual(toApiWithImage, [], "byte gambar sempat dikirim ke API saat pulih");
      log(`       PUT ke bucket setelah pulih: ${puts.length} (thumb ${thumbs.length})`);
    });

    await step("foto yang diambil offline akhirnya tampil di halaman tamu", async () => {
      const guest = await verifyGuestGallery(context, guestUrl, SESSION_CONFIG.shotCount);
      log(`       gambar: ${guest.images} (${guest.servedBytes} B disajikan), ZIP: ${guest.zipBytes} B`);
    });

    log("\nSEMUA SKENARIO LULUS");
  } catch (error) {
    failure = error;
    log(`\nGAGAL: ${error instanceof Error ? error.message : String(error)}`);

    try {
      await mkdir(ARTIFACTS, { recursive: true });
      const shot = path.join(ARTIFACTS, `gagal-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      log(`screenshot: ${shot}`);

      const html = await page.content();
      await writeFile(path.join(ARTIFACTS, "gagal.html"), html, "utf8");

      const dump = state.requests.map((r) => `${r.method} ${r.host}${r.path} (${r.bytes} B)`);
      await writeFile(path.join(ARTIFACTS, "requests.txt"), dump.join("\n"), "utf8");
    } catch (artefactError) {
      log(`gagal menyimpan artefak: ${String(artefactError)}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  if (failure !== null) process.exit(1);
}

await main();
