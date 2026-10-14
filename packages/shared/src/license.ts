/**
 * Lisensi & order (Fase 10, FEATURE-MATRIX #84–#85).
 *
 * Ini bagian **mekanisme**, bukan bagian uangnya. Yang dibangun di sini:
 *
 *   · **Katalog SKU** — apa saja yang bisa dibeli, dan plan entitlement apa
 *     yang didapat pembelinya.
 *   · **Siklus hidup order** — status apa yang boleh berubah ke status apa.
 *     Mesin status ini murni supaya webhook gateway (nanti) tidak bisa
 *     memindahkan order dari `refunded` kembali ke `paid`.
 *   · **Penilaian lisensi** — satu fungsi yang menjawab "boleh dipakai atau
 *     tidak, dan kenapa", dipakai studio maupun API. Kalau aturannya ditulis
 *     dua kali, cepat atau lambat studio akan mengizinkan sesuatu yang ditolak
 *     API.
 *   · **Kode aktivasi** — untuk perangkat yang dibeli offline: kode diketik
 *     operator, tidak butuh jaringan.
 *
 * Yang **tidak** ada di sini: panggilan ke Midtrans/Xendit. Itu disengaja —
 * permintaan pemilik produk adalah membangun UI + mekanismenya dulu tanpa
 * menyambungkan payment gateway. Provider `qris` di API masih stub dan
 * **melempar**, bukan berpura-pura mengembalikan "menunggu pembayaran".
 *
 * Modul ini murni: tidak menyentuh jaringan, jam sistem, atau `window`.
 */

import type { Entitlement, EntitlementPlan } from "./schemas.ts";

/* ================================================================== *
 * Katalog SKU
 * ================================================================== */

export const LICENSE_SKU_IDS = ["booth-personal", "booth-commercial"] as const;
export type LicenseSkuId = (typeof LICENSE_SKU_IDS)[number];

export interface LicenseSku {
  sku: LicenseSkuId;
  name: string;
  /** Plan entitlement yang diberikan SKU ini. */
  plan: EntitlementPlan;
  /** Harga sekali bayar, rupiah penuh (tanpa sen — rupiah tidak memakainya). */
  priceIdr: number;
  blurb: string;
}

/**
 * Katalog bertipe `Record<LicenseSkuId, …>` dengan sengaja.
 *
 * Menambah id di `LICENSE_SKU_IDS` tanpa menambah entri di sini jadi **error
 * kompilasi**, bukan halaman kosong di panel lisensi.
 */
export const LICENSE_CATALOG: Record<LicenseSkuId, LicenseSku> = {
  "booth-personal": {
    sku: "booth-personal",
    name: "Foto Booth — Personal",
    plan: "personal",
    priceIdr: 1_500_000,
    blurb: "Satu booth, satu perangkat, pemakaian sendiri.",
  },
  "booth-commercial": {
    sku: "booth-commercial",
    name: "Foto Booth — Komersial",
    plan: "commercial",
    priceIdr: 3_500_000,
    blurb: "Untuk jasa sewa booth: white-label, galeri tanpa batas, klien tanpa batas.",
  },
};

export function isLicenseSkuId(value: string): value is LicenseSkuId {
  return (LICENSE_SKU_IDS as readonly string[]).includes(value);
}

/** `null` kalau SKU tidak dikenal — pemanggil yang memutuskan jadi 404 atau 400. */
export function findSku(sku: string): LicenseSku | null {
  return isLicenseSkuId(sku) ? LICENSE_CATALOG[sku] : null;
}

/* ================================================================== *
 * Siklus hidup order
 * ================================================================== */

