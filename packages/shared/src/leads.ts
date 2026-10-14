/**
 * Leads (Fase 9) — logika murni: bentuk field, validasi, dan ekspor CSV.
 *
 * Kenapa dipisah dari route: yang gampang salah di modul leads bukan menyimpan
 * barisnya, tapi **memutuskan apa yang sah**. Nomor HP Indonesia, field wajib
 * yang kosong, `select` yang isinya di luar daftar pilihan, dan escape CSV
 * (koma, kutip, baris baru di dalam catatan) semuanya keputusan yang bisa
 * diuji tanpa HTTP maupun browser.
 *
 * Aturan yang dijaga di sini:
 *
 *   · **Consent adalah bagian dari data, bukan flag UI.** Teks consent yang
 *     disetujui ikut disimpan apa adanya beserta versinya — kalau teksnya
 *     berubah tahun depan, kita masih bisa membuktikan tamu menyetujui versi
 *     yang mana. Ini syarat UU PDP, bukan kerapian.
 *   · **Field yang tidak dikenal diabaikan, bukan ditolak.** Form yang
 *     ter-cache di HP tamu bisa mengirim field yang sudah dihapus operator;
 *     menolaknya berarti tamu tidak bisa mengirim data sama sekali.
 *   · **Kunci field diturunkan dari label, sekali.** Setelah tersimpan, `key`
 *     tidak pernah berubah walau labelnya disunting — kalau tidak, nilai yang
 *     sudah terkumpul kehilangan artinya.
 */

export const LEAD_FIELD_TYPES = ["text", "email", "phone", "select", "checkbox"] as const;
export type LeadFieldType = (typeof LEAD_FIELD_TYPES)[number];

export function isLeadFieldType(value: string): value is LeadFieldType {
  return (LEAD_FIELD_TYPES as readonly string[]).includes(value);
}

/** Definisi satu field yang ditanyakan ke tamu. */
export interface LeadField {
  id: string;
  /** `null` = field berlaku untuk semua event. */
  eventId: string | null;
  key: string;
  label: string;
  type: LeadFieldType;
  required: boolean;
  /** Pilihan untuk `type: "select"`; kosong untuk tipe lain. */
  options: string[];
  helpText: string | null;
  sortOrder: number;
  active: boolean;
  createdAt: string;
}

/** Nilai yang dikirim tamu: teks, atau boolean untuk checkbox. */
export type LeadValue = string | boolean;

export interface Lead {
  id: string;
  eventId: string | null;
  galleryId: string | null;
  values: Record<string, LeadValue>;
  consent: boolean;
  consentText: string;
  consentVersion: string;
  source: string;
  createdAt: string;
}

/**
 * Teks consent bawaan (UU PDP No. 27/2022).
 *
 * Ditulis lengkap di sini — bukan di locale UI — supaya yang tersimpan di DB
 * adalah kalimat yang benar-benar disetujui, bukan kunci terjemahan yang
 * artinya bisa berubah tanpa jejak.
 */
export const LEAD_CONSENT_TEXT =
  "Saya setuju data yang saya isi disimpan oleh penyelenggara acara untuk " +
  "keperluan pengiriman foto dan informasi acara. Saya paham data ini bisa " +
  "dihapus kapan saja dengan menghubungi penyelenggara (UU PDP No. 27/2022).";

/** Versi teks consent. Naikkan kalau kalimatnya berubah. */
export const LEAD_CONSENT_VERSION = "1";

/** Kebijakan retensi: lead lebih tua dari ini dibuang otomatis. */
export const LEAD_RETENTION_DAYS = 180;

/** Panjang maksimum satu nilai teks yang disimpan. */
export const LEAD_VALUE_MAX = 300;

/**
 * Kunci field dari label: huruf kecil, non-alfanumerik jadi `_`.
 *
 * Sengaja tidak memakai indeks urutan atau id acak: operator yang menambah
 * field "Nomor WhatsApp" mengharapkan kolom CSV bernama `nomor_whatsapp`.
 */
export function normalizeFieldKey(label: string, max = 40): string {
  const cleaned = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
  return cleaned === "" ? "field" : cleaned;
}

/* ---- Validasi nilai ------------------------------------------------ */

/** Alamat email: satu `@`, ada isi di kedua sisi, ada titik di domain. */
export function isEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(trimmed);
}

/**
 * Nomor HP Indonesia atau internasional.
 *
 * Menerima `08xx`, `+628xx`, `628xx`, dan bentuk bertanda hubung/spasi —
 * operator mengetik nomor apa adanya dari WhatsApp, jadi menolak format yang
 * lazim cuma bikin tamu kesal. Yang ditolak: terlalu pendek/panjang, dan
 * karakter yang bukan digit setelah pemisah dibuang.
 */
export function isPhone(value: string): boolean {
  const digits = value.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(digits)) return false;
  const bare = digits.replace(/^\+/, "");
  if (bare.startsWith("62")) return bare.length >= 10 && bare.length <= 15;
  if (bare.startsWith("0")) return bare.length >= 9 && bare.length <= 14;
  return bare.length >= 8 && bare.length <= 15;
}

