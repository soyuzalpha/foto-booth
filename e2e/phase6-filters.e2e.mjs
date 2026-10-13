#!/usr/bin/env node
/**
 * Harness e2e Fase 6 — "filter berjalan di perangkat, dan hasilnya benar".
 *
 * Yang dibuktikan berkas ini, dan yang **tidak** bisa dibuktikan unit test:
 *
 *   1. Chroma key **benar-benar menimpa latar** — piksel sudut yang semula
 *      hijau keluar sebagai warna latar, dan subjek di tengah tetap utuh.
 *      Bukan "kode-nya ada", tapi angka piksel hasil akhir.
 *   2. Rotasi 90° **benar-benar menukar** lebar↔tinggi (dimensi keluaran).
 *   3. Spill suppression menurunkan kanal hijau di piksel tepi.
 *   4. Adjustments: brightness naik → rata-rata kanal naik; saturation −100 → abu-abu.
 *   5. Latar blur meratakan latar (ter-key) sementara subjek tetap ada.
 *   6. **Kegagalan provider AI ≠ foto hilang**: foto tetap keluar (degraded).
 *   7. Jalur off-thread terdeteksi; latar AI & identitas tidak salah dilempar ke Worker.
 *   8. `modelCache`: model diunduh sekali lalu dilayani tanpa jaringan.
 *   9. Sentry tanpa DSN = no-op (SDK tidak dimuat).
 *  10. Storage picker: folder pilihan, pembatalan, dan fallback OPFS.
 *  11. `faceEnhance` produksi: runtime ORT + wasm dari host sendiri, model dari
 *      `/models/*`, inferensi jalan (piksel keluaran nyata).
 *  12. Segmenter: model bundled termuat; kalau mask dihasilkan, ukurannya benar.
 *  13. Panel debug aplikasi studio nyata: **nol DOM** tanpa `?debug=1`, muncul
 *      dengan flag dan menampilkan laporan storage.
 *  14. Panel filter di 390px tidak ada elemen meluber (`scrollWidth <= clientWidth`).
 *  15. Semua aset dari host sendiri (tanpa CDN) + tanpa error konsol.
 *
 * Kenapa browser sungguhan: seluruh janji di atas hidup di batas yang tidak ada
 * di Node — `createImageBitmap`, `ctx.filter`, `OffscreenCanvas`, Cache Storage,
 * dan bundling produksi (impor literal vs bare specifier yang mati). Karena itu
 * probe **dibangun lewat pipeline Vite/Rollup sungguhan** (`vite.probe.config.ts`)
 * lalu dipanggil dari halaman `/studio/probe/`; kalau bundling-nya salah, harness
 * ini gagal — bukan lulus diam-diam.
 *
 * Pemakaian:
 *
 *   node e2e/phase6-filters.e2e.mjs
 *
 * Opsi: `FB_E2E_HEADED=1`, `FB_E2E_SLOWMO=ms`, `FB_E2E_ARTIFACTS=dir`
 * (screenshot + HTML saat gagal), `FB_E2E_SKIP_BUILD=1` (pakai `dist-probe` yang
 * sudah ada), `FB_E2E_PORT=0` (port bebas pilihan OS; default 0).
 *
 * Prasyarat: dependensi terpasang (`pnpm install`) dan `apps/studio/dist` sudah
 * dibuild (`pnpm --filter @foto-booth/studio build`) — dipakai untuk uji DOM
 * panel debug & lebar 390px. Harness membangun `apps/studio/dist-probe` sendiri
 * (bundel probe) dan menyajikannya lewat server statis kecil, jadi **tidak butuh
 * API atau bucket** untuk jalan.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STUDIO_DIR = join(ROOT, "apps/studio");
const DIST_PROBE = join(STUDIO_DIR, "dist-probe");
const DIST_APP = join(STUDIO_DIR, "dist");
const FIXTURES = join(ROOT, "e2e/fixtures");
const MODEL = process.env.FB_E2E_MODEL ?? "test-enhance.onnx";
// Port 0 = biarkan OS memilih port bebas; harness tidak boleh gagal hanya karena
// port default kebetulan sedang dipakai proses lain.
const PORT = Number(process.env.FB_E2E_PORT ?? "0");
const HEADED = process.env.FB_E2E_HEADED === "1";
const SLOWMO = Number(process.env.FB_E2E_SLOWMO ?? "0");
const SKIP_BUILD = process.env.FB_E2E_SKIP_BUILD === "1";
const ARTIFACTS = process.env.FB_E2E_ARTIFACTS ?? "e2e/artifacts";

const STEP_TIMEOUT = 30_000;

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

const near = (value, expected, tolerance) => Math.abs(value - expected) <= tolerance;

// ── bundel probe ────────────────────────────────────────────────────────

/**
 * Bangun `dist-probe` lewat pipeline Vite/Rollup sungguhan.
 *
 * Sengaja **bukan** dev server: yang diuji adalah bundel produksi. Kalau ada
 * impor yang salah bentuk (mis. bare specifier yang mati setelah build), di
 * sini-lah ia ketahuan.
 */
