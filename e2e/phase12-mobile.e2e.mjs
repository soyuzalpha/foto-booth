/**
 * E2E Fase 12: shell mobile Capacitor (#89).
 *
 * Yang bisa dibuktikan di mesin ini **tanpa Java/Android SDK** bukan "APK jadi",
 * tapi rantai yang justru paling sering salah:
 *
 *   1. keputusan konfigurasi (dari modul murni, teruji) benar-benar mengalir ke
 *      `capacitor.config.json` — bukan disalin tangan lalu menyimpang;
 *   2. **Capacitor CLI sungguhan** (`cap sync`) benar-benar menerima konfigurasi
 *      itu dan menaruh salinannya di proyek native;
 *   3. UI yang dibungkus adalah **build studio**, ada di dalam paket — bukan
 *      alamat jarak jauh yang bikin aplikasi butuh internet;
 *   4. proyek native tetap meminta izin `CAMERA` — tanpa itu `getUserMedia`
 *      ditolak WebView dan kiosk tidak punya kamera (Capacitor default hanya
 *      memberi `INTERNET`).
 *
 * Langkah 4 dikunci ke berkas nyata di `android/`, bukan ke template: yang
 * diuji adalah apa yang benar-benar akan dikompilasi.
 *
 * Butuh `apps/studio/dist` (jalankan `pnpm build` dulu).
 * Pakai: node e2e/phase12-mobile.e2e.mjs
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

import { auditConfig, buildCapacitorConfig, toJsonFile } from "../apps/mobile/src/lib/mobileConfig.mjs";

const run = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOBILE_DIR = path.join(ROOT, "apps", "mobile");
const DIST_DIR = path.join(ROOT, "apps", "studio", "dist");
const CONFIG_FILE = path.join(MOBILE_DIR, "capacitor.config.json");
const PLATFORM_DIR = path.join(MOBILE_DIR, "android");
const SYNCED_CONFIG = path.join(
  PLATFORM_DIR,
  "app",
  "src",
  "main",
  "assets",
  "capacitor.config.json",
);
const SYNCED_INDEX = path.join(PLATFORM_DIR, "app", "src", "main", "assets", "public", "index.html");
const MANIFEST = path.join(PLATFORM_DIR, "app", "src", "main", "AndroidManifest.xml");
const CAP = path.join(MOBILE_DIR, "node_modules", ".bin", "cap");

/** @type {Array<[string, boolean, string?]>} */
const checks = [];
function check(label, ok, detail) {
  checks.push([label, ok, detail]);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

if (!existsSync(DIST_DIR)) {
  console.error("E2E GAGAL: apps/studio/dist tidak ada — jalankan `pnpm build` lebih dulu.");
  process.exit(1);
}

if (!existsSync(CAP)) {
  console.error(`E2E GAGAL: Capacitor CLI tidak ada di ${CAP} — jalankan \`pnpm install\`.`);
  process.exit(1);
}

// ── 1. Keputusan → berkas config ────────────────────────────────────────────
// Tulis ulang dari modul murni, lalu bandingkan dengan yang tersimpan. Kalau
// berbeda, ada yang menyunting JSON langsung dan keputusan teruji itu bohong.
const expected = toJsonFile(buildCapacitorConfig());

try {
  await run("node", [path.join(MOBILE_DIR, "scripts", "write-config.mjs")], {
    cwd: MOBILE_DIR,
  });
} catch (error) {
  console.error(`E2E GAGAL: penulis config gagal\n${error.stdout ?? ""}${error.stderr ?? ""}`);
  process.exit(1);
}

const onDisk = readFileSync(CONFIG_FILE, "utf8");
check(
  "capacitor.config.json dihasilkan dari keputusan yang teruji (bukan disunting tangan)",
  onDisk === expected,
  onDisk === expected ? undefined : `berkas:\n${onDisk}\ndiharapkan:\n${expected}`,
);

const config = readJson(CONFIG_FILE);
check("konfigurasi rilis bersih menurut auditConfig", auditConfig(config).length === 0, JSON.stringify(auditConfig(config)));
check("androidScheme https — kamera kiosk butuh secure context", config.androidScheme === "https");
check(
  "tidak ada server.url — UI datang dari paket, bukan internet",
  config.server?.url === undefined,
);

// ── 2. Capacitor CLI sungguhan menjalankan sync ─────────────────────────────
let syncOut = "";
try {
  const { stdout, stderr } = await run(CAP, ["sync", "android"], {
    cwd: MOBILE_DIR,
    timeout: 180_000,
  });
  syncOut = `${stdout}${stderr}`;
  check("cap sync android berhasil (Capacitor CLI sungguhan)", true);
} catch (error) {
  syncOut = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  check("cap sync android berhasil (Capacitor CLI sungguhan)", false, syncOut.slice(-2000));
}

// ── 3. Hasil sync ───────────────────────────────────────────────────────────
if (existsSync(SYNCED_CONFIG)) {
  const synced = readJson(SYNCED_CONFIG);
  check(
    "config yang sampai ke proyek native memakai https",
    synced.androidScheme === "https",
    JSON.stringify(synced),
  );
  check(
    "proyek native tidak diarahkan ke server jarak jauh",
    synced.server?.url === undefined,
    JSON.stringify(synced.server),
  );
} else {
  check("config tersalin ke proyek native", false, SYNCED_CONFIG);
}

check(
  "build studio benar-benar dibundel ke dalam paket",
  existsSync(SYNCED_INDEX),
  SYNCED_INDEX,
);

// ── 4. Izin kamera ──────────────────────────────────────────────────────────
if (existsSync(MANIFEST)) {
  const manifest = readFileSync(MANIFEST, "utf8");
  check(
    "AndroidManifest meminta CAMERA (default Capacitor tidak)",
    manifest.includes('android.permission.CAMERA'),
  );
  check(
    "AndroidManifest meminta RECORD_AUDIO (video bersuara)",
    manifest.includes('android.permission.RECORD_AUDIO'),
  );
} else {
  check("AndroidManifest ada", false, MANIFEST);
}

// ── Laporan ─────────────────────────────────────────────────────────────────
let failed = 0;
for (const [label, ok, detail] of checks) {
  console.log(`${ok ? "OK  " : "GAGAL"} ${label}`);
  if (!ok && detail) console.log(`      ${detail.split("\n").join("\n      ")}`);
  if (!ok) failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} pemeriksaan gagal. Keluaran cap sync:\n${syncOut.slice(-3000)}`);
  process.exit(1);
}

console.log("\nFase 12 mobile: SEMUA PEMERIKSAAN LULUS");
