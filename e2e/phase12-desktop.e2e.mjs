/**
 * E2E Fase 12: shell desktop Electron (#88) + jembatan printer (#45/#80/#81).
 *
 * Yang dibuktikan berkas ini **bukan** "paket electron terpasang", tapi:
 *
 *   1. proses utama `apps/desktop/src/main.cjs` benar-benar naik dan memuat
 *      studio dari URL yang diminta;
 *   2. jembatan preload (`window.fotoBoothDesktop`) ada di renderer, dan
 *      renderer **tidak** punya akses Node (`require`, `process`);
 *   3. IPC `getPrinters` menjawab — lewat Electron asli, bukan tiruan;
 *   4. navigasi keluar origin diblokir (kiosk tidak bisa dibawa keluar).
 *
 * Dijalankan headless lewat `xvfb-run`. Halaman uji melaporkan hasilnya sendiri
 * dengan POST kembali ke server uji, karena renderer Electron tidak menulis ke
 * stdout proses ini.
 *
 * Pakai: node e2e/phase12-desktop.e2e.mjs
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = path.join(ROOT, "apps", "desktop");
const ELECTRON_BIN = path.join(DESKTOP_DIR, "node_modules", "electron", "dist", "electron");

/** Jalan keluar yang harus TERTUTUP di renderer. */
const ESCAPE_HATCH = `
  <script>
    window.__nodeAccess = typeof require === "function" || typeof process === "object";
    // Diisi server uji dengan URL server KEDUA (origin berbeda).
    window.__outsideUrl = "__OUTSIDE_URL__";
  </script>
`;

const PAGE = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><title>ujian shell</title></head>
<body>
<h1 id="judul">ujian shell</h1>
${ESCAPE_HATCH}
<script>
  (async () => {
    const report = {
      bridge: false,
      nodeAccess: window.__nodeAccess === true,
      printers: null,
      printersError: null,
      versions: null,
    };

    try {
      const bridge = window.fotoBoothDesktop;
      report.bridge = Boolean(bridge);
      report.versions = bridge && bridge.versions ? bridge.versions : null;
      if (bridge) {
        try {
          report.printers = await bridge.getPrinters();
        } catch (error) {
          report.printersError = String(error);
        }
      }
    } catch (error) {
      report.printersError = String(error);
    }

    await fetch("/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });

    // Percobaan keluar dari origin ke server KEDUA yang benar-benar hidup.
    // Diblokir = server luar tidak melihat permintaan apa pun.
    setTimeout(() => {
      window.location.href = window.__outsideUrl;
    }, 100);
  })();
</script>
</body></html>`;

const PAGE_ESCAPED = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><title>keluar!</title></head>
<body><h1>halaman luar</h1></body></html>`;

/**
 * Server uji: menyajikan halaman uji (dengan URL luar yang sudah tertanam) dan
 * menampung laporan dari renderer.
 */
function startServer(outsideUrl) {
  let resolveReport;
  const reportPromise = new Promise((resolve) => {
    resolveReport = resolve;
  });

  const page = PAGE.replace("__OUTSIDE_URL__", outsideUrl);

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/report") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(204).end();
        try {
          resolveReport(JSON.parse(body));
        } catch (error) {
          resolveReport({ parseError: String(error) });
        }
      });
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, reportPromise }));
  });
}

/**
 * Server "luar": origin kedua yang benar-benar hidup. Kalau shell menuruti
 * navigasi keluar, server ini menerima permintaan — dan pemeriksaan gagal.
 */
function startOutsideServer() {
  const state = { hits: 0 };
  const server = createServer((_req, res) => {
    state.hits += 1;
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE_ESCAPED);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state }));
  });
}

function fail(message, extra) {
  console.error(`E2E GAGAL: ${message}`);
  if (extra) console.error(extra);
  process.exit(1);
}

if (!existsSync(ELECTRON_BIN)) {
  fail(
    `binary Electron tidak ada di ${ELECTRON_BIN}\n` +
      "Jalankan: node apps/desktop/node_modules/electron/install.js",
  );
}

const outside = await startOutsideServer();
const outsideUrl = `http://127.0.0.1:${outside.server.address().port}/luar`;

const { server, reportPromise } = await startServer(outsideUrl);
const { port } = server.address();
const appUrl = `http://127.0.0.1:${port}/`;

const child = spawn(
  "xvfb-run",
  [
    "-a",
    "--server-args=-screen 0 1280x800x24",
    ELECTRON_BIN,
    "--no-sandbox",
    DESKTOP_DIR,
    `--url=${appUrl}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let output = "";
child.stdout.on("data", (d) => {
  output += String(d);
});
child.stderr.on("data", (d) => {
  output += String(d);
});

const TIMEOUT_MS = 60_000;
const timer = setTimeout(() => {
  child.kill("SIGKILL");
  server.close();
  fail(`tidak ada laporan dalam ${TIMEOUT_MS / 1000} detik`, output.slice(-2000));
}, TIMEOUT_MS);

/** @type {Record<string, unknown>} */
const report = await reportPromise;

// Beri waktu percobaan navigasi keluar (100 ms setelah laporan) untuk terjadi,
// lalu periksa apakah server luar menerima permintaan apa pun.
await new Promise((resolve) => setTimeout(resolve, 2000));

clearTimeout(timer);
child.kill("SIGTERM");
server.close();
outside.server.close();

const checks = [
  ["jembatan preload ada", report.bridge === true],
  ["renderer TIDAK punya akses Node", report.nodeAccess === false],
  ["IPC getPrinters menjawab tanpa error", report.printersError === null],
  ["daftar printer berupa array", Array.isArray(report.printers)],
  ["versi runtime terisi", typeof report.versions?.electron === "string"],
  ["navigasi keluar origin diblokir", outside.state.hits === 0],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "OK  " : "GAGAL"} ${label}`);
  if (!ok) failed += 1;
}

console.log("\nLaporan renderer:");
console.log(JSON.stringify(report, null, 2));
console.log(`Printer terlihat: ${Array.isArray(report.printers) ? report.printers.length : "-"}`);
console.log(`Permintaan ke origin luar: ${outside.state.hits}`);

if (failed > 0) {
  console.error(`\n${failed} pemeriksaan gagal. Keluaran Electron:\n${output.slice(-3000)}`);
  process.exit(1);
}

console.log("\nFase 12 desktop: SEMUA PEMERIKSAAN LULUS");
process.exit(0);
