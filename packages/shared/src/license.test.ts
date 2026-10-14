/**
 * Tes lisensi & order (Fase 10).
 *
 * Fokus: **hal-hal yang bikin lisensi hidup lebih lama dari seharusnya** —
 * tanggal rusak, transisi status mundur, dan kode aktivasi yang mirip. Ketiga
 * hal itu tidak terlihat salah di layar, tapi membuat pemilik produk kehilangan
 * pendapatan atau operator kehilangan waktu di depan klien.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVATION_ALPHABET,
  ACTIVATION_CODE_LENGTH,
  LICENSE_CATALOG,
  LICENSE_SKU_IDS,
  LIVE_ORDER_PROVIDERS,
  ORDER_PROVIDERS,
  ORDER_STATUSES,
  ORDER_TERMINAL_STATUSES,
  ORDER_TTL_MINUTES,
  PLAN_LIMITS,
  TRIAL_DAYS,
  activationCodeRedeemable,
  activationCodeState,
  canTransitionOrder,
  evaluateLicense,
  findSku,
  formatActivationCode,
  formatIdr,
  isActivationCode,
  isLicenseSkuId,
  isOrderProvider,
  isOrderProviderLive,
  isOrderSettled,
  isOrderStatus,
  normalizeActivationCode,
  orderExpiresAt,
  planAllowsGallery,
  planLimits,
  trialExpiresAt,
  type ActivationCode,
} from "./license.ts";
import { PAYMENT_PROVIDERS, type Entitlement } from "./schemas.ts";

const NOW = new Date("2026-10-14T00:00:00.000Z");

function entitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    id: "ent_1",
    email: "operator@example.com",
    plan: "personal",
    status: "active",
    maxActiveGalleries: 3,
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

/* Katalog ---------------------------------------------------------- */

test("setiap SKU punya entri katalog", () => {
  // Katalog bertipe Record<LicenseSkuId, …>, jadi ini menjaga id baru tidak
  // lolos tanpa harga/nama saat refactor.
  for (const sku of LICENSE_SKU_IDS) {
    assert.equal(LICENSE_CATALOG[sku].sku, sku);
    assert.ok(LICENSE_CATALOG[sku].priceIdr > 0);
    assert.ok(LICENSE_CATALOG[sku].name.length > 0);
  }
});

test("findSku mengembalikan null untuk SKU asing", () => {
  assert.equal(findSku("booth-commercial")?.plan, "commercial");
  assert.equal(findSku("booth-gratis"), null);
  assert.equal(isLicenseSkuId("booth-personal"), true);
  assert.equal(isLicenseSkuId("booth-personal "), false);
});

/* Siklus hidup order ----------------------------------------------- */

test("transisi maju diizinkan", () => {
  assert.equal(canTransitionOrder("created", "pending"), true);
  assert.equal(canTransitionOrder("pending", "paid"), true);
  assert.equal(canTransitionOrder("paid", "refunded"), true);
});

test("order yang sudah final tidak bisa hidup lagi", () => {
  // Webhook yang datang terlambat/duplikat tidak boleh menghidupkan kembali
  // lisensi yang dananya sudah dikembalikan.
  assert.equal(canTransitionOrder("refunded", "paid"), false);
  assert.equal(canTransitionOrder("expired", "paid"), false);
  assert.equal(canTransitionOrder("failed", "pending"), false);
  assert.equal(canTransitionOrder("paid", "pending"), false);
});

test("status final dikenali", () => {
  assert.deepEqual([...ORDER_TERMINAL_STATUSES].sort(), ["expired", "failed", "refunded"]);
  assert.equal(isOrderSettled("refunded"), true);
  assert.equal(isOrderSettled("paid"), false);
  assert.equal(isOrderStatus("pending"), true);
  assert.equal(isOrderStatus("lunas"), false);
  assert.equal(ORDER_STATUSES.length, 6);
});