export const ORDER_STATUSES = ["created", "pending", "paid", "expired", "failed", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Provider yang bisa dipakai sebuah **order lisensi**.
 *
 * Sengaja daftar sendiri, bukan `PAYMENT_PROVIDERS` yang dipinjam dari booking:
 * di sana ada `none` (booking tanpa deposit itu sah), sedangkan order lisensi
 * tanpa provider tidak punya arti apa-apa — kalau `none` ikut masuk, route
 * harus menyaringnya sendiri dan cepat atau lambat ada yang lupa.
 *
 * Tes menegaskan daftar ini tetap himpunan bagian dari `PAYMENT_PROVIDERS`,
 * supaya kolom `provider` di dua tabel tidak pernah bercabang.
 */
export const ORDER_PROVIDERS = ["manual", "qris"] as const;
export type OrderProvider = (typeof ORDER_PROVIDERS)[number];

export function isOrderProvider(value: string): value is OrderProvider {
  return (ORDER_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Provider yang **benar-benar** bisa membuat order hari ini.
 *
 * `qris` sudah ada di katalog supaya bentuk datanya tidak berubah lagi saat
 * gateway disambungkan, tapi belum bisa memproses apa pun. Dipisah dari
 * `ORDER_PROVIDERS` karena dua pertanyaan ini berbeda: "provider apa yang
 * boleh tercatat di kolom ini" ≠ "provider apa yang bisa jalan sekarang".
 * Route memakai daftar ini untuk menjawab 501, bukan membuat order yang
 * menggantung di status yang tidak pernah bisa dibayar.
 */
export const LIVE_ORDER_PROVIDERS = ["manual"] as const;

export function isOrderProviderLive(provider: OrderProvider): boolean {
  return (LIVE_ORDER_PROVIDERS as readonly string[]).includes(provider);
}

/** Satu pembelian lisensi. Bentuknya sama di panel operator dan di invoice. */
export interface Order {
  id: string;
  sku: LicenseSkuId;
  /** Nama SKU **saat dibeli** — katalog bisa berubah, invoice lama tidak boleh ikut. */
  skuName: string;
  email: string;
  /** Harga **saat dibeli**, rupiah penuh. */
  amountIdr: number;
  status: OrderStatus;
  provider: OrderProvider;
  /** Kode aktivasi yang diterbitkan setelah lunas; `null` sebelum itu. */
  reference: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  created: "Dibuat",
  pending: "Menunggu pembayaran",
  paid: "Lunas",
  expired: "Kedaluwarsa",
  failed: "Gagal",
  refunded: "Dana dikembalikan",
};

/**
 * Transisi yang sah.
 *
 * `refunded` sengaja **tidak** bisa kembali ke `paid`: webhook gateway yang
 * datang terlambat atau diulang tidak boleh menghidupkan lagi lisensi yang
 * dananya sudah dikembalikan.
 */
const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  created: ["pending", "paid", "expired", "failed"],
  pending: ["paid", "expired", "failed"],
  paid: ["refunded"],
  expired: [],
  failed: [],
  refunded: [],
};

/** Status tanpa jalan keluar — order di sini sudah final. */
export const ORDER_TERMINAL_STATUSES: readonly OrderStatus[] = ["expired", "failed", "refunded"];

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** `true` kalau order ini sudah tidak mungkin berubah lagi. */
export function isOrderSettled(status: OrderStatus): boolean {
  return ORDER_TERMINAL_STATUSES.includes(status);
}

/**
 * Batas waktu order `pending` sebelum slot/harga dilepas.
 *
 * Hanya berlaku untuk order yang benar-benar menunggu pembayaran; order
 * `manual` tidak punya jam — operator bisa mengonfirmasi kapan saja.
 */
export const ORDER_TTL_MINUTES = 60;

export function orderExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + ORDER_TTL_MINUTES * 60_000);
}

/* ================================================================== *
 * Penilaian lisensi
 * ================================================================== */

export type LicenseState = "none" | "active" | "expired" | "revoked";