export interface LeadFieldError {
  key: string;
  message: string;
}

export interface LeadValidation {
  ok: boolean;
  errors: LeadFieldError[];
  /** Nilai yang sudah dinormalisasi (trim, boolean, hanya field yang dikenal). */
  values: Record<string, LeadValue>;
}

/**
 * Validasi nilai tamu terhadap definisi field.
 *
 * `fields` sebaiknya hanya field **aktif** — field yang dinonaktifkan operator
 * tetap tersimpan di DB (supaya nilai lama tidak kehilangan label), tapi tidak
 * lagi diminta.
 */
export function validateLeadValues(
  fields: readonly LeadField[],
  raw: Record<string, unknown>,
): LeadValidation {
  const errors: LeadFieldError[] = [];
  const values: Record<string, LeadValue> = {};

  for (const field of fields) {
    const input = raw[field.key];

    if (field.type === "checkbox") {
      // `"1"` ikut diterima: `<input type=checkbox value="1">` (yang dirender
      // halaman galeri) mengirim "1", bukan "on" seperti bawaan HTML.
      const checked = input === true || input === "true" || input === "on" || input === "1";
      values[field.key] = checked;
      if (field.required && !checked) {
        errors.push({ key: field.key, message: `${field.label} harus dicentang` });
      }
      continue;
    }

    const text = typeof input === "string" ? input.trim() : "";
    if (text.length > LEAD_VALUE_MAX) {
      errors.push({ key: field.key, message: `${field.label} terlalu panjang` });
      continue;
    }

    if (text === "") {
      values[field.key] = "";
      if (field.required) errors.push({ key: field.key, message: `${field.label} wajib diisi` });
      continue;
    }

    if (field.type === "email" && !isEmail(text)) {
      errors.push({ key: field.key, message: `${field.label} bukan alamat email yang sah` });
      continue;
    }

    if (field.type === "phone" && !isPhone(text)) {
      errors.push({ key: field.key, message: `${field.label} bukan nomor telepon yang sah` });
      continue;
    }

    if (field.type === "select" && !field.options.includes(text)) {
      errors.push({ key: field.key, message: `${field.label}: pilihan tidak dikenal` });
      continue;
    }

    values[field.key] = text;
  }

  return { ok: errors.length === 0, errors, values };
}

/** Apakah field ini perlu ditanyakan untuk event tertentu. */
export function fieldAppliesTo(field: LeadField, eventId: string | null): boolean {
  return field.active && (field.eventId === null || field.eventId === eventId);
}

/** Field yang berlaku, terurut untuk ditampilkan. */
export function activeFieldsFor(fields: readonly LeadField[], eventId: string | null): LeadField[] {
  return fields
    .filter((field) => fieldAppliesTo(field, eventId))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

/* ---- Ekspor CSV ---------------------------------------------------- */

/**
 * Satu sel CSV.
 *
 * Selalu dikutip: nilai dari tamu bisa memuat koma, tanda kutip, atau baris
 * baru, dan satu nilai tanpa kutip yang memuat koma menggeser seluruh kolom di
 * bawahnya. Kutip ganda di-escape dengan menggandakannya (RFC 4180).
 */
export function csvEscape(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Baris pertama CSV: kolom tetap + label tiap field. */
export function csvHeader(fields: readonly LeadField[]): string[] {
  return ["waktu", "nama_acara", "galeri", "consent", "versi_consent", ...fields.map((f) => f.label)];
}

/**
 * CSV lengkap dari daftar lead.
 *
 * `eventNames` / `galleryLabels` opsional: kalau tidak diisi, kolomnya berisi
 * id apa adanya. Nilai yang tidak ada ditulis sebagai sel kosong, bukan
 * `undefined` — spreadsheet menampilkan `undefined` sebagai teks.
 */
export function buildLeadsCsv(
  fields: readonly LeadField[],
  leads: readonly Lead[],
  labels: { eventNames?: Record<string, string>; galleryLabels?: Record<string, string> } = {},
): string {
  const lines = [csvHeader(fields).map(csvEscape).join(",")];

  for (const lead of leads) {
    const cells: string[] = [
      lead.createdAt,
      lead.eventId === null ? "" : (labels.eventNames?.[lead.eventId] ?? lead.eventId),
      lead.galleryId === null ? "" : (labels.galleryLabels?.[lead.galleryId] ?? lead.galleryId),
      lead.consent ? "ya" : "tidak",
      lead.consentVersion,
    ];

    for (const field of fields) {
      const value = lead.values[field.key];
      if (value === undefined) cells.push("");
      else if (typeof value === "boolean") cells.push(value ? "ya" : "tidak");
      else cells.push(value);
    }

    lines.push(cells.map(csvEscape).join(","));
  }

  // Baris baru di akhir: banyak parser (dan `cat`) memperlakukan baris terakhir
  // tanpa newline sebagai baris yang terpotong.
  return `${lines.join("\r\n")}\r\n`;
}

/** Batas retensi: lead yang `createdAt`-nya lebih tua dari ini boleh dibuang. */
export function retentionCutoff(now: Date, days: number = LEAD_RETENTION_DAYS): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}
