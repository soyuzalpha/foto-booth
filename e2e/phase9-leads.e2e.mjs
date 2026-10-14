/**
 * E2E Fase 9 — Leads & analytics, lewat server sungguhan.
 *
 * Tes unit memeriksa potongan-potongan; skrip ini memeriksa bahwa potongan itu
 * benar-benar tersambung di jalur yang dipakai orang:
 *
 *   operator bikin acara → bikin galeri → atur field data tamu
 *   → tamu membuka halaman galeri dan mengisi form
 *   → datanya muncul di panel operator, di CSV, dan di angka analytics
 *
 * Yang **tidak** diuji di sini: S3 (tidak ada foto yang diunggah) dan
 * pembayaran (sengaja masih stub). Tidak ada jaringan keluar sama sekali.
 *
 * Jalankan dari akar repo: `node e2e/phase9-leads.e2e.mjs`
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 5179);
const BASE = `http://127.0.0.1:${PORT}`;
const OPERATOR = "operator@example.com";
const JWT_SECRET = "e2e-jwt-secret-0123456789abcdef0123456789abcdef";

let passed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${label}`);
  } else {
    failures.push(`${label}${detail === "" ? "" : ` — ${detail}`}`);
    console.log(`  ✖ ${label}${detail === "" ? "" : ` — ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** Tunggu sampai `/health` menjawab; gagal cepat kalau prosesnya mati. */
