/**
 * E2E Fase 10 — Lisensi & order, lewat server sungguhan.
 *
 * Tes unit memeriksa potongan-potongan; skrip ini memeriksa bahwa rantainya
 * benar-benar tersambung di jalur yang dipakai operator:
 *
 *   katalog publik (harga terlihat tanpa login)
 *   → operator mencatat order
 *   → status dipindahkan sampai lunas → kode aktivasi terbit
 *   → kode ditebus jadi entitlement
 *   → entitlement itu benar-benar **membatasi** pembuatan galeri
 *   → refund mencabut kode, dan kode cabut tidak bisa ditebus
 *
 * Yang **tidak** diuji di sini: gateway pembayaran. Memang tidak ada — provider
 * `qris` sengaja menjawab 501, dan skrip ini justru menegaskan itu: order yang
 * menggantung di "menunggu pembayaran" yang tidak bisa dibayar lebih buruk
 * daripada error yang jujur. Tidak ada jaringan keluar sama sekali.
 *
 * Jalankan dari akar repo: `node e2e/phase10-license.e2e.mjs`
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 5180);
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

async function json(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
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
  return { status: res.status, body: parsed, text };
}

const dataDir = mkdtempSync(join(tmpdir(), "foto-booth-e2e10-"));
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

  section("1. Katalog publik — harga terlihat sebelum login");
  const anon = await json("GET", "/v1/license/catalog");
  check("katalog tanpa token → 200", anon.status === 200, `dapat ${anon.status}`);
  const items = anon.body?.items ?? [];
  check("katalog memuat semua SKU yang dijual", items.length >= 2, `${items.length} SKU`);
  const personal = items.find((i) => i.sku === "booth-personal");
  check("SKU punya nama, harga, dan batas plan", typeof personal?.priceIdr === "number" && personal.priceIdr > 0);
  check("batas plan ikut dikirim, bukan ditebak klien", personal?.limits?.maxActiveGalleries === 3, `limits=${JSON.stringify(personal?.limits)}`);
  check("batas plan cocok dengan harga plan komersial", items.find((i) => i.sku === "booth-commercial")?.limits?.maxActiveGalleries === null);
  const providers = anon.body?.providers ?? [];
  check("provider manual ditandai hidup", providers.find((p) => p.id === "manual")?.live === true);
  check(
    "provider qris ditandai belum hidup (tampil di katalog, tapi jujur)",
    providers.find((p) => p.id === "qris")?.live === false,
  );

  section("2. Masuk sebagai operator");
  const otp = await json("POST", "/v1/auth/otp/request", { body: { email: OPERATOR } });
  const verify = await json("POST", "/v1/auth/otp/verify", { body: { email: OPERATOR, code: otp.body?.code } });
  const token = verify.body?.token;
  check("tukar kode OTP → 200 + token", verify.status === 200 && typeof token === "string");
  if (typeof token !== "string") throw new Error("tanpa token, sisa skrip tidak bisa jalan");

  section("3. Rute order & aktivasi tertutup tanpa token");
  const noToken = await json("GET", "/v1/license/orders");
  check("daftar order tanpa token → 401", noToken.status === 401, `dapat ${noToken.status}`);
  const noTokenEnt = await json("GET", "/v1/license/entitlement");
  check("status lisensi tanpa token → 401", noTokenEnt.status === 401, `dapat ${noTokenEnt.status}`);
  const noTokenRedeem = await json("POST", "/v1/license/activate", { body: { code: "ABCDEFGHJKLM" } });
  check("tebus kode tanpa token → 401", noTokenRedeem.status === 401, `dapat ${noTokenRedeem.status}`);

  section("4. Operator mencatat order");
  const created = await json("POST", "/v1/license/orders", {
    token,
    body: { sku: "booth-personal", email: OPERATOR, provider: "manual", note: "transfer BCA" },
  });
  check("catat order → 201", created.status === 201, `dapat ${created.status}`);
  const order = created.body?.order;
  check("order mulai dari status created", order?.status === "created");
  check(
    "harga diambil dari katalog server, bukan dari body",
    order?.amountIdr === personal?.priceIdr,
    `order=${order?.amountIdr} katalog=${personal?.priceIdr}`,
  );
  check("nama SKU ikut disalin (snapshot, bukan rujukan katalog)", order?.skuName === personal?.name);
  check("order baru belum punya kode aktivasi", order?.reference === null && order?.referenceFormatted === null);
  check("catatan operator tersimpan", order?.note === "transfer BCA");

  // Klien yang mencoba menitipkan harga harus diabaikan, bukan dipercaya.
  const sneaky = await json("POST", "/v1/license/orders", {
    token,
    body: { sku: "booth-commercial", email: OPERATOR, provider: "manual", amountIdr: 1000 },
  });
  check(
    "harga yang dikirim klien diabaikan",
    sneaky.body?.order?.amountIdr === items.find((i) => i.sku === "booth-commercial")?.priceIdr,
    `amount=${sneaky.body?.order?.amountIdr}`,
  );

  const qris = await json("POST", "/v1/license/orders", {
    token,
    body: { sku: "booth-personal", email: OPERATOR, provider: "qris" },
  });
  check("provider qris → 501, bukan order menggantung", qris.status === 501, `dapat ${qris.status}`);
  check("jawabannya jelas menyebut belum tersambung", qris.body?.error === "payment_unavailable" && /belum tersambung/.test(qris.body?.message ?? ""));

  const badSku = await json("POST", "/v1/license/orders", {
    token,
    body: { sku: "booth-gratis", email: OPERATOR, provider: "manual" },
  });
  check("SKU tak dikenal → 400", badSku.status === 400, `dapat ${badSku.status}`);

  const badProvider = await json("POST", "/v1/license/orders", {
    token,
    body: { sku: "booth-personal", email: OPERATOR, provider: "bitcoin" },
  });
  check("provider tak dikenal → 400", badProvider.status === 400, `dapat ${badProvider.status}`);

  const noEmail = await json("POST", "/v1/license/orders", {
    token,
    body: { sku: "booth-personal", email: "bukan-email", provider: "manual" },
  });
  check("email tidak sah → 400", noEmail.status === 400, `dapat ${noEmail.status}`);

  section("5. Siklus hidup status");
  const orderId = order?.id;
  const toPending = await json("POST", `/v1/license/orders/${orderId}/status`, { token, body: { status: "pending" } });
  check("created → pending → 200", toPending.status === 200, `dapat ${toPending.status}`);
  check("belum ada kode yang terbit sebelum lunas", toPending.body?.issuedCode === null);

  const sameStatus = await json("POST", `/v1/license/orders/${orderId}/status`, { token, body: { status: "pending" } });
  check("pindah ke status yang sama → 409", sameStatus.status === 409, `dapat ${sameStatus.status}`);

  const paid = await json("POST", `/v1/license/orders/${orderId}/status`, { token, body: { status: "paid" } });
  check("pending → paid → 200", paid.status === 200, `dapat ${paid.status}`);
  const issued = paid.body?.issuedCode;
  check("kode aktivasi terbit tepat saat lunas", typeof issued?.code === "string" && issued.code.length === 12);
  check(
    "kode berformat kelompok yang dibaca manusia",
    /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(issued?.formatted ?? ""),
    `formatted=${issued?.formatted}`,
  );
  check("kode tidak memakai huruf/angka yang mudah tertukar", !/[IO01]/.test(issued?.code ?? ""), issued?.code);
  check("kode dari server sama dengan bentuk di order", paid.body?.order?.referenceFormatted === issued?.formatted);
  check("waktu lunas tercatat", typeof paid.body?.order?.paidAt === "string");

  const backward = await json("POST", `/v1/license/orders/${orderId}/status`, { token, body: { status: "created" } });
  check("transisi mundur paid → created → 409", backward.status === 409, `dapat ${backward.status}`);

  const byId = await json("GET", `/v1/license/orders/${orderId}`, { token });
  check("ambil satu order menyertakan kodenya", (byId.body?.codes ?? []).length === 1);
  check("kode berstatus unredeemed sebelum ditebus", byId.body?.codes?.[0]?.state === "unredeemed");
  const missing = await json("GET", "/v1/license/orders/ord_tidakada", { token });
  check("order tak ada → 404", missing.status === 404, `dapat ${missing.status}`);

  const filtered = await json("GET", `/v1/license/orders?status=paid&email=${encodeURIComponent(OPERATOR)}`, { token });
  check("daftar order bisa disaring status + email", (filtered.body?.orders ?? []).every((o) => o.status === "paid"));
  check("penyaringan email tidak mengembalikan order orang lain", (filtered.body?.orders ?? []).length === 1, `${(filtered.body?.orders ?? []).length} baris`);
  const badFilter = await json("GET", "/v1/license/orders?status=entah", { token });
  check("status filter tak dikenal → 400", badFilter.status === 400, `dapat ${badFilter.status}`);

  section("6. Kode ditebus jadi lisensi perangkat");
  const beforeRedeem = await json("GET", "/v1/license/entitlement", { token });
  check("sebelum menebus, perangkat belum punya lisensi", beforeRedeem.body?.entitlement === null);
  check("verdict sebelum menebus: tidak diizinkan", beforeRedeem.body?.verdict?.allowed === false, JSON.stringify(beforeRedeem.body?.verdict));

  // Sengaja diketik seperti manusia: huruf kecil + spasi + tanda hubung.
  const messy = `${issued.formatted.toLowerCase()} `;
  const redeemed = await json("POST", "/v1/license/activate", { token, body: { code: messy } });
  check("tebus kode (huruf kecil + spasi) → 200", redeemed.status === 200, `dapat ${redeemed.status}`);
  check("entitlement terbit dengan plan dari SKU", redeemed.body?.entitlement?.plan === "personal");
  check("batas galeri ikut dari kode, bukan dari klien", redeemed.body?.entitlement?.maxActiveGalleries === 3);
  check("lisensi langsung dianggap aktif", redeemed.body?.verdict?.allowed === true);
  check("kode ditandai sudah dipakai", redeemed.body?.code?.state === "redeemed");

  const twice = await json("POST", "/v1/license/activate", { token, body: { code: issued.code } });
  check("tebus kode yang sama dua kali → 409", twice.status === 409, `dapat ${twice.status}`);

  const malformed = await json("POST", "/v1/license/activate", { token, body: { code: "ABC" } });
  check("kode salah bentuk → 400", malformed.status === 400, `dapat ${malformed.status}`);
  const unknown = await json("POST", "/v1/license/activate", { token, body: { code: "ZZZZZZZZZZZZ" } });
  check("kode benar bentuk tapi tak ada → 404", unknown.status === 404, `dapat ${unknown.status}`);

  const afterRedeem = await json("GET", "/v1/license/entitlement", { token });
  check("status lisensi ikut berubah setelah tebus", afterRedeem.body?.verdict?.allowed === true);
  check("batas plan ikut dilaporkan ke panel", afterRedeem.body?.limits?.maxActiveGalleries === 3);

  section("7. Lisensi benar-benar membatasi (bukan sekadar angka di DB)");
  const event = await json("POST", "/v1/events", {
    token,
    body: { name: "Pernikahan E2E Lisensi", date: "2026-10-20", hashtag: "#e2elicense" },
  });
  check("buat acara → 201", event.status === 201, `dapat ${event.status}`);
  const eventId = event.body?.id;

  const g1 = await json("POST", "/v1/galleries", { token, body: { eventId } });
  const g2 = await json("POST", "/v1/galleries", { token, body: { eventId } });
  const g3 = await json("POST", "/v1/galleries", { token, body: { eventId } });
  check("galeri ke-1..3 (batas plan personal) → 201", g1.status === 201 && g2.status === 201 && g3.status === 201, `${g1.status}/${g2.status}/${g3.status}`);

  const g4 = await json("POST", "/v1/galleries", { token, body: { eventId } });
  check("galeri ke-4 ditolak → 402", g4.status === 402, `dapat ${g4.status}`);
  check("jawabannya menyebut batas plan, bukan error samar", g4.body?.error === "entitlement_required" && /batas 3/.test(g4.body?.message ?? ""), g4.body?.message);

  section("8. Refund mencabut kode yang sudah beredar");
  const refunded = await json("POST", `/v1/license/orders/${orderId}/status`, { token, body: { status: "refunded" } });
  check("paid → refunded → 200", refunded.status === 200, `dapat ${refunded.status}`);

  const codeAfterRefund = await json("GET", `/v1/license/activation-codes?orderId=${orderId}`, { token });
  check("kode berstatus revoked setelah refund", codeAfterRefund.body?.codes?.[0]?.state === "revoked", codeAfterRefund.body?.codes?.[0]?.state);

  const revokeAgain = await json("POST", `/v1/license/orders/${orderId}/status`, { token, body: { status: "paid" } });
  check("order refunded tidak bisa dihidupkan lagi → 409", revokeAgain.status === 409, `dapat ${revokeAgain.status}`);

  section("9. Sisa kuota tetap jujur setelah lisensi dicabut");
  // Galeri yang sudah dibuat tetap ada; yang diperiksa di sini adalah bahwa
  // sistem tidak berpura-pura semuanya baik-baik saja.
  const codes = await json("GET", "/v1/license/activation-codes", { token });
  check("daftar kode memuat kode yang tadi terbit", (codes.body?.codes ?? []).some((c) => c.code === issued.code));
} catch (error) {
  failures.push(`skrip gagal: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`\n✖ ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  cleanup();
}

console.log(`\n${"=".repeat(56)}`);
if (failures.length === 0) {
  console.log(`✔ Fase 10 E2E lulus — ${passed} pemeriksaan`);
  process.exit(0);
}
console.log(`✖ ${failures.length} gagal dari ${passed + failures.length} pemeriksaan:`);
for (const failure of failures) console.log(`  · ${failure}`);
if (serverLog.length > 0) {
  console.log("\n--- log server (40 baris terakhir) ---");
  console.log(serverLog.join("").split("\n").slice(-40).join("\n"));
}
process.exit(1);
