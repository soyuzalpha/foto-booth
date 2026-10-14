/**
 * Tes logika murni leads (Fase 9).
 *
 * Yang diuji di sini bukan penyimpanan, tapi **keputusan**: apa yang dianggap
 * sah, apa yang diabaikan, dan apa yang keluar saat diekspor. Ini bagian yang
 * paling mahal kalau salah — nomor telepon yang ditolak membuat tamu tidak bisa
 * mengirim data, dan CSV yang salah kutip membuat kolom bergeser di Excel
 * tanpa error apa pun.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LEAD_CONSENT_VERSION,
  LEAD_RETENTION_DAYS,
  LEAD_VALUE_MAX,
  activeFieldsFor,
  buildLeadsCsv,
  csvEscape,
  csvHeader,
  fieldAppliesTo,
  isEmail,
  isLeadFieldType,
  isPhone,
  normalizeFieldKey,
  retentionCutoff,
  validateLeadValues,
  type Lead,
  type LeadField,
} from "./leads.ts";

/** Field lengkap dengan bawaan yang wajar; tes hanya menimpa yang penting. */
function field(overrides: Partial<LeadField> = {}): LeadField {
  return {
    id: overrides.id ?? "lf_1",
    eventId: overrides.eventId ?? null,
    key: overrides.key ?? "nama",
    label: overrides.label ?? "Nama",
    type: overrides.type ?? "text",
    required: overrides.required ?? false,
    options: overrides.options ?? [],
    helpText: overrides.helpText ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    active: overrides.active ?? true,
    createdAt: overrides.createdAt ?? "2026-10-01T00:00:00.000Z",
  };
}

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: overrides.id ?? "lead_1",
    eventId: overrides.eventId ?? null,
    galleryId: overrides.galleryId ?? null,
    values: overrides.values ?? {},
    consent: overrides.consent ?? true,
    consentText: overrides.consentText ?? "teks",
    consentVersion: overrides.consentVersion ?? LEAD_CONSENT_VERSION,
    source: overrides.source ?? "form",
    createdAt: overrides.createdAt ?? "2026-10-12T10:00:00.000Z",
  };
}

/* ---- Tipe field ---------------------------------------------------- */

test("isLeadFieldType hanya menerima lima tipe yang dikenal", () => {
  for (const type of ["text", "email", "phone", "select", "checkbox"]) {
    assert.equal(isLeadFieldType(type), true, `${type} harus dikenal`);
  }
  assert.equal(isLeadFieldType("number"), false);
  assert.equal(isLeadFieldType(""), false);
});

/* ---- Kunci field --------------------------------------------------- */

test("normalizeFieldKey menurunkan kunci dari label yang bisa dibaca", () => {
  assert.equal(normalizeFieldKey("Nomor WhatsApp"), "nomor_whatsapp");
  assert.equal(normalizeFieldKey("Nama Lengkap!"), "nama_lengkap");
  assert.equal(normalizeFieldKey("  E-mail  "), "e_mail");
  assert.equal(normalizeFieldKey("Alamat///Kota"), "alamat_kota");
});

test("normalizeFieldKey membuang aksen supaya kunci tetap ASCII", () => {
  // Operator Indonesia sering menulis "Alamat Jalan" dengan aksen kalau
  // menempel dari dokumen; kunci ber-aksen merepotkan di CSV dan di SQL.
  assert.equal(normalizeFieldKey("Café"), "cafe");
  assert.equal(normalizeFieldKey("No. Télépon"), "no_telepon");
});

test("normalizeFieldKey tidak pernah mengembalikan kunci kosong", () => {
  // Label yang seluruhnya non-alfanumerik ("???") tidak boleh menghasilkan
  // kunci "" — dua field seperti itu akan saling menimpa di `values`.
  assert.equal(normalizeFieldKey(""), "field");
  assert.equal(normalizeFieldKey("???"), "field");
  assert.equal(normalizeFieldKey("   "), "field");
});

test("normalizeFieldKey memotong di batas panjang", () => {
  const long = "a".repeat(100);
  assert.equal(normalizeFieldKey(long).length, 40);
  assert.equal(normalizeFieldKey(long, 5), "aaaaa");
});

/* ---- Email --------------------------------------------------------- */

