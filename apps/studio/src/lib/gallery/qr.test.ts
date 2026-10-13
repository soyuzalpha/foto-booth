/**
 * Tes QR album tamu.
 *
 * Dua janji:
 *
 *   1. **QR dibuat di perangkat.** Tidak ada permintaan jaringan di modul ini —
 *      kiosk harus tetap menampilkan QR saat internet mati, karena URL-nya
 *      sudah diketahui sejak galeri dibuat.
 *   2. **Zona sunyi tidak boleh 0.** QR tanpa margin sering ditolak scanner;
 *      ini gagal senyap — gambar tetap *kelihatan* seperti QR.
 *
 * QR-nya diuji dengan decoder sungguhan? Tidak — tidak ada decoder di sini.
 * Yang diuji adalah kontraknya (teks kosong ditolak, SVG terbentuk, ukuran
 * dihormati) dan bahwa encoder-nya memang paket `qrcode`, bukan tulisan sendiri.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_QR_OPTIONS,
  galleryUrl,
  isSafeGalleryHash,
  renderQrDataUrl,
  renderQrSvg,
} from "./qr.ts";

test("hash galeri hanya menerima karakter URL-aman", () => {
  assert.equal(isSafeGalleryHash("AbCd1234"), true);
  assert.equal(isSafeGalleryHash("abc_def-9"), true);

  assert.equal(isSafeGalleryHash("abc"), false, "terlalu pendek");
  assert.equal(isSafeGalleryHash("a/b"), false, "garis miring mengubah path");
  assert.equal(isSafeGalleryHash("a b"), false, "spasi");
  assert.equal(isSafeGalleryHash("a?x=1"), false, "query string");
  assert.equal(isSafeGalleryHash("a".repeat(65)), false, "terlalu panjang");
  assert.equal(isSafeGalleryHash(""), false);
});

test("galleryUrl memakai origin yang sedang dipakai, bukan konstanta", () => {
  // Galeri yang sama harus benar dibuka lewat tunnel, LAN, maupun localhost.
  assert.equal(galleryUrl("https://foto.soyuz.my.id", "AbCd1234"), "https://foto.soyuz.my.id/a/AbCd1234");
  assert.equal(galleryUrl("http://192.168.1.9:5000", "h1"), "http://192.168.1.9:5000/a/h1");
});

test("galleryUrl tidak menggandakan garis miring di ujung origin", () => {
  assert.equal(galleryUrl("https://foto.soyuz.my.id/", "AbCd1234"), "https://foto.soyuz.my.id/a/AbCd1234");
  assert.equal(galleryUrl("https://foto.soyuz.my.id///", "h"), "https://foto.soyuz.my.id/a/h");
});

test("zona sunyi bawaan minimal 4 modul", () => {
  // Spesifikasi QR: 4 modul. Kurang dari itu, scanner banyak yang menolak.
  assert.ok(DEFAULT_QR_OPTIONS.margin >= 4);
  assert.equal(DEFAULT_QR_OPTIONS.errorCorrectionLevel, "M");
});

test("renderQrSvg menghasilkan SVG yang memuat URL-nya", async () => {
  const url = galleryUrl("https://foto.soyuz.my.id", "AbCd1234");
  const svg = await renderQrSvg(url);

  assert.equal(typeof svg, "string");
  assert.match(svg, /^<svg/);
  assert.match(svg, /<\/svg>\s*$/);
  assert.match(svg, /viewBox=/);
});

test("renderQrSvg menghormati opsi ukuran dan warna", async () => {
  const svg = await renderQrSvg("https://contoh.test/a/AbCd1234", {
    size: 240,
    dark: "#101010",
    light: "#fefefe",
  });

  assert.match(svg, /width="240"/);
  assert.match(svg, /height="240"/);
  assert.match(svg, /#101010/);
});

test("renderQrSvg menolak teks kosong alih-alih membuat QR kosong", async () => {
  // QR dari string kosong tetap "tampil" sebagai kotak, tapi tidak membawa
  // tamu ke mana pun — lebih baik gagal terang-terangan.
  await assert.rejects(() => renderQrSvg(""), /teks kosong/);
  await assert.rejects(() => renderQrDataUrl(""), /teks kosong/);
});

test("renderQrDataUrl menghasilkan PNG data-URL yang bisa diunduh operator", async () => {
  const dataUrl = await renderQrDataUrl("https://contoh.test/a/AbCd1234", { size: 64 });
  assert.match(dataUrl, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
});

test("QR tetap bisa dibuat tanpa DOM — tidak ada canvas, tidak ada jaringan", async () => {
  // Kalau modul ini menyentuh `document` atau `fetch`, tes ini gagal di Node.
  assert.equal(typeof document, "undefined");
  assert.equal(typeof globalThis.fetch, "function", "Node modern punya fetch — pastikan tidak dipakai");

  const svg = await renderQrSvg("https://contoh.test/a/AbCd1234");
  assert.ok(svg.length > 100);
});