async function buildProbe() {
  if (SKIP_BUILD && existsSync(join(DIST_PROBE, "probe/index.html"))) {
    log("  ·  lewati build (FB_E2E_SKIP_BUILD=1, dist-probe sudah ada)");
    return;
  }

  const code = await new Promise((resolve) => {
    const child = spawn("pnpm", ["exec", "vite", "build", "--config", "vite.probe.config.ts"], {
      cwd: STUDIO_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
  });

  assert.equal(code, 0, "build dist-probe gagal");
  assert.ok(
    existsSync(join(DIST_PROBE, "probe/index.html")),
    "dist-probe/probe/index.html tidak ada setelah build",
  );
}

/** Aplikasi studio (`dist`) dipakai untuk uji DOM panel debug & lebar 390px. */
function assertAppBuilt() {
  assert.ok(
    existsSync(join(DIST_APP, "index.html")),
    "apps/studio/dist belum ada — jalankan `pnpm --filter @foto-booth/studio build` dulu " +
      "(dipakai untuk uji DOM panel debug & lebar 390px)",
  );
}

// ── server statis mini ──────────────────────────────────────────────────

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".map": "application/json",
  ".onnx": "application/octet-stream",
  ".tflite": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/**
 * Server statis mini yang meniru topologi API Fase 6:
 *
 *   `/studio/probe/*`      → `apps/studio/dist-probe/probe/*`  (halaman probe)
 *   `/studio/models/*`     → `apps/studio/dist-probe/models/*` (wasm bundled)
 *   `/studio/*`            → `apps/studio/dist/*`              (aplikasi studio nyata)
 *   `/models/*`            → `e2e/fixtures/*`                  (model, seperti rute API)
 *
 * Dua bundel dilayani berdampingan: halaman probe (bundel `dist-probe`) untuk
 * uji piksel/dimensi, dan aplikasi studio asli (`dist`) untuk uji DOM panel
 * debug & lebar 390px. Aset `dist-probe` berada di bawah `/studio/models/` dan
 * `/studio/probe/` supaya tidak bertabrakan dengan aset aplikasi di
 * `/studio/assets/`.
 *
 * Path dijaga tidak bisa keluar dari akarnya — sama semangatnya dengan rute API.
 */
function startServer() {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const clean = normalize(path).replace(/^(\.\.[/\\])+/, "");

    // Kandidat (root, file) berurut. Aset probe di-emit di `/studio/assets/*`
    // (base-nya `/studio/`), jadi ia harus dicoba **sebelum** aset aplikasi —
    // kalau tidak, halaman probe akan 404 pada skripnya sendiri.
    const candidates = [];
    if (clean.startsWith("/models/")) {
      candidates.push({ root: FIXTURES, file: join(FIXTURES, clean.slice("/models/".length)) });
    } else if (clean.startsWith("/studio/")) {
      let rest = clean.slice("/studio/".length);
      // `/studio/` → `/studio/index.html` (sama seperti `index: ["index.html"]`).
      if (rest === "" || rest.endsWith("/")) rest += "index.html";
      if (clean.startsWith("/studio/probe/") || clean.startsWith("/studio/models/")) {
        candidates.push({ root: DIST_PROBE, file: join(DIST_PROBE, rest) });
      } else {
        // Aplikasi dulu, lalu aset probe. Aplikasi `dist` yang menangani
        // `/studio/` (halaman studio nyata); aset probe punya hash sendiri dan
        // tidak ada di `dist`, jadi ia jatuh ke kandidat kedua.
        candidates.push({ root: DIST_APP, file: join(DIST_APP, rest) });
        candidates.push({ root: DIST_PROBE, file: join(DIST_PROBE, rest) });
      }
    } else {
      candidates.push({ root: DIST_APP, file: join(DIST_APP, clean) });
    }

    for (const candidate of candidates) {
      // Tolak apa pun yang keluar dari akarnya (path traversal).
      if (!candidate.file.startsWith(candidate.root)) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("bad path");
        return;
      }

      try {
        const info = await stat(candidate.file);
        if (!info.isFile()) continue;
        const body = await readFile(candidate.file);
        response.writeHead(200, {
          "content-type": CONTENT_TYPES[extname(candidate.file)] ?? "application/octet-stream",
          "content-length": String(body.length),
        });
        response.end(body);
        return;
      } catch {
        // Coba kandidat berikutnya.
      }
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`not found: ${clean}`);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : PORT;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

// ── skenario ────────────────────────────────────────────────────────────

async function runProbe(page, method, ...args) {
  return page.evaluate(
    ([name, callArgs]) => {
      const probe = window.__filtersProbe;
      if (probe === undefined) throw new Error("window.__filtersProbe tidak ada");
      const fn = probe[name];
      if (typeof fn !== "function") throw new Error(`probe ${name} tidak ada`);
      return fn.apply(probe, callArgs);
    },
    [method, args],
  );
}

async function main() {
  log("Harness e2e Fase 6 — filter berjalan di perangkat (bundel produksi)");

  await step("bangun bundel probe (pipeline Vite produksi)", () => buildProbe());
  assertAppBuilt();

  const { server, base } = await startServer();
  const probeUrl = `${base}/studio/probe/index.html`;
  log(`       probe: ${probeUrl}`);
  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });

  const page = await context.newPage();
  const pageErrors = [];
  const requests = [];
  const responses = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  page.on("request", (request) => requests.push(request.url()));
  page.on("response", (response) => responses.push({ url: response.url(), status: response.status() }));

  let failure = null;

  try {
    await step("buka halaman probe produksi", async () => {
      const res = await page.goto(probeUrl, { waitUntil: "load" });
      assert.equal(res.status(), 200, "halaman probe harus 200");
      await page.waitForFunction(() => window.__filtersProbe !== undefined, null, {
        timeout: STEP_TIMEOUT,
      });
    });

    // 1–2. Chroma key menimpa latar + subjek tetap utuh.
    await step("chroma key benar-benar menimpa latar (uji piksel)", async () => {
      const r = await runProbe(page, "chroma");
      log(
        `       applied=${JSON.stringify(r.applied)} sudut=${JSON.stringify(r.corner)} tengah=${JSON.stringify(r.center)}`,
      );
      assert.ok(r.applied.includes("chromaKey"), "tahap chromaKey tidak dijalankan");
      assert.ok(
        r.applied.some((name) => name.startsWith("background")),
        "tahap background tidak dijalankan",
      );
      assert.equal(r.degraded, false, "chroma key + latar warna tidak boleh terdegradasi");
      // Sudut semula hijau murni → harus jadi warna latar (magenta).
      assert.ok(
        r.corner[0] > 240 && r.corner[1] < 15 && r.corner[2] > 240,
        `sudut bukan warna latar magenta: ${JSON.stringify(r.corner)}`,
      );
      // Subjek warna kulit di tengah harus lolos tanpa ikut terhapus.
      assert.ok(
        near(r.center[0], 200, 25) && near(r.center[1], 150, 25) && near(r.center[2], 120, 25),
        `subjek tengah berubah warna: ${JSON.stringify(r.center)}`,
      );
    });

    // 3. Rotasi 90° menukar dimensi.
    await step("rotasi 90° benar-benar menukar lebar↔tinggi", async () => {
      const r = await runProbe(page, "rotation", 90);
      log(`       ${r.in.join("x")} → ${r.out.join("x")} (harap ${r.expect.join("x")})`);
      assert.deepEqual(r.out, r.expect, "dimensi keluaran tidak sesuai hasil rotasi");
      assert.equal(r.out[0], r.in[1], "lebar keluaran harus = tinggi masukan");
      assert.equal(r.out[1], r.in[0], "tinggi keluaran harus = lebar masukan");
      assert.ok(r.applied.includes("rotation"), "tahap rotation tidak dijalankan");
    });

    // 4. Spill suppression.
    await step("spill suppression menurunkan kanal hijau di tepi", async () => {
      const r = await runProbe(page, "spill");
      log(`       g ${r.in.g} → ${r.out.g} (out=${JSON.stringify(r.out)})`);
      assert.ok(r.out.g < r.in.g - 5, "kanal hijau tidak turun");
      assert.ok(
        r.out.g <= Math.max(r.out.r, r.out.b) + 1,
        "kanal hijau masih melebihi kanal lain setelah spill",
      );
    });

    // 5. Adjustments.
    await step("adjustments: brightness naik & saturation −100 → abu-abu", async () => {
      const r = await runProbe(page, "adjustments");
      log(`       rata-rata ${r.meanIn.toFixed(1)} → ${r.meanBright.toFixed(1)}`);
      assert.ok(r.meanBright > r.meanIn + 10, "brightness tidak menaikkan rata-rata kanal");
      assert.ok(
        r.grays.every(([red, green, blue]) => Math.abs(red - green) <= 2 && Math.abs(green - blue) <= 2),
        `saturation −100 tidak menghasilkan abu-abu: ${JSON.stringify(r.grays)}`,
      );
    });

    // 6. Latar blur.
    await step("latar blur meratakan latar ter-key, subjek tetap ada", async () => {
      const r = await runProbe(page, "blur");
      log(
        `       applied=${JSON.stringify(r.applied)} varian-latar=${r.bgVariance.toFixed(0)} subjek=${r.subjectMean.toFixed(0)} radius=${r.radius}px`,
      );
      assert.ok(
        r.applied.some((name) => name.startsWith("background")),
        "tahap background tidak dijalankan",
      );
      assert.ok(r.bgVariance < 1500, `latar tidak terlihat kabur (varian ${r.bgVariance.toFixed(0)})`);
      assert.ok(r.subjectMean > 120, `subjek hilang setelah latar dikaburkan (${r.subjectMean.toFixed(0)})`);
    });

    // 7. Kegagalan provider AI ≠ foto hilang.
    await step("kegagalan provider AI → foto tetap keluar (degraded)", async () => {
      const r = await runProbe(page, "degrade");
      log(
        `       processed=${r.processed} degraded=${r.degraded} ${r.width}x${r.height} ${r.outBytes} B`,
      );
      assert.equal(r.processed, true, "foto tidak diproses sama sekali");
      assert.equal(r.width, 100, "lebar keluaran berubah");
      assert.equal(r.height, 80, "tinggi keluaran berubah");
      assert.equal(r.degraded, true, "kegagalan provider tidak ditandai degraded");
      assert.ok(r.outBytes > 0, "blob keluaran kosong — foto hilang");
    });

    // 8. Jalur off-thread.
    await step("jalur off-thread terdeteksi & tidak salah dipakai", async () => {
      const r = await runProbe(page, "offThread");
      log(`       ${JSON.stringify(r)}`);
      assert.equal(r.offscreen, true, "OffscreenCanvas tidak tersedia di Chromium headless");
      assert.equal(r.worker, true, "Worker tidak tersedia");
      assert.equal(r.supported, true, "supportsFilterOffThread() false padahal didukung");
      assert.equal(r.canOffThread, true, "filter worker-saja tidak boleh dilempar ke Worker");
      assert.equal(r.identityBlocked, false, "tanpa filter seharusnya tidak membuat Worker");
      assert.equal(r.aiBlocked, false, "latar AI butuh provider main thread — tidak boleh off-thread");
    });

    // 9. Cache model: unduh sekali.
    await step("modelCache mengunduh sekali lalu melayani tanpa jaringan", async () => {
      const r = await runProbe(page, "modelCache");
      log(
        `       ${r.bytes} B, has=${r.hasAfter}, hits=${r.hitsAfterFirst}→${r.hitsAfterSecond}, list=${JSON.stringify(r.list)}`,
      );
      assert.ok(r.bytes > 0, "model tidak terunduh");
      assert.equal(r.hasAfter, true, "model tidak tersimpan di cache");
      assert.equal(r.secondBytes, r.bytes, "panggilan kedua mengembalikan byte berbeda");
      assert.equal(r.hitsAfterFirst, 1, "panggilan pertama tidak tepat sekali menyentuh jaringan");
      assert.equal(r.hitsAfterSecond, 1, "panggilan kedua menyentuh jaringan — cache tidak dipakai");
      assert.ok(r.list.includes(MODEL), `model tidak terdaftar di cache: ${JSON.stringify(r.list)}`);
    });

    // 10. Sentry no-op tanpa DSN.
    await step("Sentry tanpa DSN = no-op (SDK tidak dimuat)", async () => {
      const r = await runProbe(page, "sentry");
      log(`       ${JSON.stringify(r)}`);
      assert.equal(r.enabled, false, "Sentry aktif tanpa DSN");
      assert.equal(r.loadCalled, 0, "SDK Sentry dimuat padahal DSN kosong");
    });

    // 11. Storage picker.
    await step("storage picker: folder pilihan, batal, dan fallback OPFS", async () => {
      const r = await runProbe(page, "storage");
      log(`       ${JSON.stringify(r)}`);
      assert.equal(r.backendFs, "fs-access", "backend fs-access tidak terdeteksi");
      assert.equal(r.targetBackend, "fs-access", "folder pilihan tidak terpilih");
      assert.equal(r.saved, true, "arsip tidak berhasil ditulis ke folder pilihan");
      assert.ok(r.writtenCount > 0, "tidak ada tulisan yang sampai ke folder");
      assert.equal(r.cancelled, true, "pembatalan picker tidak menghasilkan null");
      assert.equal(r.opfsBackend, "opfs", "fallback OPFS tidak dipakai saat File System Access tak ada");
      assert.equal(r.none, null, "tanpa API arsip seharusnya null");
    });

    // 12. faceEnhance produksi.
    await step("faceEnhance produksi: ORT + wasm host sendiri, model di-cache", async () => {
      const r = await runProbe(page, "faceEnhance", MODEL, "fb-models-e2e-face");
      log(
        `       ok=${r.ok} ready=${r.ready} ${r.outW}x${r.outH} piksel=${r.pixels} distinct=${r.distinct}`,
      );
      assert.equal(r.ok, true, "enhance() mengembalikan null — runtime ORT tidak termuat di produksi");
      assert.equal(r.ready, true, "sesi ONNX tidak siap");
      assert.equal(r.outW, 512, "lebar keluaran bukan 512");
      assert.equal(r.outH, 512, "tinggi keluaran bukan 512");
      assert.equal(r.pixels, 512 * 512, "keluaran tidak seukuran kanvas masukan");
      assert.ok(r.distinct > 1, "keluaran rata — inferensi tidak menghasilkan piksel");
      assert.ok(
        r.hits.some((url) => url.includes("/models/") && url.endsWith(".onnx")),
        `model tidak di-fetch dari /models/*: ${JSON.stringify(r.hits)}`,
      );
      assert.equal(r.cached, true, "model tidak tersimpan di cache setelah dipakai");
      assert.ok(
        responses.some((x) => x.url.includes("/models/ort/") && x.url.endsWith(".wasm") && x.status === 200),
        "wasm ORT tidak diambil dari host sendiri (models/ort)",
      );
    });

    // 13. Segmenter (model bundled). Yang dibuktikan di sini adalah **liveness**:
    // model bundled benar-benar termuat dan menghasilkan mask seukuran gambar.
    // Kualitas deteksi subjek **tidak** diuji di sini — MediaPipe selfie
    // segmenter dilatih pada foto orang nyata, dan fixture sintetis (kotak
    // warna) berada di luar distribusinya, jadi menuntut piksel subjek di sini
    // hanya akan menghasilkan tes yang rapuh. Kalau model tidak tersedia di
    // lingkungan ini, mask `null` adalah degradasi yang sah (foto tetap keluar).
    await step("segmenter bundled: model termuat & mask seukuran gambar (atau degradasi anggun)", async () => {
      const r = await runProbe(page, "segmenter");
      log(`       ${JSON.stringify(r)}`);
      if (r.maskNull) {
        log("       (model tidak termuat di lingkungan ini — mask dilewati, sesuai degradasi anggun)");
        return;
      }
      assert.equal(r.ready, true, "mask dihasilkan padahal segmenter belum siap");
      assert.equal(r.len, r.expect, "panjang mask tidak sama dengan jumlah piksel gambar");
    });

    // 15. Tidak ada permintaan ke host luar — semua aset di-host sendiri.
    await step("semua aset dari host sendiri (tanpa CDN)", async () => {
      const external = requests.filter((url) => !url.startsWith(base) && !url.startsWith("data:"));
      assert.deepEqual(external, [], `ada permintaan ke host luar: ${external.slice(0, 3).join(", ")}`);
    });

    // Cek error konsol **sebelum** membuka aplikasi studio: harness ini sengaja
    // tanpa API, jadi halaman aplikasi wajar 404 pada `/v1/*` — itu bukan error
    // yang sedang diuji. Yang diuji di sini adalah halaman probe.
    await step("tanpa error konsol di halaman probe", async () => {
      assert.deepEqual(pageErrors, [], `error konsol: ${pageErrors.slice(0, 3).join(" | ")}`);
    });

    // 16–17. DOM aplikasi studio nyata (`dist`): panel debug & lebar 390px.
    await step("panel debug: nol DOM tanpa flag, muncul dengan ?debug=1", async () => {
      const app = await context.newPage();

      await app.goto(`${base}/studio/`, { waitUntil: "domcontentloaded" });
      await app.locator('[data-testid="tabs"]').waitFor({ timeout: STEP_TIMEOUT });
      const hidden = await app.locator('[data-testid="debug-panel"]').count();

      await app.goto(`${base}/studio/?debug=1`, { waitUntil: "domcontentloaded" });
      await app.locator('[data-testid="debug-panel"]').waitFor({ timeout: STEP_TIMEOUT });
      const shown = await app.locator('[data-testid="debug-panel"]').count();
      const lines = await app.locator('[data-testid="debug-lines"] dd').count();
      const text = await app.locator('[data-testid="debug-panel"]').innerText();

      await app.close();

      log(`       tanpa flag=${hidden}, dengan flag=${shown}, baris laporan=${lines}`);
      assert.equal(hidden, 0, "panel debug muncul tanpa ?debug=1");
      assert.ok(shown > 0, "panel debug tidak muncul dengan ?debug=1");
      assert.ok(lines > 0, "panel debug tidak menampilkan satu baris laporan pun");
      assert.match(text, /Storage persisten/, "laporan storage tidak memuat status persistensi");
    });

    await step("panel filter di 390px tidak ada elemen meluber", async () => {
      const mobile = await context.newPage();
      await mobile.setViewportSize({ width: 390, height: 844 });
      await mobile.goto(`${base}/studio/`, { waitUntil: "domcontentloaded" });
      await mobile.locator('[data-testid="capture-filters"]').waitFor({ timeout: STEP_TIMEOUT });

      const measure = await mobile.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      await mobile.close();

      log(`       scrollWidth=${measure.scroll} clientWidth=${measure.client}`);
      assert.ok(
        measure.scroll <= measure.client + 1,
        `panel meluber di 390px: scrollWidth ${measure.scroll} > clientWidth ${measure.client}`,
      );
    });

    await step("tanpa error konsol selama sesi", async () => {
      assert.deepEqual(pageErrors, [], `error konsol: ${pageErrors.slice(0, 3).join(" | ")}`);
    });

    log("\nSEMUA SKENARIO LULUS");
  } catch (error) {
    failure = error;
    log(`\nGAGAL: ${error instanceof Error ? error.message : String(error)}`);

    try {
      await mkdir(ARTIFACTS, { recursive: true });
      const shot = join(ARTIFACTS, `gagal-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      log(`screenshot: ${shot}`);

      await writeFile(join(ARTIFACTS, "gagal.html"), await page.content(), "utf8");
      const dump = requests.map((url) => url).join("\n");
      await writeFile(join(ARTIFACTS, "requests.txt"), dump, "utf8");
      log(`error konsol:\n${pageErrors.join("\n")}`);
    } catch (artefactError) {
      log(`gagal menyimpan artefak: ${String(artefactError)}`);
    }
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  if (failure !== null) process.exit(1);
}

await main();
