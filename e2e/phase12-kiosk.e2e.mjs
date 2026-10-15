#!/usr/bin/env node
/**
 * Harness e2e Fase 12 — layar hasil tamu (#51) & peringatan keluar (#52).
 *
 * Yang dibuktikan berkas ini, dan yang **tidak** bisa dibuktikan unit test:
 *
 *   1. Layar tarik muncul saat kiosk aktif, dan hilang begitu tamu menyentuh.
 *   2. Sesi foto berjalan sampai `composed` tanpa operator menyentuh apa pun.
 *   3. **Layar hasil tamu benar-benar muncul** setelah sesi diterima — ini inti
 *      titipan #51; sebelumnya konfigurasi tombolnya ada tapi layar ini belum
 *      ada, jadi tombol tamu tidak pernah tampil.
 *   4. Tombol yang tampil **persis** yang dinyalakan operator: tombol yang mati
 *      tidak bocor ke layar tamu, dan "Selesai" selalu ada.
 *   5. Tombol cetak benar-benar mencetak lewat jalur browser (render → data URL
 *      → dokumen cetak → iframe), bukan sekadar ada.
 *   6. Tombol galeri membuka URL galeri aktif.
 *   7. Tombol "Selesai" mengembalikan kiosk ke layar tarik.
 *   8. **Peringatan keluar muncul saat sesi masih hidup** dan menyebut sebabnya;
 *      "tetap di kiosk" membatalkannya, "keluar" benar-benar keluar.
 *
 * Kenapa browser sungguhan: seluruh janji di atas hidup di batas yang tidak ada
 * di Node — IndexedDB (frame store), `OffscreenCanvas`/`createImageBitmap`
 * (render strip), iframe cetak, dan layar penuh. Karena itu halaman yang diuji
 * adalah **bundel produksi** (`apps/studio/dist`), bukan dev server.
 *
 * Pemakaian:
 *
 *   pnpm --filter @foto-booth/studio build
 *   node e2e/phase12-kiosk.e2e.mjs
 *
 * Opsi: `FB_E2E_HEADED=1`, `FB_E2E_SLOWMO=ms`, `FB_E2E_ARTIFACTS=dir`
 * (screenshot + HTML saat gagal), `FB_E2E_PORT=0` (port bebas pilihan OS).
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_APP = join(ROOT, "apps/studio/dist");
const PORT = Number(process.env.FB_E2E_PORT ?? "0");
const HEADED = process.env.FB_E2E_HEADED === "1";
const SLOWMO = Number(process.env.FB_E2E_SLOWMO ?? "0");
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

function assertAppBuilt() {
  assert.ok(
    existsSync(join(DIST_APP, "index.html")),
    "apps/studio/dist belum ada — jalankan `pnpm --filter @foto-booth/studio build` dulu",
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
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/**
 * Layani `apps/studio/dist` di bawah `/studio/`, seperti rute API sungguhan.
 *
 * Panggilan API (`/v1/...`) sengaja dijawab 404: skenario kiosk tidak butuh
 * server, dan kiosk yang mati karena API tidak ada justru bug yang mau
 * ditangkap. Kalau aplikasi menyerah saat API 404, langkah di bawah gagal.
 */
function startServer() {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const clean = normalize(path).replace(/^(\.[/\\])+/, "");

    const rest = clean.startsWith("/studio/") ? clean.slice("/studio/".length) : clean;
    const file = join(DIST_APP, rest === "" || rest.endsWith("/") ? `${rest}index.html` : rest);

    if (!file.startsWith(DIST_APP)) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("bad path");
      return;
    }

    try {
      const info = await stat(file);
      if (info.isFile()) {
        const body = await readFile(file);
        response.writeHead(200, {
          "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
          "content-length": String(body.length),
        });
        response.end(body);
        return;
      }
    } catch {
      // jatuh ke 404 di bawah
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

// ── konfigurasi awal ────────────────────────────────────────────────────

/**
 * Sesi pendek supaya harness tidak menunggu belasan detik.
 *
 * Nilainya sengaja ditulis apa adanya, bukan dihitung: kalau bentuk
 * `SessionConfig` berubah, parse di aplikasi akan mengabaikannya dan harness
 * ini gagal di langkah "sesi selesai" — bukan lulus diam-diam dengan setelan
 * bawaan yang lambat.
 */
const SESSION_CONFIG = {
  shotCount: 2,
  countdownMs: 200,
  intervalMs: 100,
  reviewMs: 0,
  shutterOffsetMs: 0,
  autoConnect: true,
};

const KIOSK_CONFIG = {
  enabled: true,
  idle: { timeoutMs: 600_000, warningMs: 10_000 },
  requirePinOnExit: false,
  blockGestures: false,
  tapToStart: true,
  // Semua tombol tamu menyala: harness memeriksa ketiganya + "Selesai".
  buttons: { gallery: true, print: true, share: true },
};

/** Tunggu state mesin capture tertentu. */
async function waitForState(page, state) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="capture-state"]')?.getAttribute("data-state") ===
      expected,
    state,
    { timeout: STEP_TIMEOUT },
  );
}