test("provider order adalah himpunan bagian provider pembayaran", () => {
  // Dua daftar yang bercabang berarti order bisa dibuat dengan provider yang
  // tidak dikenal setelan booking, dan kolomnya berisi nilai yang tidak bisa
  // ditafsirkan siapa pun.
  for (const provider of ORDER_PROVIDERS) {
    assert.equal(PAYMENT_PROVIDERS.includes(provider), true, `${provider} tidak ada di PAYMENT_PROVIDERS`);
  }
  assert.equal((ORDER_PROVIDERS as readonly string[]).includes("none"), false);
  assert.equal(isOrderProvider("qris"), true);
  assert.equal(isOrderProvider("none"), false);
});

test("order pending kedaluwarsa setelah TTL", () => {
  const created = new Date("2026-10-14T00:00:00.000Z");
  const expires = orderExpiresAt(created);
  assert.equal(expires.getTime() - created.getTime(), ORDER_TTL_MINUTES * 60_000);
});

/* Penilaian lisensi ------------------------------------------------ */

test("tanpa lisensi: tidak boleh, dengan alasan", () => {
  const verdict = evaluateLicense(null, NOW);
  assert.equal(verdict.state, "none");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.daysLeft, null);
  assert.ok(verdict.reason !== null);
});

test("lisensi aktif tanpa kedaluwarsa selalu boleh", () => {
  const verdict = evaluateLicense(entitlement({ expiresAt: null }), NOW);
  assert.equal(verdict.state, "active");
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.daysLeft, null);
  assert.equal(verdict.reason, null);
});

test("sisa waktu dibulatkan ke atas", () => {
  // 6 jam tersisa harus terbaca "1 hari lagi", bukan "0 hari lagi" — yang
  // terakhir terbaca seperti sudah habis.
  const sixHours = new Date(NOW.getTime() + 6 * 60 * 60 * 1000).toISOString();
  const verdict = evaluateLicense(entitlement({ expiresAt: sixHours }), NOW);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.daysLeft, 1);
});

test("lisensi yang sudah lewat ditolak", () => {
  const verdict = evaluateLicense(entitlement({ expiresAt: "2026-10-13T23:59:59.000Z" }), NOW);
  assert.equal(verdict.state, "expired");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.daysLeft, 0);
});

test("tanggal rusak TIDAK jatuh ke aktif", () => {
  // Ini kesalahan yang paling mahal: `new Date("x")` menghasilkan NaN, dan
  // perbandingan NaN > 0 bernilai false, jadi lisensi rusak bisa lolos hidup.
  const verdict = evaluateLicense(entitlement({ expiresAt: "bukan-tanggal" }), NOW);
  assert.equal(verdict.state, "expired");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.daysLeft, null);
});

test("status revoked menang atas tanggal yang masih jauh", () => {
  const verdict = evaluateLicense(entitlement({ status: "revoked" }), NOW);
  assert.equal(verdict.state, "revoked");
  assert.equal(verdict.allowed, false);
});

test("status expired dihormati walau tanggal masih depan", () => {
  const verdict = evaluateLicense(entitlement({ status: "expired" }), NOW);
  assert.equal(verdict.state, "expired");
  assert.equal(verdict.allowed, false);
});

test("masa uji coba dihitung dari penerbitan", () => {
  const issued = new Date("2026-10-14T00:00:00.000Z");
  const expires = trialExpiresAt(issued);
  assert.equal((expires.getTime() - issued.getTime()) / (24 * 60 * 60 * 1000), TRIAL_DAYS);
});

/* Batas per plan --------------------------------------------------- */

test("plan komersial tanpa batas galeri dan boleh white-label", () => {
  assert.equal(planLimits("commercial").maxActiveGalleries, null);
  assert.equal(planLimits("commercial").allowsWhiteLabel, true);
  assert.equal(planLimits("commercial").allowsCommercialUse, true);
});

test("plan personal tidak boleh white-label", () => {
  assert.equal(planLimits("personal").allowsWhiteLabel, false);
  assert.equal(planLimits("personal").allowsCommercialUse, false);
  assert.equal(planLimits("personal").maxActiveGalleries, 3);
});