async function waitForServer(proc, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server berhenti dengan kode ${proc.exitCode}`);
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // belum siap
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("server tidak siap dalam 30 detik");
}

async function json(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

/** Kirim form seperti browser: urlencoded, tanpa mengikuti redirect. */
async function form(path, fields, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location"), headers: res.headers };
}

const dataDir = mkdtempSync(join(tmpdir(), "foto-booth-e2e9-"));
const server = spawn("node", ["apps/api/src/index.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dataDir,
    JWT_SECRET,
    OTP_DEV_MODE: "1",
    S3_ENDPOINT: "http://127.0.0.1:3900",
    S3_REGION: "garage",
    S3_BUCKET: "foto-booth",
    S3_ACCESS_KEY_ID: "e2e-access-key",
    S3_SECRET_ACCESS_KEY: "e2e-secret-key",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const serverLog = [];
server.stdout.on("data", (chunk) => serverLog.push(String(chunk)));
server.stderr.on("data", (chunk) => serverLog.push(String(chunk)));

function cleanup() {
  if (server.exitCode === null) server.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
}

try {
  await waitForServer(server);

  // Lisensi operator harus ada sebelum galeri bisa dibuat. Disemai langsung ke
  // SQLite karena memang tidak ada rute HTTP untuk memberikannya ke diri
  // sendiri — sama seperti di produksi, lisensi datang dari luar aplikasi.
  const dbPath = join(dataDir, "foto-booth.sqlite");
  const { execFileSync } = await import("node:child_process");
  execFileSync("sqlite3", [
    dbPath,
    `INSERT INTO entitlements (id, email, plan, status, max_active_galleries, issued_at, expires_at)
     VALUES ('ent-e2e', '${OPERATOR}', 'pro', 'active', NULL, '2026-01-01T00:00:00.000Z', NULL);`,
  ]);

  section("1. Masuk sebagai operator");
  const otp = await json("POST", "/v1/auth/otp/request", { body: { email: OPERATOR } });
  check("minta kode OTP → 202", otp.status === 202, `dapat ${otp.status}`);
  check("mode dev mengirim kodenya balik", typeof otp.body?.code === "string" && otp.body.code.length > 0);

  const verify = await json("POST", "/v1/auth/otp/verify", {
    body: { email: OPERATOR, code: otp.body?.code },
  });
  check("tukar kode → 200 + token", verify.status === 200 && typeof verify.body?.token === "string");
  const token = verify.body?.token;
  if (typeof token !== "string") throw new Error("tanpa token, sisa skrip tidak bisa jalan");

  section("2. Operator menyiapkan acara & galeri");
  const event = await json("POST", "/v1/events", {
    token,
    body: { name: "Pernikahan E2E", date: "2026-10-10", hashtag: "#e2ewedding" },
  });
  check("buat acara → 201", event.status === 201, `dapat ${event.status}`);
  const eventId = event.body?.id;

  const gallery = await json("POST", "/v1/galleries", { token, body: { eventId } });
  check("buat galeri → 201", gallery.status === 201, `dapat ${gallery.status}`);
  const hash = gallery.body?.hash;
  check("galeri punya hash & URL tamu", typeof hash === "string" && /\/a\//.test(gallery.body?.url ?? ""));

  section("3. Operator mengatur field data tamu");
  const fName = await json("POST", "/v1/leads/admin/fields", {
    token,
    body: { eventId, label: "Nama lengkap", type: "text", required: true, sortOrder: 1 },
  });
  check("field teks wajib → 201", fName.status === 201, `dapat ${fName.status}`);
  check("kunci diturunkan server dari label", fName.body?.key === "nama_lengkap", `key=${fName.body?.key}`);

  const fSource = await json("POST", "/v1/leads/admin/fields", {
    token,
    body: {
      eventId,
      label: "Tahu dari mana?",
      type: "select",
      required: false,
      options: ["Instagram", "Teman"],
      sortOrder: 2,
    },
  });
  check("field pilihan → 201", fSource.status === 201, `dapat ${fSource.status}`);

  const fConsentOk = await json("POST", "/v1/leads/admin/fields", {
    token,
    body: { eventId, label: "Boleh dihubungi", type: "checkbox", required: false, sortOrder: 3 },
  });
  check("field centang → 201", fConsentOk.status === 201, `dapat ${fConsentOk.status}`);

  const badSelect = await json("POST", "/v1/leads/admin/fields", {
    token,
    body: { eventId, label: "Kosong", type: "select", options: [] },
  });
  check("select tanpa pilihan ditolak → 400", badSelect.status === 400, `dapat ${badSelect.status}`);

  const anon = await json("GET", `/v1/leads/admin/leads?eventId=${eventId}`);
  check("tanpa token, data tamu tertutup → 401", anon.status === 401, `dapat ${anon.status}`);

  section("4. Tamu membuka halaman galeri");
  const page = await fetch(`${BASE}/a/${hash}`);
  const html = await page.text();
  // Cookie kunjungan harian dipegang seperti browser: tanpa ini, buka ulang
  // terlihat seperti orang baru dan angka kunjungan naik — bukan bug, tapi
  // tidak menguji apa pun.
  const visitCookie = (page.headers.getSetCookie?.() ?? [])[0]?.split(";")[0] ?? "";
  check("halaman galeri → 200", page.status === 200, `dapat ${page.status}`);
  check("form data tamu ada di halaman", html.includes('name="consent"'), "form consent tidak ditemukan");
  check("field yang dikonfigurasi ikut dirender", html.includes('name="nama_lengkap"'));
  check("halaman menyetel cookie kunjungan harian", visitCookie.startsWith("fb_seen_"), visitCookie);
  check("form punya kolom honeypot tersembunyi", html.includes('name="website"'));

  section("5. Tamu mengisi form");
  const submit = await form(`/a/${hash}/lead`, {
    nama_lengkap: "Budi Santoso",
    tahu_dari_mana: "Instagram",
    boleh_dihubungi: "1",
    consent: "1",
  });
  check("kiriman diterima → redirect 303", submit.status === 303, `dapat ${submit.status}`);
  check(
    "diarahkan ke status terkirim",
    (submit.location ?? "").includes("status=terkirim"),
    `location=${submit.location}`,
  );

  const noConsent = await form(`/a/${hash}/lead`, {
    nama_lengkap: "Tanpa Izin",
    consent: "0",
  });
  check(
    "tanpa persetujuan → status gagal",
    (noConsent.location ?? "").includes("status=gagal"),
    `location=${noConsent.location}`,
  );

  const honeypot = await form(`/a/${hash}/lead`, {
    nama_lengkap: "Bot",
    website: "http://spam.example",
    consent: "1",
  });
  check("honeypot diisi → pura-pura sukses", (honeypot.location ?? "").includes("status=terkirim"));

  section("6. Data tamu terlihat di panel operator");
  const leads = await json("GET", `/v1/leads/admin/leads?eventId=${eventId}`, { token });
  check("minta daftar data → 200", leads.status === 200, `dapat ${leads.status}`);
  const rows = leads.body?.leads ?? [];
  check("hanya kiriman sah yang tersimpan (2 diisi − 1 ditolak = 1)", rows.length === 1, `dapat ${rows.length} baris`);
  const lead = rows[0];
  check("nama tamu tersimpan apa adanya", lead?.values?.nama_lengkap === "Budi Santoso");
  check("pilihan tersimpan sebagai label", lead?.values?.tahu_dari_mana === "Instagram");
  check("centang tersimpan sebagai boolean true", lead?.values?.boleh_dihubungi === true);
  check("kiriman tertaut ke acara yang benar", lead?.eventId === eventId);
  check("definisi field ikut dikirim", Array.isArray(leads.body?.fields) && leads.body.fields.length === 3);

  section("7. Ekspor CSV");
  const csvRes = await fetch(`${BASE}/v1/leads/admin/export.csv?eventId=${eventId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
  const csv = new TextDecoder().decode(csvBytes);
  check("ekspor → 200 text/csv", csvRes.status === 200 && /text\/csv/.test(csvRes.headers.get("content-type") ?? ""));
  check(
    "berkas ditawarkan sebagai unduhan bernama",
    /attachment; filename="leads-.*\.csv"/.test(csvRes.headers.get("content-disposition") ?? ""),
    csvRes.headers.get("content-disposition") ?? "",
  );
  // Tanpa BOM di sisi server: BOM ditambahkan klien saat menyimpan
  // (`downloadCsv.ts`). Kalau keduanya menambahkan, kolom pertama dapat BOM
  // kedua yang tak terlihat dan perbandingan kolom jadi aneh.
  check(
    "server tidak menambahkan BOM (klien yang menambahkan)",
    !(csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf),
    `byte pertama: ${csvBytes[0]},${csvBytes[1]},${csvBytes[2]}`,
  );
  check("berkas diawali baris judul kolom", (csv.split("\n")[0] ?? "").includes("Nama lengkap"), csv.split("\n")[0] ?? "");
  const header = csv.split("\n")[0] ?? "";
  check("judul kolom dari definisi field", header.includes("Nama lengkap") && header.includes("Tahu dari mana?"), header);
  check("baris tamu ikut terekspor", csv.includes("Budi Santoso"));
  check("tamu yang ditolak tidak terekspor", !csv.includes("Tanpa Izin") && !csv.includes("Bot"));

  section("8. Angka analytics");
  const analytics = await json("GET", `/v1/analytics/overview?from=2026-10-01&to=2026-10-31`, { token });
  check("minta angka → 200", analytics.status === 200, `dapat ${analytics.status}`);
  const row = (analytics.body?.events ?? []).find((entry) => entry.eventId === eventId);
  check("acara muncul di rentang tanggalnya", row !== undefined);
  check("kunjungan dihitung 1 (satu orang, satu hari)", row?.views === 1, `views=${row?.views}`);
  check("jumlah data tamu ikut dihitung", row?.leads === 1, `leads=${row?.leads}`);
  check("jumlah galeri dihitung", row?.galleries === 1, `galleries=${row?.galleries}`);
  check("total sepanjang rentang konsisten", analytics.body?.totals?.leads === 1);

  const refresh = await fetch(`${BASE}/a/${hash}`, { headers: { cookie: visitCookie } });
  await refresh.text();
  const analytics2 = await json("GET", "/v1/analytics/overview?from=2026-10-01&to=2026-10-31", { token });
  const row2 = (analytics2.body?.events ?? []).find((entry) => entry.eventId === eventId);
  check("buka ulang hari yang sama tidak menambah kunjungan", row2?.views === 1, `views=${row2?.views}`);

  const badRange = await json("GET", "/v1/analytics/overview?from=kemarin", { token });
  check("rentang tidak valid ditolak → 400", badRange.status === 400, `dapat ${badRange.status}`);

  section("9. Operator merawat konfigurasi & data");
  const patch = await json("PATCH", `/v1/leads/admin/fields/${fSource.body?.id}`, {
    token,
    body: { active: false },
  });
  check("nonaktifkan field → 200", patch.status === 200 && patch.body?.active === false);

  const fieldsNow = await json("GET", `/v1/leads/admin/fields?eventId=${eventId}`, { token });
  const allFields = fieldsNow.body?.fields ?? [];
  check("layar pengaturan tetap melihat semua field, termasuk yang nonaktif", allFields.length === 3, `${allFields.length} field`);
  check("field yang dinonaktifkan masih ada untuk riwayat", allFields.filter((f) => f.active === false).length === 1);

  const pageAfter = await (await fetch(`${BASE}/a/${hash}`)).text();
  check("field nonaktif hilang dari halaman tamu", !pageAfter.includes('name="tahu_dari_mana"'));

  const guestFields = await json("GET", `/v1/leads/fields?galleryHash=${hash}`);
  check("form tamu hanya menerima field aktif", (guestFields.body?.fields ?? []).length === 2, `${(guestFields.body?.fields ?? []).length} field`);

  const del = await json("DELETE", `/v1/leads/admin/leads/${lead?.id}`, { token });
  check("hapus kiriman (hak UU PDP) → 200", del.status === 200 && del.body?.deleted === true);

  const afterDelete = await json("GET", `/v1/leads/admin/leads?eventId=${eventId}`, { token });
  check("baris benar-benar hilang, bukan disembunyikan", (afterDelete.body?.leads ?? []).length === 0);

  const delAgain = await json("DELETE", `/v1/leads/admin/leads/${lead?.id}`, { token });
  check("hapus dua kali → 404", delAgain.status === 404, `dapat ${delAgain.status}`);

  const dropField = await json("DELETE", `/v1/leads/admin/fields/${fConsentOk.body?.id}`, { token });
  check("hapus field → 200", dropField.status === 200 && dropField.body?.deleted === true);

  section("10. Batas kiriman tamu (dipakai bersama jalur JSON & form galeri)");
  // Kuotanya 10 kiriman per jam per alamat. Sejauh ini sudah terpakai 2: yang
  // sah (tersimpan) dan yang tanpa persetujuan (ditolak, tapi tetap dihitung —
  // kalau tidak, penyerang bisa mengirim kiriman cacat tanpa batas). Yang kena
  // honeypot tidak dihitung: bot diberi jawaban "sukses" lebih awal.
  const QUOTA = 10;
  const used = 2;
  const results = [];
  for (let i = 0; i < 12; i += 1) {
    results.push(await form(`/a/${hash}/lead`, { nama_lengkap: `Tamu ${i}`, consent: "1" }));
  }
  const blocked = results.filter((r) => (r.location ?? "").includes("status=penuh"));
  const allowed = results.length - blocked.length;
  check("kiriman beruntun lewat form galeri ditahan", blocked.length === 12 - (QUOTA - used), `${blocked.length} ditahan dari 12`);
  check("sisa kuota tetap dilayani", allowed === QUOTA - used, `${allowed} dilayani`);
  check(
    "yang ditahan bukan dilaporkan sebagai isian salah",
    results.every((r) => !(r.location ?? "").includes("status=gagal")),
  );

  const limited = await json("GET", `/v1/leads/admin/leads?eventId=${eventId}`, { token });
  check(
    "hanya kiriman yang lolos kuota yang tersimpan",
    (limited.body?.leads ?? []).length === allowed,
    `${(limited.body?.leads ?? []).length} baris, harusnya ${allowed}`,
  );

  const fullPage = await (await fetch(`${BASE}/a/${hash}?status=penuh`)).text();
  check("halaman tamu menjelaskan kenapa ditahan", fullPage.includes("terlalu banyak"));
} catch (error) {
  failures.push(`skrip gagal: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`\n✖ ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  cleanup();
}

console.log(`\n${"=".repeat(56)}`);
if (failures.length === 0) {
  console.log(`✔ Fase 9 E2E lulus — ${passed} pemeriksaan`);
  process.exit(0);
}
console.log(`✖ ${failures.length} gagal dari ${passed + failures.length} pemeriksaan:`);
for (const failure of failures) console.log(`  · ${failure}`);
if (serverLog.length > 0) {
  console.log("\n--- log server (40 baris terakhir) ---");
  console.log(serverLog.join("").split("\n").slice(-40).join("\n"));
}
process.exit(1);