export interface LicenseVerdict {
  state: LicenseState;
  /** `true` hanya kalau fitur berbayar boleh dipakai **sekarang**. */
  allowed: boolean;
  /** Hari tersisa sampai kedaluwarsa; `null` = tidak kedaluwarsa atau tak ada lisensi. */
  daysLeft: number | null;
  /** Kalimat siap tampil untuk operator; `null` = tidak ada yang perlu diberitahu. */
  reason: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Jawaban tunggal atas "lisensi ini boleh dipakai atau tidak".
 *
 * Yang sengaja dipilih:
 *   · **Tanggal rusak = tidak aktif.** `expiresAt` yang tidak bisa di-parse
 *     tidak boleh jatuh ke "aktif"; itu justru cara paling mudah membuat
 *     lisensi kedaluwarsa tetap hidup.
 *   · **Sisa waktu dibulatkan ke atas.** 6 jam tersisa ditampilkan "1 hari
 *     lagi", bukan "0 hari lagi" — yang terakhir terbaca seperti sudah habis.
 */
export function evaluateLicense(entitlement: Entitlement | null, now: Date): LicenseVerdict {
  if (entitlement === null) {
    return { state: "none", allowed: false, daysLeft: null, reason: "Belum ada lisensi di perangkat ini." };
  }
  if (entitlement.status === "revoked") {
    return { state: "revoked", allowed: false, daysLeft: null, reason: "Lisensi dicabut." };
  }
  if (entitlement.status === "expired") {
    return { state: "expired", allowed: false, daysLeft: 0, reason: "Masa lisensi sudah habis." };
  }
  if (entitlement.expiresAt === null) {
    return { state: "active", allowed: true, daysLeft: null, reason: null };
  }

  const expires = new Date(entitlement.expiresAt).getTime();
  if (!Number.isFinite(expires)) {
    return {
      state: "expired",
      allowed: false,
      daysLeft: null,
      reason: "Tanggal kedaluwarsa tidak terbaca.",
    };
  }

  const remaining = expires - now.getTime();
  if (remaining <= 0) {
    return { state: "expired", allowed: false, daysLeft: 0, reason: "Masa lisensi sudah habis." };
  }
  return { state: "active", allowed: true, daysLeft: Math.ceil(remaining / DAY_MS), reason: null };
}

/** Masa uji coba dari saat lisensi diterbitkan. */
export const TRIAL_DAYS = 14;

export function trialExpiresAt(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + TRIAL_DAYS * DAY_MS);
}

/* ================================================================== *
 * Batas per plan
 * ================================================================== */

export interface PlanLimits {
  /** Galeri aktif sekaligus; `null` = tanpa batas. */
  maxActiveGalleries: number | null;
  /** Boleh menghapus branding "Foto Booth" dan memakai merek sendiri. */
  allowsWhiteLabel: boolean;
  /** Boleh dipakai untuk jasa berbayar (sewa booth ke klien). */
  allowsCommercialUse: boolean;
}

/**
 * Satu tabel, bukan tiga `if` yang tersebar.
 *
 * `maxActiveGalleries` di sini harus cocok dengan yang ditulis ke kolom
 * `entitlements.max_active_galleries`; API memakai fungsi ini untuk mengisinya,
 * jadi tidak ada dua angka yang bisa berbeda.
 */
export const PLAN_LIMITS: Record<EntitlementPlan, PlanLimits> = {
  trial: { maxActiveGalleries: 1, allowsWhiteLabel: false, allowsCommercialUse: false },
  personal: { maxActiveGalleries: 3, allowsWhiteLabel: false, allowsCommercialUse: false },
  commercial: { maxActiveGalleries: null, allowsWhiteLabel: true, allowsCommercialUse: true },
};

export function planLimits(plan: EntitlementPlan): PlanLimits {
  return PLAN_LIMITS[plan];
}

/**
 * Apakah plan ini masih muat satu galeri aktif lagi?
 *
 * Dipisah dari `PlanLimits` karena pertanyaannya berbeda: tabel di atas
 * menjawab "plan ini batasnya berapa", fungsi ini menjawab "dengan N galeri
 * aktif, masih boleh nambah?". Tanpa fungsi ini, `maxActiveGalleries` cuma
 * angka yang tersimpan rapi di DB dan tidak pernah menolak apa pun — dan itu
 * jenis bug yang tidak kelihatan sampai ada pelanggan yang memakai lebih dari
 * yang dibayarnya.
 */
export function planAllowsGallery(limits: PlanLimits, activeGalleries: number): boolean {
  if (limits.maxActiveGalleries === null) return true;
  return activeGalleries < limits.maxActiveGalleries;
}

/* ================================================================== *
 * Kode aktivasi
 * ================================================================== */

/** Panjang kode setelah pemisah dibuang. */
export const ACTIVATION_CODE_LENGTH = 12;