test("trial dibatasi paling ketat", () => {
  assert.equal(PLAN_LIMITS.trial.maxActiveGalleries, 1);
  assert.equal(PLAN_LIMITS.trial.allowsWhiteLabel, false);
});

/* Kode aktivasi ---------------------------------------------------- */

test("normalisasi membuang spasi, tanda hubung, dan karakter kontrol", () => {
  // Kode yang disalin dari halaman web sering membawa `\n` di ujungnya.
  assert.equal(normalizeActivationCode("abcd-efgh-jklm"), "ABCDEFGHJKLM");
  assert.equal(normalizeActivationCode(" ABCD EFGH JKLM\n"), "ABCDEFGHJKLM");
  assert.equal(normalizeActivationCode("ABCD\u0000EFGHJKLM"), "ABCDEFGHJKLM");
});

test("kode sah dikenali", () => {
  assert.equal(isActivationCode("ABCD-EFGH-JKLM"), true);
  assert.equal(isActivationCode("abcdefghjklm"), true);
});

test("kode dengan karakter mirip atau panjang salah ditolak", () => {
  // I/O/0/1 sengaja tidak ada di alfabet: kode dibacakan dari invoice kertas.
  assert.equal(isActivationCode("ABCD-EFGH-JKL0"), false);
  assert.equal(isActivationCode("ABCD-EFGH-JKLI"), false);
  assert.equal(isActivationCode("ABCD-EFGH-JKL"), false);
  assert.equal(isActivationCode("ABCD-EFGH-JKLMN"), false);
  assert.equal(isActivationCode(""), false);
});

test("alfabet kode bebas karakter yang mirip", () => {
  assert.equal(ACTIVATION_ALPHABET.length, 32);
  for (const char of ["I", "O", "0", "1"]) {
    assert.equal(ACTIVATION_ALPHABET.includes(char), false);
  }
  assert.equal(ACTIVATION_CODE_LENGTH, 12);
});

test("format kode memakai pemisah tiap empat karakter", () => {
  assert.equal(formatActivationCode("abcdefghjklm"), "ABCD-EFGH-JKLM");
  // Sisa yang tidak pas empat tidak boleh diakhiri tanda hubung.
  assert.equal(formatActivationCode("abcd"), "ABCD");
  assert.equal(formatActivationCode("abcde"), "ABCD-E");
});

/* Rupiah ----------------------------------------------------------- */

test("format rupiah memakai titik ribuan", () => {
  assert.equal(formatIdr(1_500_000), "Rp1.500.000");
  assert.equal(formatIdr(3_500_000), "Rp3.500.000");
  assert.equal(formatIdr(0), "Rp0");
  assert.equal(formatIdr(999), "Rp999");
  assert.equal(formatIdr(1000), "Rp1.000");
  assert.equal(formatIdr(1_234_567_890), "Rp1.234.567.890");
});

test("format rupiah membulatkan dan menangani negatif", () => {
  assert.equal(formatIdr(1500.4), "Rp1.500");
  assert.equal(formatIdr(1500.6), "Rp1.501");
  assert.equal(formatIdr(-2500), "-Rp2.500");
});

/* Status kode aktivasi --------------------------------------------- */

function code(overrides: Partial<ActivationCode> = {}): ActivationCode {
  return {
    code: "ABCDEFGHJKLM",
    orderId: "ord_1",
    plan: "personal",
    maxActiveGalleries: 3,
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2027-10-01T00:00:00.000Z",
    redeemedAt: null,
    redeemedBy: null,
    revokedAt: null,
    ...overrides,
  };
}

test("kode segar bisa ditebus", () => {
  const state = activationCodeState(code(), NOW);
  assert.equal(state, "unredeemed");
  assert.equal(activationCodeRedeemable(code(), NOW), true);
});