test("isEmail menerima alamat wajar dan menolak yang tidak", () => {
  assert.equal(isEmail("budi@example.com"), true);
  assert.equal(isEmail("budi.santoso+acara@mail.co.id"), true);
  assert.equal(isEmail("  budi@example.com  "), true, "spasi tepi dipangkas dulu");

  assert.equal(isEmail("budi"), false);
  assert.equal(isEmail("budi@"), false);
  assert.equal(isEmail("@example.com"), false);
  assert.equal(isEmail("budi@example"), false, "domain tanpa titik ditolak");
  assert.equal(isEmail("budi@@example.com"), false);
  assert.equal(isEmail("budi@exa mple.com"), false);
  assert.equal(isEmail(""), false);
});

test("isEmail menolak alamat yang lebih panjang dari batas RFC", () => {
  assert.equal(isEmail(`${"a".repeat(250)}@example.com`), false);
});

/* ---- Telepon ------------------------------------------------------- */

test("isPhone menerima format Indonesia yang lazim", () => {
  // Operator menyalin nomor dari WhatsApp apa adanya; menolak format ini
  // membuat tamu mengira datanya tidak terkirim.
  assert.equal(isPhone("081234567890"), true);
  assert.equal(isPhone("+6281234567890"), true);
  assert.equal(isPhone("6281234567890"), true);
  assert.equal(isPhone("0812-3456-7890"), true);
  assert.equal(isPhone("0812 3456 7890"), true);
  assert.equal(isPhone("(0812) 3456-7890"), true);
  assert.equal(isPhone("+62 812 3456 7890"), true);
});

test("isPhone menolak nomor yang terlalu pendek, panjang, atau bukan angka", () => {
  assert.equal(isPhone("0812345"), false, "terlalu pendek");
  assert.equal(isPhone("0812345678901234"), false, "terlalu panjang");
  assert.equal(isPhone("abcdefghij"), false);
  assert.equal(isPhone("0812-ABCD-7890"), false);
  assert.equal(isPhone(""), false);
});

test("isPhone menerima nomor internasional non-Indonesia", () => {
  assert.equal(isPhone("+14155552671"), true);
  assert.equal(isPhone("+4412345"), false, "kurang dari 8 digit");
});

/* ---- Validasi nilai ------------------------------------------------ */

test("validateLeadValues memangkas spasi dan mengembalikan nilai bersih", () => {
  const result = validateLeadValues([field({ key: "nama", label: "Nama" })], {
    nama: "  Budi Santoso  ",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, { nama: "Budi Santoso" });
});

test("validateLeadValues menandai field wajib yang kosong", () => {
  const result = validateLeadValues([field({ key: "nama", label: "Nama", required: true })], {});
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.key, "nama");
  assert.match(result.errors[0]?.message ?? "", /wajib diisi/);
});

test("validateLeadValues menyimpan field opsional kosong sebagai string kosong", () => {
  // Penting: nilai kosong tetap ada di `values` supaya UI operator bisa
  // menampilkan kolom kosong, bukan "field tidak ada di form ini".
  const result = validateLeadValues([field({ key: "catatan", label: "Catatan" })], {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, { catatan: "" });
});

test("validateLeadValues mengabaikan field yang tidak dikenal", () => {
  // Form yang ter-cache di HP tamu bisa mengirim field yang sudah dihapus
  // operator. Menolaknya berarti tamu tidak bisa mengirim apa pun.
  const result = validateLeadValues([field({ key: "nama", label: "Nama" })], {
    nama: "Budi",
    field_lama_yang_dihapus: "sesuatu",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.values), ["nama"]);
});

test("validateLeadValues menolak nilai teks yang terlalu panjang", () => {
  const result = validateLeadValues([field({ key: "nama", label: "Nama" })], {
    nama: "x".repeat(LEAD_VALUE_MAX + 1),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0]?.message ?? "", /terlalu panjang/);
});

test("validateLeadValues menerima tepat di batas panjang", () => {
  const result = validateLeadValues([field({ key: "nama", label: "Nama" })], {
    nama: "x".repeat(LEAD_VALUE_MAX),
  });
  assert.equal(result.ok, true);
});

test("validateLeadValues menegakkan format email", () => {
  const fields = [field({ key: "email", label: "Email", type: "email" })];
  assert.equal(validateLeadValues(fields, { email: "budi@example.com" }).ok, true);

  const bad = validateLeadValues(fields, { email: "budi" });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0]?.message ?? "", /email/);
});

test("validateLeadValues menegakkan format telepon", () => {
  const fields = [field({ key: "hp", label: "No. HP", type: "phone" })];
  assert.equal(validateLeadValues(fields, { hp: "081234567890" }).ok, true);
  assert.equal(validateLeadValues(fields, { hp: "123" }).ok, false);
});