async function main() {
  log("Harness e2e Fase 12 — layar hasil kiosk (#51) & peringatan keluar (#52)");

  assertAppBuilt();

  const { server, base } = await startServer();
  const studioUrl = `${base}/studio/?fake=webcam`;
  log(`       studio: ${studioUrl}`);

  const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOWMO });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: [],
  });

  // Konfigurasi ditulis sebelum aplikasi dimuat: kiosk harus aktif sejak
  // render pertama, karena itulah cara operator menjalankannya (setelan sudah
  // tersimpan dari sesi sebelumnya). Galeri aktif juga ditulis di sini — tanpa
  // galeri, `accept()` tidak bisa menyimpan dan sesi berhenti di `processing`,
  // jadi layar hasil tidak pernah muncul.
  const galleryUrl = `${base}/studio/gallery-e2e`;
  await context.addInitScript(
    ([kiosk, session, gallery]) => {
      localStorage.setItem("foto-booth:kiosk", JSON.stringify(kiosk));
      localStorage.setItem("foto-booth:config", JSON.stringify(session));
      localStorage.setItem(
        "foto-booth:active-gallery",
        JSON.stringify({
          id: "e2e-gallery",
          hash: "e2e-hash",
          url: gallery,
          label: "E2E",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      );

      // Rekam isi setiap iframe cetak.
      //
      // Iframe cetak hidup sangat singkat: `afterprint` (atau jaring pengaman
      // 2 detik) langsung melepasnya. Kalau isinya diperiksa dengan polling
      // dari luar, balapannya bisa kalah — dan tes jadi gagal walau cetaknya
      // benar-benar jalan. MutationObserver di halaman menangkap dokumen itu
      // saat ia masih ada, tanpa mengubah kode aplikasi.
      window.__printDocs = [];
      const observe = () => {
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!(node instanceof HTMLIFrameElement)) continue;
              if (node.getAttribute("data-print-frame") !== "1") continue;
              node.addEventListener("load", () => {
                try {
                  window.__printDocs.push(node.contentDocument?.body?.innerHTML ?? "");
                } catch {
                  window.__printDocs.push("");
                }
              });
            }
          }
        });
        observer.observe(document.body, { childList: true });
      };
      if (document.body === null) {
        document.addEventListener("DOMContentLoaded", observe);
      } else {
        observe();
      }
    },
    [KIOSK_CONFIG, SESSION_CONFIG, galleryUrl],
  );

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  let failure = null;

  try {
    await step("buka studio sebagai kiosk (bundel produksi)", async () => {
      const res = await page.goto(studioUrl, { waitUntil: "load" });
      assert.equal(res.status(), 200, "halaman studio harus 200");
      await page.waitForSelector('[data-testid="capture-state"]', { timeout: STEP_TIMEOUT });
    });

    await step("layar tarik tampil selama kiosk menunggu tamu", async () => {
      await page.waitForSelector('[data-testid="kiosk-attract"]', { timeout: STEP_TIMEOUT });
      assert.equal(
        await page.locator('[data-testid="kiosk-result"]').count(),
        0,
        "layar hasil tidak boleh muncul sebelum ada sesi",
      );
    });

    await step("tamu menyentuh layar: layar tarik hilang, kiosk siap", async () => {
      await page.click('[data-testid="kiosk-start"]');
      await page.waitForSelector('[data-testid="kiosk-attract"]', {
        state: "detached",
        timeout: STEP_TIMEOUT,
      });
      await waitForState(page, "idle");
    });

    await step("sesi foto berjalan sampai `composed`", async () => {
      await page.click('[data-testid="capture-arm"]');
      await page.click('[data-testid="capture-begin"]');
      await waitForState(page, "review");

      const filled = await page.locator('[data-testid="capture-state"]').getAttribute("data-state");
      assert.equal(filled, "review", "sesi harus berhenti di `review` setelah semua frame diisi");

      await page.click('[data-testid="capture-accept"]');
      await waitForState(page, "composed");
    });

    await step("layar hasil tamu muncul setelah sesi diterima (#51)", async () => {
      await page.waitForSelector('[data-testid="kiosk-result"]', { timeout: STEP_TIMEOUT });
      assert.equal(
        await page.locator('[data-testid="kiosk-result-no-actions"]').count(),
        0,
        "tombol tamu menyala, jadi tidak boleh ada pesan \"tidak ada tombol\"",
      );
    });

    await step("tombol yang tampil persis yang dinyalakan operator", async () => {
      for (const id of ["print", "gallery", "share", "done"]) {
        assert.equal(
          await page.locator(`[data-testid="kiosk-result-${id}"]`).count(),
          1,
          `tombol ${id} harus tampil (operator menyalakannya)`,
        );
      }
    });

    await step("tombol cetak benar-benar mencetak lewat jalur browser", async () => {
      await page.click('[data-testid="kiosk-result-print"]');

      // Cetak selesai: jalur browser benar-benar dipakai.
      await page.waitForSelector('[data-testid="kiosk-result-print-ok"]', { timeout: STEP_TIMEOUT });
      assert.equal(
        await page.locator('[data-testid="kiosk-result-print-error"]').count(),
        0,
        "cetak tidak boleh dilaporkan gagal",
      );

      // Isi dokumen cetak = buktinya, bukan pesan sukses. Diambil dari rekaman
      // MutationObserver: dokumen cetak memuat gambar hasil sesi sebagai data
      // URL, jadi ia tidak bergantung pada blob URL halaman induk.
      const docs = await page.evaluate(() => window.__printDocs ?? []);
      assert.ok(docs.length > 0, "harus ada dokumen cetak yang dibuat");
      assert.ok(
        docs.some((html) => html.includes("<img") && html.includes("data:image/")),
        `dokumen cetak harus memuat gambar hasil sesi sebagai data URL, dapat: ${docs.join(" | ").slice(0, 200)}`,
      );
    });

    await step("tombol galeri membuka URL galeri aktif", async () => {
      const popupPromise = context.waitForEvent("page", { timeout: STEP_TIMEOUT });
      await page.click('[data-testid="kiosk-result-gallery"]');
      const popup = await popupPromise;
      assert.equal(popup.url(), galleryUrl, "tombol galeri harus membuka URL galeri aktif");
      await popup.close();
    });

    await step("tombol \"Selesai\" mengembalikan kiosk ke layar tarik", async () => {
      await page.click('[data-testid="kiosk-result-done"]');
      await page.waitForSelector('[data-testid="kiosk-attract"]', { timeout: STEP_TIMEOUT });
      assert.equal(
        await page.locator('[data-testid="kiosk-result"]').count(),
        0,
        "layar hasil harus hilang setelah Selesai",
      );
    });

    await step("peringatan keluar muncul saat sesi masih hidup (#52)", async () => {
      await page.click('[data-testid="kiosk-start"]');
      await page.click('[data-testid="capture-arm"]');
      await waitForState(page, "armed");

      await page.click('[data-testid="kiosk-exit"]');
      await page.waitForSelector('[data-testid="kiosk-exit-warning"]', { timeout: STEP_TIMEOUT });

      const body = await page.locator('[data-testid="kiosk-exit-warning-body"]').innerText();
      assert.ok(
        body.toLowerCase().includes("sesi"),
        `peringatan harus menyebut sesi yang berjalan, dapat: ${body}`,
      );
    });

    await step("\"tetap di kiosk\" membatalkan keluar", async () => {
      await page.click('[data-testid="kiosk-exit-warning-cancel"]');
      await page.waitForSelector('[data-testid="kiosk-exit-warning"]', {
        state: "detached",
        timeout: STEP_TIMEOUT,
      });
      assert.equal(
        await page.locator('[data-testid="kiosk-attract"]').count(),
        0,
        "kiosk harus tetap aktif setelah peringatan dibatalkan",
      );
    });

    await step("\"keluar\" benar-benar keluar dari kiosk", async () => {
      await page.click('[data-testid="kiosk-exit"]');
      await page.waitForSelector('[data-testid="kiosk-exit-warning"]', { timeout: STEP_TIMEOUT });
      await page.click('[data-testid="kiosk-exit-warning-confirm"]');

      await page.waitForSelector('[data-testid="kiosk-layer"]', {
        state: "detached",
        timeout: STEP_TIMEOUT,
      });

      const enabled = await page.evaluate(
        () => JSON.parse(localStorage.getItem("foto-booth:kiosk") ?? "{}").enabled === true,
      );
      assert.equal(enabled, false, "konfigurasi kiosk harus tersimpan sebagai nonaktif");
    });

    await step("tidak ada error halaman selama seluruh alur", () => {
      assert.deepEqual(pageErrors, [], `error halaman: ${pageErrors.join(" | ")}`);
    });
  } catch (error) {
    failure = error;
    try {
      await mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({ path: join(ARTIFACTS, "phase12-kiosk-fail.png"), fullPage: true });
      await writeFile(join(ARTIFACTS, "phase12-kiosk-fail.html"), await page.content(), "utf8");
      log(`       artefak: ${ARTIFACTS}/phase12-kiosk-fail.{png,html}`);
    } catch {
      // artefak itu bonus; jangan menutupi kegagalan aslinya.
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (failure !== null) {
    log(`\nGAGAL: ${failure.message}`);
    process.exitCode = 1;
    return;
  }

  log(`\nSemua ${stepNo} langkah lolos.`);
}

await main();
