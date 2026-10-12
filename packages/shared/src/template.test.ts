/**
 * Tes aturan template bersama (dipakai studio & API).
 *
 * Fokusnya angka dan aturan, bukan "kelihatan benar":
 *   · 2×6 inci @300 dpi harus tepat 600×1800 piksel — angka ini yang muncul
 *     di nama berkas dan di validasi cetak.
 *   · Token tak dikenal tidak boleh hilang diam-diam.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TEMPLATE_DPI_DEFAULT,
  exportFilename,
  extractTokens,
  hasTokens,
  isTemplateTooLarge,
  slugify,
  substituteTokens,
  templatePixelSize,
} from "./template.ts";

test("2×6 inci @300 dpi = 600×1800 piksel", () => {
  assert.deepEqual(templatePixelSize({ width: 2, height: 6 }), { width: 600, height: 1800 });
});

test("dpi default dipakai kalau tidak disebut", () => {
  assert.equal(templatePixelSize({ width: 4, height: 6 }).width, 4 * TEMPLATE_DPI_DEFAULT);
});

test("A4 8.27×11.69 @300 dpi dibulatkan ke piksel bulat", () => {
  const pixels = templatePixelSize({ width: 8.27, height: 11.69, dpi: 300 });
  assert.deepEqual(pixels, { width: 2481, height: 3507 });
});

test("template di atas batas piksel ditandai terlalu besar", () => {
  assert.equal(isTemplateTooLarge({ width: 2, height: 6 }), false);
  assert.equal(isTemplateTooLarge({ width: 30, height: 30, dpi: 600 }), true);
});

test("substituteTokens mengganti token yang dikenal", () => {
  const text = "{event} — {date} {time}";
  const result = substituteTokens(text, {
    event: "Pesta Ulang Tahun",
    date: "12 Oktober 2026",
    time: "19:30",
  });
  assert.equal(result, "Pesta Ulang Tahun — 12 Oktober 2026 19:30");
});

test("token tak dikenal dibiarkan apa adanya, bukan dihapus", () => {
  assert.equal(substituteTokens("{nggak_sengaja}", { event: "x" }), "{nggak_sengaja}");
});

test("token tanpa nilai jadi string kosong", () => {
  assert.equal(substituteTokens("[{custom}]", {}), "[]");
});

test("extractTokens mengembalikan token unik sesuai urutan kemunculan", () => {
  assert.deepEqual(extractTokens("{date} {event} {date}"), ["date", "event"]);
  assert.deepEqual(extractTokens("tanpa token"), []);
  assert.equal(hasTokens("{time}"), true);
});

test("slugify membersihkan tanda baca dan spasi", () => {
  assert.equal(slugify("Pesta Ulang Tahun 2026!"), "pesta-ulang-tahun-2026");
  assert.equal(slugify("  ---  "), "");
  assert.equal(slugify("Café & Crème"), "cafe-creme");
});

test("exportFilename memuat nama, tanggal, dan ukuran piksel", () => {
  const name = exportFilename(
    "Strip 2×6",
    { event: "Pesta Ulang Tahun" },
    { width: 600, height: 1800 },
    "png",
    new Date("2026-10-12T19:30:00Z"),
  );
  assert.equal(name, "strip-2-6-pesta-ulang-tahun-2026-10-12-600x1800.png");
});

test("exportFilename tetap rapi kalau nama template kosong", () => {
  const name = exportFilename("!!!", {}, { width: 1200, height: 1800 }, "jpeg", new Date("2026-01-02T00:00:00Z"));
  assert.equal(name, "template-2026-01-02-1200x1800.jpeg");
});