test("validateLeadValues menolak pilihan select di luar daftar", () => {
  const fields = [
    field({ key: "tahu_dari", label: "Tahu dari", type: "select", options: ["Instagram", "Teman"] }),
  ];
  assert.equal(validateLeadValues(fields, { tahu_dari: "Instagram" }).ok, true);

  const bad = validateLeadValues(fields, { tahu_dari: "Iklan TV" });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0]?.message ?? "", /tidak dikenal/);
});

test("validateLeadValues: checkbox jadi boolean, dan wajib harus dicentang", () => {
  const optional = [field({ key: "izin", label: "Izin", type: "checkbox" })];
  assert.deepEqual(validateLeadValues(optional, {}).values, { izin: false });
  assert.deepEqual(validateLeadValues(optional, { izin: "on" }).values, { izin: true });
  assert.deepEqual(validateLeadValues(optional, { izin: "true" }).values, { izin: true });
  assert.deepEqual(validateLeadValues(optional, { izin: true }).values, { izin: true });

  const required = [field({ key: "izin", label: "Izin", type: "checkbox", required: true })];
  const missing = validateLeadValues(required, {});
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0]?.message ?? "", /harus dicentang/);
  assert.equal(validateLeadValues(required, { izin: "on" }).ok, true);
});

test("validateLeadValues melaporkan SEMUA field bermasalah, bukan yang pertama", () => {
  // Form HTML hanya menampilkan satu pesan umum, tapi API JSON memakai daftar
  // ini untuk menyorot tiap field — berhenti di error pertama bikin tamu
  // memperbaiki satu per satu.
  const fields = [
    field({ key: "nama", label: "Nama", required: true }),
    field({ key: "email", label: "Email", type: "email", required: true }),
  ];
  const result = validateLeadValues(fields, { email: "bukan-email" });
  assert.equal(result.errors.length, 2);
  assert.deepEqual(
    result.errors.map((error) => error.key).sort(),
    ["email", "nama"],
  );
});

/* ---- Field mana yang ditanyakan ------------------------------------ */

test("fieldAppliesTo: field nonaktif tidak pernah ditanyakan", () => {
  assert.equal(fieldAppliesTo(field({ active: false }), null), false);
});

test("fieldAppliesTo: field global berlaku untuk semua acara", () => {
  const global = field({ eventId: null });
  assert.equal(fieldAppliesTo(global, "ev_1"), true);
  assert.equal(fieldAppliesTo(global, null), true);
});

test("fieldAppliesTo: field per-acara hanya untuk acara itu", () => {
  const scoped = field({ eventId: "ev_1" });
  assert.equal(fieldAppliesTo(scoped, "ev_1"), true);
  assert.equal(fieldAppliesTo(scoped, "ev_2"), false);
  assert.equal(fieldAppliesTo(scoped, null), false);
});

test("activeFieldsFor menyaring lalu mengurutkan sesuai sortOrder", () => {
  const fields = [
    field({ id: "c", key: "c", label: "C", sortOrder: 20 }),
    field({ id: "a", key: "a", label: "A", sortOrder: 10 }),
    field({ id: "x", key: "x", label: "X", sortOrder: 5, active: false }),
    field({ id: "b", key: "b", label: "B", sortOrder: 10, eventId: "ev_lain" }),
  ];
  assert.deepEqual(
    activeFieldsFor(fields, "ev_1").map((f) => f.key),
    ["a", "c"],
  );
});

test("activeFieldsFor mengurutkan label saat sortOrder sama", () => {
  const fields = [
    field({ key: "z", label: "Zebra", sortOrder: 0 }),
    field({ key: "a", label: "Anggur", sortOrder: 0 }),
  ];
  assert.deepEqual(
    activeFieldsFor(fields, null).map((f) => f.key),
    ["a", "z"],
  );
});

/* ---- CSV ----------------------------------------------------------- */

test("csvEscape selalu mengutip dan menggandakan kutip di dalamnya", () => {
  assert.equal(csvEscape("budi"), '"budi"');
  assert.equal(csvEscape("Santoso, Budi"), '"Santoso, Budi"');
  assert.equal(csvEscape('kata "kutip"'), '"kata ""kutip"""');
  assert.equal(csvEscape("baris\nbaru"), '"baris\nbaru"');
});

test("csvHeader memuat kolom tetap lalu label tiap field", () => {
  const header = csvHeader([field({ label: "Nama" }), field({ label: "No. HP" })]);
  assert.deepEqual(header, ["waktu", "nama_acara", "galeri", "consent", "versi_consent", "Nama", "No. HP"]);
});