/**
 * Alfabet tanpa `I`, `O`, `0`, `1`.
 *
 * Kode ini dibacakan operator dari invoice kertas atau diketik ulang dari
 * WhatsApp; karakter yang mirip satu sama lain adalah sumber kegagalan yang
 * tidak perlu ada.
 */
export const ACTIVATION_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Buang spasi, tanda hubung, dan karakter kontrol; jadikan huruf besar.
 *
 * Karakter kontrol dibuang, bukan diganti spasi: kode yang disalin dari
 * halaman web sering membawa `\n` di ujungnya, dan kalau itu jadi spasi maka
 * kode yang terlihat benar tetap ditolak.
 */
export function normalizeActivationCode(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
  );
}

/** `true` kalau kode (setelah dinormalkan) berbentuk kode yang sah. */
export function isActivationCode(raw: string): boolean {
  const code = normalizeActivationCode(raw);
  if (code.length !== ACTIVATION_CODE_LENGTH) return false;
  for (const char of code) {
    if (!ACTIVATION_ALPHABET.includes(char)) return false;
  }
  return true;
}

/** Bentuk tampilan `ABCD-EFGH-JKLM`; dipakai panel lisensi & invoice. */
export function formatActivationCode(code: string): string {
  return normalizeActivationCode(code).replace(/(.{4})(?=.)/g, "$1-");
}

/* ================================================================== *
 * Kode aktivasi — entri tersimpan
 * ================================================================== */

/**
 * Satu kode aktivasi yang tersimpan di server.
 *
 * `code` selalu bentuk ternormalisasi (`normalizeActivationCode`), tanpa tanda
 * hubung — kalau yang tersimpan adalah bentuk tampilan, dua kode yang sama
 * secara visual bisa tersimpan sebagai dua baris berbeda.
 */
export interface ActivationCode {
  code: string;
  /** Order yang menerbitkan kode ini; `null` kalau ordernya sudah dihapus. */
  orderId: string | null;
  plan: EntitlementPlan;
  maxActiveGalleries: number | null;
  issuedAt: string;
  expiresAt: string | null;
  redeemedAt: string | null;
  /** Email perangkat yang menebus; `null` selama belum ditebus. */
  redeemedBy: string | null;
  revokedAt: string | null;
}

export type ActivationState = "unredeemed" | "redeemed" | "revoked" | "expired";

/**
 * Status sebuah kode — satu fungsi, dipakai route dan panel.
 *
 * Urutan pemeriksaannya penting: kode yang **dicabut** tetap `revoked` walau
 * tanggalnya masih jauh, dan kode yang **sudah ditebus** tetap `redeemed` walau
 * masa berlakunya habis. Kalau tanggal diperiksa lebih dulu, panel akan
 * menampilkan kode yang sudah dipakai sebagai "kedaluwarsa" — dan operator
 * mengira pelanggannya belum aktivasi.
 */
export function activationCodeState(code: ActivationCode, now: Date): ActivationState {
  if (code.revokedAt !== null) return "revoked";
  if (code.redeemedAt !== null) return "redeemed";
  if (code.expiresAt !== null) {
    const expires = new Date(code.expiresAt).getTime();
    // Tanggal rusak diperlakukan kedaluwarsa, bukan seumur hidup.
    if (!Number.isFinite(expires) || expires <= now.getTime()) return "expired";
  }
  return "unredeemed";
}

/** `true` kalau kode ini masih bisa ditebus sekarang. */
export function activationCodeRedeemable(code: ActivationCode, now: Date): boolean {
  return activationCodeState(code, now) === "unredeemed";
}

/* ================================================================== *
 * Rupiah
 * ================================================================== */

/**
 * Format rupiah tanpa `Intl`.
 *
 * `Intl.NumberFormat("id-ID")` bergantung pada data locale yang tersedia di
 * build Node; di image minimal bisa menghasilkan format berbeda. Karena angka
 * ini masuk ke instruksi pembayaran dan invoice yang dibaca manusia, hasilnya
 * harus sama di mana pun.
 */
export function formatIdr(amount: number): string {
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? "-" : "";
  const digits = String(Math.abs(rounded));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
    out += digits[i];
  }
  return `${sign}Rp${out}`;
}
