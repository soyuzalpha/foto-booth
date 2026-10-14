/**
 * Tes branding (Fase 9).
 *
 * Yang diuji bukan tampilan, tapi **nilai apa yang keluar setelah dinormalkan**.
 * `heading` dan `logoUrl` dari operator dirender ke HTML halaman tamu, jadi
 * satu nilai yang lolos berarti satu vektor di browser semua tamu.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BRANDING_FOOTER_MAX,
  BRANDING_HEADING_MAX,
  BRANDING_LOGO_URL_MAX,
  BRANDING_SUBHEADING_MAX,
  DEFAULT_BRANDING,
  brandingIsDefault,
  normalizeBranding,
  normalizeLogoUrl,
  resolvedHeading,
  resolvedSubheading,
} from "./branding.ts";

test("nilai rusak jadi default, bukan error", () => {
  assert.deepEqual(normalizeBranding(null), DEFAULT_BRANDING);
  assert.deepEqual(normalizeBranding("bukan objek"), DEFAULT_BRANDING);
  assert.deepEqual(normalizeBranding({ heading: 42, logoUrl: [] }), DEFAULT_BRANDING);
});

test("logo: hanya http(s) dan data:image yang lolos", () => {
  assert.equal(normalizeLogoUrl("https://cdn.example/logo.png"), "https://cdn.example/logo.png");
  assert.equal(normalizeLogoUrl("http://localhost:5173/logo.svg"), "http://localhost:5173/logo.svg");
  assert.equal(normalizeLogoUrl("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");

  // Yang berbahaya ditolak — nilainya masuk HTML halaman tamu.
  assert.equal(normalizeLogoUrl("javascript:alert(1)"), null);
  assert.equal(normalizeLogoUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(normalizeLogoUrl("  "), null);
  assert.equal(normalizeLogoUrl("bukan url"), null);
});

test("logo terlalu panjang ditolak, bukan dipotong", () => {
  const long = `https://cdn.example/${"a".repeat(BRANDING_LOGO_URL_MAX)}.png`;
  assert.equal(normalizeLogoUrl(long), null);
});

test("teks: karakter kontrol dibuang, spasi dirapikan, panjang dipotong", () => {
  const branding = normalizeBranding({
    heading: "  Pernikahan\nAsep   &   Rina  ",
    subheading: "x".repeat(BRANDING_SUBHEADING_MAX + 50),
    footer: "Terima kasih\u0000",
  });

  // Baris baru di heading memutus atribut HTML kalau dibiarkan.
  assert.equal(branding.heading, "Pernikahan Asep & Rina");
  assert.equal(branding.subheading.length, BRANDING_SUBHEADING_MAX);
  assert.equal(branding.footer, "Terima kasih");
  // Catatan kaki juga dibatasi, bukan hanya heading/subheading.
  assert.equal(
    normalizeBranding({ footer: "f".repeat(BRANDING_FOOTER_MAX + 5) }).footer.length,
    BRANDING_FOOTER_MAX,
  );
});

test("heading melebihi batas dipotong tepat di batas", () => {
  const branding = normalizeBranding({ heading: "h".repeat(BRANDING_HEADING_MAX + 10) });
  assert.equal(branding.heading.length, BRANDING_HEADING_MAX);
});

test("brandingIsDefault: satu bidang terisi sudah bukan default", () => {
  assert.equal(brandingIsDefault(DEFAULT_BRANDING), true);
  assert.equal(brandingIsDefault({ ...DEFAULT_BRANDING, heading: "Halo" }), false);
  assert.equal(
    brandingIsDefault({ ...DEFAULT_BRANDING, logoUrl: "https://x.example/l.png" }),
    false,
  );
});

test("resolvedHeading: heading → nama acara → nama aplikasi", () => {
  assert.equal(resolvedHeading({ ...DEFAULT_BRANDING, heading: "Kita" }, "Acara"), "Kita");
  assert.equal(resolvedHeading(DEFAULT_BRANDING, "Acara"), "Acara");
  // Acara tanpa nama tidak menghasilkan judul kosong.
  assert.equal(resolvedHeading(DEFAULT_BRANDING, null), "Foto Booth");
  assert.equal(resolvedHeading(DEFAULT_BRANDING, "   "), "Foto Booth");
});

test("resolvedSubheading: isian operator menang, kalau kosong pakai acara", () => {
  assert.equal(
    resolvedSubheading({ ...DEFAULT_BRANDING, subheading: "Custom" }, { name: "A", date: "2026-01-01", hashtag: null }),
    "Custom",
  );
  assert.equal(
    resolvedSubheading(DEFAULT_BRANDING, { name: "A", date: "2026-01-01", hashtag: "#a" }),
    "A · 2026-01-01 · #a",
  );
  assert.equal(
    resolvedSubheading(DEFAULT_BRANDING, { name: "A", date: "2026-01-01", hashtag: "  " }),
    "A · 2026-01-01",
  );
  assert.equal(resolvedSubheading(DEFAULT_BRANDING, null), "");
});