test("buildLeadsCsv menulis header, baris, dan newline di akhir", () => {
  const fields = [field({ key: "nama", label: "Nama" })];
  const csv = buildLeadsCsv(fields, [lead({ values: { nama: "Budi" } })]);

  const lines = csv.split("\r\n");
  assert.equal(lines[0], '"waktu","nama_acara","galeri","consent","versi_consent","Nama"');
  assert.equal(lines[1], '"2026-10-12T10:00:00.000Z","","","ya","1","Budi"');
  assert.equal(csv.endsWith("\r\n"), true, "baris terakhir harus ditutup CRLF");
});

test("buildLeadsCsv memakai label yang diberikan, dan id kalau tidak ada label", () => {
  const fields = [field({ key: "nama", label: "Nama" })];
  const csv = buildLeadsCsv(
    fields,
    [lead({ eventId: "ev_1", galleryId: "g_1", values: { nama: "Budi" } })],
    { eventNames: { ev_1: "Pernikahan Asep" }, galleryLabels: { g_1: "abc123" } },
  );
  assert.match(csv, /"Pernikahan Asep"/);
  assert.match(csv, /"abc123"/);

  const noLabels = buildLeadsCsv(fields, [lead({ eventId: "ev_1", galleryId: "g_1" })]);
  assert.match(noLabels, /"ev_1"/);
  assert.match(noLabels, /"g_1"/);
});

test("buildLeadsCsv menulis sel kosong untuk nilai yang tidak ada", () => {
  // Bukan "undefined": spreadsheet menampilkan kata itu sebagai teks.
  const fields = [field({ key: "nama", label: "Nama" }), field({ key: "hp", label: "HP" })];
  const csv = buildLeadsCsv(fields, [lead({ values: { nama: "Budi" } })]);
  const cells = csv.split("\r\n")[1]?.split(",") ?? [];
  assert.equal(cells.at(-1), '""');
  assert.equal(csv.includes("undefined"), false);
});

test("buildLeadsCsv menulis checkbox sebagai ya/tidak", () => {
  const fields = [field({ key: "izin", label: "Izin", type: "checkbox" })];
  const csv = buildLeadsCsv(fields, [
    lead({ id: "l1", values: { izin: true } }),
    lead({ id: "l2", values: { izin: false } }),
  ]);
  const rows = csv.trimEnd().split("\r\n").slice(1);
  assert.equal(rows[0]?.split(",").at(-1), '"ya"');
  assert.equal(rows[1]?.split(",").at(-1), '"tidak"');
});

test("buildLeadsCsv mencatat consent yang tidak diberikan", () => {
  // Baris tanpa consent tetap muncul — operator perlu bisa melihat (dan
  // membuang) data yang tersimpan sebelum aturan consent diperketat.
  const csv = buildLeadsCsv([], [lead({ consent: false })]);
  assert.match(csv, /"tidak"/);
});

test("buildLeadsCsv tetap satu baris logis walau nilainya memuat koma", () => {
  const fields = [field({ key: "alamat", label: "Alamat" })];
  const csv = buildLeadsCsv(fields, [lead({ values: { alamat: "Jl. Merdeka, No. 5" } })]);
  // Satu header + satu baris data = dua baris CRLF, walau ada koma di nilai.
  assert.equal(csv.trimEnd().split("\r\n").length, 2);
  assert.match(csv, /"Jl\. Merdeka, No\. 5"/);
});

test("buildLeadsCsv dengan daftar kosong tetap mengeluarkan header", () => {
  const csv = buildLeadsCsv([field({ label: "Nama" })], []);
  assert.equal(csv, '"waktu","nama_acara","galeri","consent","versi_consent","Nama"\r\n');
});

/* ---- Retensi ------------------------------------------------------- */

test("retentionCutoff mundur tepat sebanyak hari yang diminta", () => {
  const now = new Date("2026-10-12T00:00:00.000Z");
  assert.equal(retentionCutoff(now, 1), "2026-10-11T00:00:00.000Z");
  assert.equal(retentionCutoff(now, 30), "2026-09-12T00:00:00.000Z");
});

test("retentionCutoff memakai LEAD_RETENTION_DAYS sebagai bawaan", () => {
  const now = new Date("2026-10-12T00:00:00.000Z");
  const expected = new Date(now.getTime() - LEAD_RETENTION_DAYS * 86_400_000).toISOString();
  assert.equal(retentionCutoff(now), expected);
});
