/**
 * Logika shell desktop yang **tidak** menyentuh Electron (Fase 12, #88).
 *
 * Dipisah dari `main.cjs` dengan sengaja: berkas ini bisa diuji dengan
 * `node --test` biasa, tanpa memasang Electron, tanpa layar, dan tanpa binary
 * 283 MB. Yang diuji di sini adalah keputusan yang gampang salah dan mahal:
 *
 *   · **Alamat mana yang dimuat** — salah alamat berarti kiosk membuka halaman
 *     kosong di depan tamu;
 *   · **Navigasi mana yang boleh** — shell desktop yang membiarkan halaman
 *     membuka jendela baru bisa dipakai untuk keluar dari kiosk;
 *   · **Argumen baris perintah** — operator mengetik `--kiosk`, bukan JSON.
 */

"use strict";

/** Alamat default: API di mesin yang sama, karena itu yang di-deploy. */
const DEFAULT_APP_URL = "http://127.0.0.1:5050/studio/";

/**
 * Tentukan alamat yang dimuat.
 *
 * Urutan: argumen `--url=` → env `FOTO_BOOTH_URL` → default.
 * Nilai kosong/spasi dianggap tidak ada, bukan alamat kosong — supaya
 * `FOTO_BOOTH_URL=` yang tidak sengaja di-set tidak membuat jendela blank.
 */
function resolveAppUrl(argv, env) {
  const fromArgv = pickArgValue(argv, "--url");
  if (fromArgv !== null && fromArgv.trim() !== "") return fromArgv.trim();

  const fromEnv = env && typeof env.FOTO_BOOTH_URL === "string" ? env.FOTO_BOOTH_URL : "";
  if (fromEnv.trim() !== "") return fromEnv.trim();

  return DEFAULT_APP_URL;
}

/** Nilai sebuah argumen `--nama=nilai`, atau `null`. */
function pickArgValue(argv, name) {
  if (!Array.isArray(argv)) return null;
  const prefix = `${name}=`;
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
}

/** Apakah sebuah flag ada di argumen (`--kiosk` atau `--kiosk=true`). */
function hasFlag(argv, name) {
  if (!Array.isArray(argv)) return false;
  return argv.some(
    (arg) => arg === name || (typeof arg === "string" && arg.startsWith(`${name}=`)),
  );
}

/**
 * Opsi awal dari argumen baris perintah.
 *
 * `--kiosk` menyalakan layar penuh tanpa menu dan tanpa jalan keluar lewat
 * keyboard. Itu yang dipakai di acara; saat menyiapkan booth operator menjalankan
 * tanpa flag ini supaya masih bisa membuka DevTools.
 */
function resolveOptions(argv, env) {
  const kiosk = hasFlag(argv, "--kiosk");
  return {
    url: resolveAppUrl(argv, env),
    kiosk,
    width: intArg(argv, "--width", 1280),
    height: intArg(argv, "--height", 800),
    /** DevTools hanya berguna saat tidak kiosk. */
    devTools: !kiosk && hasFlag(argv, "--devtools"),
  };
}

function intArg(argv, name, fallback) {
  const raw = pickArgValue(argv, name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Apakah navigasi ini boleh.
 *
 * Halaman studio hanya boleh berpindah di origin yang sama. Tautan keluar
 * (mis. WhatsApp ke tamu) dibuka di browser sistem, bukan menggantikan shell —
 * di kiosk, mengikuti tautan keluar berarti tamu bisa keluar dari aplikasi.
 */
function isAllowedNavigation(targetUrl, appUrl) {
  try {
    const target = new URL(targetUrl);
    const app = new URL(appUrl);

    if (target.origin !== app.origin) return false;

    // Halaman galeri tamu (`/a/...`) memang bagian dari aplikasi.
    return true;
  } catch {
    return false;
  }
}

/** Apakah URL ini harus dibuka di browser luar (bukan di dalam shell). */
function isExternal(targetUrl, appUrl) {
  try {
    const target = new URL(targetUrl);
    const app = new URL(appUrl);
    if (target.origin === app.origin) return false;

    // Skema yang tidak boleh dilempar ke `shell.openExternal` — kalau tidak,
    // ini jadi jalan menjalankan perintah di mesin kiosk.
    return ["http:", "https:", "mailto:", "tel:"].includes(target.protocol);
  } catch {
    return false;
  }
}

/**
 * Bentuk HTML cetak untuk Electron.
 *
 * Berbeda dari jalur browser: Electron mencetak **tanpa** dialog kalau diminta,
 * jadi tidak ada `afterprint` yang bisa diandalkan sebagai tanda selesai.
 * Karena itu HTML-nya harus sudah final saat diserahkan — ini hanya membungkus
 * gambar dengan ukuran halaman yang sama seperti `printBrowser.ts`, supaya
 * hasil cetak kedua jalur tidak berbeda.
 */
function buildPrintableHtml(input) {
  const widthMm = Number(input.widthMm);
  const heightMm = Number(input.heightMm);
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm)) {
    throw new Error("ukuran halaman cetak tidak valid");
  }

  const title = escapeHtml(String(input.title || "Foto Booth"));
  const imageUrl = escapeHtml(String(input.imageUrl));

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  img { display: block; width: 100%; height: 100%; object-fit: fill; }
</style>
</head>
<body><img src="${imageUrl}" alt=""></body>
</html>`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

module.exports = {
  DEFAULT_APP_URL,
  buildPrintableHtml,
  hasFlag,
  isAllowedNavigation,
  isExternal,
  pickArgValue,
  resolveAppUrl,
  resolveOptions,
};