test("kode yang sudah ditebus tetap 'redeemed' walau tanggalnya lewat", () => {
  // Kalau tanggal diperiksa lebih dulu, panel menampilkan kode yang sudah
  // dipakai sebagai "kedaluwarsa" — dan operator mengira pelanggan belum
  // aktivasi, lalu menerbitkan kode kedua.
  const used = code({ redeemedAt: "2026-10-05T00:00:00.000Z", expiresAt: "2026-10-06T00:00:00.000Z" });
  assert.equal(activationCodeState(used, NOW), "redeemed");
  assert.equal(activationCodeRedeemable(used, NOW), false);
});

test("kode dicabut menang atas tanggal yang masih jauh", () => {
  const revoked = code({ revokedAt: "2026-10-10T00:00:00.000Z" });
  assert.equal(activationCodeState(revoked, NOW), "revoked");
  assert.equal(activationCodeRedeemable(revoked, NOW), false);
});

test("kode lewat tanggal tidak bisa ditebus", () => {
  const stale = code({ expiresAt: "2026-10-13T00:00:00.000Z" });
  assert.equal(activationCodeState(stale, NOW), "expired");
});

test("tanggal kode rusak dianggap kedaluwarsa, bukan seumur hidup", () => {
  const broken = code({ expiresAt: "bukan-tanggal" });
  assert.equal(activationCodeState(broken, NOW), "expired");
});

test("kode tanpa kedaluwarsa tetap bisa ditebus", () => {
  const perpetual = code({ expiresAt: null });
  assert.equal(activationCodeState(perpetual, NOW), "unredeemed");
});

/* ---- Provider order: tercatat vs benar-benar jalan ---------------- */

test("provider order yang tercatat tapi belum hidup dikenali", () => {
  // Dua pertanyaan berbeda: kolom `provider` boleh berisi `qris` (bentuk
  // datanya sudah final), tapi route harus menjawab 501 — bukan membuat
  // order yang menggantung di status yang tidak pernah bisa dibayar.
  for (const p of ORDER_PROVIDERS) assert.equal(isOrderProvider(p), true);
  assert.equal(isOrderProviderLive("manual"), true);
  assert.equal(isOrderProviderLive("qris"), false);
  assert.equal(isOrderProvider("none"), false, "`none` milik booking, bukan order lisensi");
});

test("provider order hidup selalu himpunan bagian ORDER_PROVIDERS", () => {
  for (const p of LIVE_ORDER_PROVIDERS) {
    assert.equal(isOrderProvider(p), true, `${p} harus ada di ORDER_PROVIDERS`);
  }
});

/* ---- Batas galeri per plan --------------------------------------- */

test("plan tanpa batas selalu boleh menambah galeri", () => {
  const commercial = planLimits("commercial");
  assert.equal(commercial.maxActiveGalleries, null);
  assert.equal(planAllowsGallery(commercial, 0), true);
  assert.equal(planAllowsGallery(commercial, 10_000), true);
});

test("plan berbatas menolak tepat saat kuota habis, bukan setelahnya", () => {
  const personal = planLimits("personal");
  assert.equal(personal.maxActiveGalleries, 3);
  assert.equal(planAllowsGallery(personal, 2), true, "slot terakhir masih boleh dipakai");
  assert.equal(planAllowsGallery(personal, 3), false, "kuota habis → tolak");
  assert.equal(planAllowsGallery(personal, 4), false);

  const trial = planLimits("trial");
  assert.equal(trial.maxActiveGalleries, 1);
  assert.equal(planAllowsGallery(trial, 0), true);
  assert.equal(planAllowsGallery(trial, 1), false);
});

test("PLAN_LIMITS konsisten: white-label & pemakaian komersial hanya di komersial", () => {
  for (const plan of ["trial", "personal"] as const) {
    assert.equal(PLAN_LIMITS[plan].allowsWhiteLabel, false, `${plan} bukan white-label`);
    assert.equal(PLAN_LIMITS[plan].allowsCommercialUse, false, `${plan} bukan untuk jasa berbayar`);
  }
  assert.equal(PLAN_LIMITS.commercial.allowsWhiteLabel, true);
  assert.equal(PLAN_LIMITS.commercial.allowsCommercialUse, true);
});
