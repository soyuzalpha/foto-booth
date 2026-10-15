/**
 * Tes keputusan konfigurasi mobile (Fase 12, #89).
 *
 * Yang diuji bukan Capacitor — melainkan tiga jebakan yang tidak akan terlihat
 * sampai aplikasi dibuka di HP: kamera mati karena origin tidak secure,
 * aplikasi tanpa UI, dan aplikasi yang diam-diam memuat halaman dari internet.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP_ID,
  WEB_DIR,
  auditConfig,
  buildCapacitorConfig,
  toJsonFile,
} from "./mobileConfig.mjs";

test("konfigurasi rilis selalu secure context", () => {
  const config = buildCapacitorConfig();
  // Ini alasan nomor satu shell mobile ada: tanpa `https`, `getUserMedia`
  // tidak tersedia di WebView Android dan kiosk tidak punya kamera.
  assert.equal(config.androidScheme, "https");
  assert.equal(config.server.androidScheme, "https");
  assert.deepEqual(auditConfig(config), [], "konfigurasi default harus bersih");
});

test("UI datang dari build studio, bukan folder kedua", () => {
  const config = buildCapacitorConfig();
  assert.equal(config.webDir, WEB_DIR);
  assert.match(WEB_DIR, /studio\/dist$/, "mobile membungkus studio, tidak menggandakannya");
});

test("tanpa permintaan eksplisit, tidak ada server jarak jauh", () => {
  const config = buildCapacitorConfig();
  // Kalau ini lolos, aplikasi jadi pembungkus web: tak bisa offline dan
  // isinya berubah sendiri di HP tamu.
  assert.equal(config.server.url, null);

  const asFile = JSON.parse(toJsonFile(config));
  assert.equal("url" in asFile.server, false, "kunci `url` harus dibuang, bukan `null`");
  assert.deepEqual(auditConfig(asFile), []);
});

test("dev server harus diminta eksplisit, dan tetap dilaporkan sebagai masalah", () => {
  const config = buildCapacitorConfig({ devServerUrl: "http://192.168.1.9:5173" });
  assert.equal(config.server.url, "http://192.168.1.9:5173");

  const asFile = JSON.parse(toJsonFile(config));
  assert.equal(asFile.server.url, "http://192.168.1.9:5173", "dev writable, jadi harus ikut tersimpan");

  // Tapi build seperti ini tidak boleh dikira siap rilis.
  const problems = auditConfig(asFile);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /server\.url terisi/);
});

test("devServerUrl kosong/spasi diperlakukan sebagai tidak ada", () => {
  for (const value of ["", "   ", null, undefined]) {
    const config = buildCapacitorConfig({ devServerUrl: value });
    assert.equal(config.server.url, null, `nilai ${JSON.stringify(value)} harus jadi null`);
  }
});

test("audit menangkap skema http dan cleartext", () => {
  const problems = auditConfig({
    webDir: WEB_DIR,
    androidScheme: "http",
    server: { androidScheme: "http", cleartext: true },
  });

  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes("androidScheme")));
  assert.ok(problems.some((p) => p.includes("cleartext")));
});

test("audit menangkap webDir kosong — aplikasi tanpa UI", () => {
  const problems = auditConfig({ androidScheme: "https", server: {}, webDir: "" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /webDir kosong/);
});

test("appId mobile dan desktop sama — satu aplikasi, bukan dua", () => {
  assert.equal(APP_ID, "id.soyuz.fotobooth");
  assert.equal(buildCapacitorConfig().appId, APP_ID);
});

test("serialisasi stabil: konfigurasi yang sama menghasilkan berkas yang sama", () => {
  // Berkas ini di-commit; hasil yang berubah-ubah bikin diff palsu tiap build.
  const a = toJsonFile(buildCapacitorConfig());
  const b = toJsonFile(buildCapacitorConfig());
  assert.equal(a, b);
  assert.ok(a.endsWith("\n"), "berkas JSON diakhiri newline");
});
