/**
 * Tes logika shell desktop (Fase 12, #88).
 *
 * Berjalan dengan `node --test` biasa — tanpa Electron, tanpa layar. Yang
 * diuji: keputusan yang bikin kiosk gagal di depan tamu, bukan pemanggilan
 * API Electron-nya.
 */

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  DEFAULT_APP_URL,
  buildPrintableHtml,
  hasFlag,
  isAllowedNavigation,
  isExternal,
  pickArgValue,
  resolveAppUrl,
  resolveOptions,
} = require("./config.cjs");

test("tanpa apa-apa: pakai alamat default", () => {
  assert.equal(resolveAppUrl([], {}), DEFAULT_APP_URL);
});

test("argumen menang atas env", () => {
  assert.equal(
    resolveAppUrl(["--url=http://192.168.1.5:5050/studio/"], { FOTO_BOOTH_URL: "http://lain/" }),
    "http://192.168.1.5:5050/studio/",
  );
});

test("env kosong atau spasi TIDAK menghasilkan alamat kosong", () => {
  // `FOTO_BOOTH_URL=` yang tidak sengaja di-set pernah bikin jendela blank.
  assert.equal(resolveAppUrl([], { FOTO_BOOTH_URL: "" }), DEFAULT_APP_URL);
  assert.equal(resolveAppUrl([], { FOTO_BOOTH_URL: "   " }), DEFAULT_APP_URL);
  assert.equal(resolveAppUrl(["--url=  "], {}), DEFAULT_APP_URL);
});

test("argumen dibaca per nama, bukan posisi", () => {
  assert.equal(pickArgValue(["--kiosk", "--url=http://a/", "--x=1"], "--url"), "http://a/");
  assert.equal(pickArgValue(["--url="], "--url"), "");
  assert.equal(pickArgValue(["--other=1"], "--url"), null);
  assert.equal(pickArgValue(null, "--url"), null);
});

test("flag dikenali dengan atau tanpa nilai", () => {
  assert.equal(hasFlag(["--kiosk"], "--kiosk"), true);
  assert.equal(hasFlag(["--kiosk=true"], "--kiosk"), true);
  assert.equal(hasFlag(["--kiosk=false"], "--kiosk"), true, "ada = menyala; mematikan lewat ketiadaan");
  assert.equal(hasFlag([], "--kiosk"), false);
});

test("ukuran jendela bisa diubah; nilai tidak masuk akal jatuh ke default", () => {
  const options = resolveOptions(["--width=1920", "--height=abc"], {});
  assert.equal(options.width, 1920);
  assert.equal(options.height, 800);
  assert.equal(resolveOptions(["--width=-5"], {}).width, 1280);
});

test("mode kiosk mematikan devtools", () => {
  // Di acara tidak boleh ada jalan ke DevTools dari keyboard.
  const kiosk = resolveOptions(["--kiosk", "--devtools"], {});
  assert.equal(kiosk.kiosk, true);
  assert.equal(kiosk.devTools, false);
  assert.equal(resolveOptions(["--devtools"], {}).devTools, true);
});

test("navigasi dalam origin yang sama boleh", () => {
  assert.equal(isAllowedNavigation("http://127.0.0.1:5050/studio/", DEFAULT_APP_URL), true);
  assert.equal(isAllowedNavigation("http://127.0.0.1:5050/a/token123", DEFAULT_APP_URL), true);
});

test("navigasi ke origin lain ditolak", () => {
  // Mengikuti tautan keluar dari shell = tamu bisa keluar dari kiosk.
  assert.equal(isAllowedNavigation("https://example.com/", DEFAULT_APP_URL), false);
  assert.equal(isAllowedNavigation("http://127.0.0.1:9999/", DEFAULT_APP_URL), false);
});

test("URL sampah tidak melempar, hanya ditolak", () => {
  assert.equal(isAllowedNavigation("bukan url", DEFAULT_APP_URL), false);
  assert.equal(isAllowedNavigation("", DEFAULT_APP_URL), false);
});

test("origin lain dengan skema web dianggap tautan luar", () => {
  assert.equal(isExternal("https://wa.me/628123", DEFAULT_APP_URL), true);
  assert.equal(isExternal("http://127.0.0.1:5050/studio/", DEFAULT_APP_URL), false);
});

test("skema berbahaya TIDAK diteruskan ke shell.openExternal", () => {
  // Ini jalan menjalankan perintah di mesin kiosk kalau dibiarkan.
  assert.equal(isExternal("file:///etc/passwd", DEFAULT_APP_URL), false);
  assert.equal(isExternal("javascript:alert(1)", DEFAULT_APP_URL), false);
  assert.equal(isExternal("data:text/html,<h1>x", DEFAULT_APP_URL), false);
});

test("HTML cetak memuat ukuran halaman dan gambar persis", () => {
  const html = buildPrintableHtml({
    imageUrl: "data:image/png;base64,AAA",
    widthMm: 50.8,
    heightMm: 152.4,
    title: "Strip 2x6",
  });

  assert.match(html, /@page \{ size: 50\.8mm 152\.4mm; margin: 0; \}/);
  assert.match(html, /<title>Strip 2x6<\/title>/);
  assert.match(html, /object-fit: fill/);
  assert.match(html, /src="data:image\/png;base64,AAA"/);
});

test("HTML cetak aman dari judul yang memuat tag", () => {
  const html = buildPrintableHtml({
    imageUrl: "data:image/png;base64,AAA",
    widthMm: 50,
    heightMm: 50,
    title: '<script>alert(1)</script>',
  });

  assert.equal(html.includes("<script>alert"), false);
  assert.match(html, /&lt;script&gt;/);
});

test("ukuran halaman tidak valid → melempar, bukan halaman kosong", () => {
  assert.throws(() =>
    buildPrintableHtml({ imageUrl: "data:", widthMm: "lebar", heightMm: 100 }),
  );
});
