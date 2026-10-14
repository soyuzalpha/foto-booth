/**
 * Tes klien lisensi & order.
 *
 * Janji yang diuji — semuanya hal yang kalau bocor membuat operator mengambil
 * keputusan uang dengan informasi salah:
 *
 *   1. **Katalog tidak mengirim token.** Endpoint publik; mengirim sesi ke sana
 *      hanya menambah permukaan kebocoran tanpa alasan.
 *   2. **`createOrder` tidak punya jalan mengirim harga.** Body yang benar-benar
 *      keluar dari klien diperiksa: hanya `sku`, `email`, `provider` (+ `note`).
 *   3. **Satu order rusak tidak mengosongkan daftar.** Validasi per-item.
 *   4. **501 dikenali sebagai "belum tersedia"**, bukan "gagal" — panel memakai
 *      pembedaan itu untuk memilih kalimat.
 *   5. **Kode aktivasi dinormalkan tampilannya oleh server**, dan klien tidak
 *      merakit ulang sendiri; yang ditampilkan adalah `formatted` dari balasan.
 *   6. **Entitlement tidak dikenali → `null`, bukan lemparan.** Tab lisensi
 *      tidak boleh mati gara-gara bentuk balasan yang berubah.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createLicenseClient,
  LicenseHttpError,
  parseCodes,
  parseOrders,
  type LicenseClientOptions,
} from "./licenseClient.ts";

const TOKEN = "tok-lisensi";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function clientWith(
  respond: (call: Call) => Response | Promise<Response>,
  options: Partial<LicenseClientOptions> = {},
): { client: ReturnType<typeof createLicenseClient>; calls: Call[] } {
  const calls: Call[] = [];
  const client = createLicenseClient({
    token: TOKEN,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init };
      calls.push(call);
      return respond(call);
    }) as typeof globalThis.fetch,
    ...options,
  });
  return { client, calls };
}

const ORDER = {
  id: "ord_1",
  sku: "booth-personal",
  skuName: "Foto Booth — Personal",
  email: "a@example.com",
  amountIdr: 1_500_000,
  status: "created",
  provider: "manual",
  reference: null,
  note: null,
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  paidAt: null,
  referenceFormatted: null,
};

const CODE = {
  code: "ABCDEFGHJKLM",
  formatted: "ABCD-EFGH-JKLM",
  state: "unredeemed",
  orderId: "ord_1",
  plan: "personal",
  maxActiveGalleries: 3,
  issuedAt: "2026-10-14T00:00:00.000Z",
  expiresAt: null,
  redeemedAt: null,
  redeemedBy: null,
  revokedAt: null,
};

/* ---- Auth --------------------------------------------------------- */

test("katalog dipanggil tanpa token; sisanya dengan token", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ items: [], providers: [] }));
  await client.catalog();

  const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, undefined, "katalog publik → tanpa sesi");
  assert.match(calls[0]?.url ?? "", /\/v1\/license\/catalog$/);

  const second = clientWith(() => jsonResponse({ orders: [] }));
  await second.client.listOrders();
  const authed = (second.calls[0]?.init?.headers ?? {}) as Record<string, string>;
  assert.equal(authed.authorization, `Bearer ${TOKEN}`);
});

/* ---- Order -------------------------------------------------------- */

test("createOrder tidak pernah mengirim harga di body", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ order: ORDER }, 201));
  await client.createOrder({ sku: "booth-personal", email: "a@example.com", provider: "manual" });

  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["email", "provider", "sku"]);
  assert.equal(body.amountIdr, undefined);
  assert.equal(body.priceIdr, undefined);
});

test("createOrder meneruskan note kalau ada", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ order: ORDER }, 201));
  await client.createOrder({
    sku: "booth-commercial",
    email: "a@example.com",
    provider: "manual",
    note: "transfer BCA",
  });
  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  assert.equal(body.note, "transfer BCA");
});

test("daftar order: satu baris rusak dibuang, sisanya tetap", async () => {
  const { client } = clientWith(() =>
    jsonResponse({ orders: [ORDER, { id: "rusak" }, { ...ORDER, id: "ord_2" }] }),
  );
  const orders = await client.listOrders();
  assert.equal(orders.length, 2);
  assert.deepEqual(
    orders.map((o) => o.id),
    ["ord_1", "ord_2"],
  );
});

test("daftar order mengirim filter sebagai query", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ orders: [] }));
  await client.listOrders({ status: "pending", email: "a@example.com", limit: 5 });

  const url = calls[0]?.url ?? "";
  assert.match(url, /status=pending/);
  assert.match(url, /email=a%40example\.com/);
  assert.match(url, /limit=5/);
});

test("setOrderStatus mengembalikan kode terbit saat lunas", async () => {
  const { client, calls } = clientWith(() =>
    jsonResponse({
      order: {
        ...ORDER,
        status: "paid",
        reference: CODE.code,
        referenceFormatted: CODE.formatted,
        paidAt: ORDER.createdAt,
      },
      issuedCode: CODE,
    }),
  );
  const result = await client.setOrderStatus("ord_1", "paid");

  assert.equal(result.order.status, "paid");
  // Bentuk tampilan datang dari server; klien tidak merakit tanda hubungnya.
  assert.equal(result.order.referenceFormatted, "ABCD-EFGH-JKLM");
  assert.equal(result.issuedCode?.formatted, "ABCD-EFGH-JKLM");
  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(body, { status: "paid" });
});

test("parseOrders mempertahankan referenceFormatted dari server", () => {
  const orders = parseOrders([{ ...ORDER, reference: CODE.code, referenceFormatted: CODE.formatted }]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0]?.referenceFormatted, "ABCD-EFGH-JKLM");

  // Server tidak mengirim bentuk tampilan → `null`, bukan crash.
  const without = parseOrders([ORDER]);
  assert.equal(without[0]?.referenceFormatted, null);
});

test("setOrderStatus tanpa kode terbit → issuedCode null", async () => {
  const { client } = clientWith(() => jsonResponse({ order: ORDER, issuedCode: null }));
  const result = await client.setOrderStatus("ord_1", "pending");
  assert.equal(result.issuedCode, null);
});

/* ---- Provider belum tersambung ------------------------------------ */

test("501 dari provider qris dikenali sebagai belum tersedia", async () => {
  const { client } = clientWith(() =>
    jsonResponse({ error: "payment_unavailable", message: "belum tersambung" }, 501),
  );

  await assert.rejects(
    () => client.createOrder({ sku: "booth-personal", email: "a@example.com", provider: "qris" }),
    (error: unknown) => {
      assert.ok(error instanceof LicenseHttpError);
      assert.equal(error.status, 501);
      assert.equal(error.isUnavailable, true);
      assert.equal(error.message, "belum tersambung");
      return true;
    },
  );
});

test("409 transisi mundur bukan 501", async () => {
  const { client } = clientWith(() =>
    jsonResponse({ error: "conflict", message: "tidak bisa mundur" }, 409),
  );
  await assert.rejects(
    () => client.setOrderStatus("ord_1", "pending"),
    (error: unknown) => {
      assert.ok(error instanceof LicenseHttpError);
      assert.equal(error.isUnavailable, false);
      return true;
    },
  );
});

/* ---- Kode aktivasi ------------------------------------------------ */

test("activate memakai bentuk tampilan yang dikirim server, bukan rakit sendiri", async () => {
  const { client, calls } = clientWith(() =>
    jsonResponse({
      entitlement: {
        id: "ent_1",
        email: "a@example.com",
        plan: "personal",
        status: "active",
        maxActiveGalleries: 3,
        issuedAt: ORDER.createdAt,
        expiresAt: null,
      },
      verdict: { state: "active", allowed: true, daysLeft: null, reason: null },
      limits: { maxActiveGalleries: 3, allowsWhiteLabel: false, allowsCommercialUse: false },
      code: { ...CODE, state: "redeemed", redeemedAt: ORDER.createdAt, redeemedBy: "a@example.com" },
    }),
  );

  const result = await client.activate("abcd-efgh-jklm");
  assert.equal(result.code.formatted, "ABCD-EFGH-JKLM");
  assert.equal(result.code.state, "redeemed");
  assert.equal(result.verdict.allowed, true);
  assert.equal(result.limits?.allowsWhiteLabel, false);

  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  assert.equal(body.code, "abcd-efgh-jklm", "kode dikirim apa adanya; server yang menormalkan");
});

test("parseCodes membuang entri tanpa bentuk kode", () => {
  const codes = parseCodes([CODE, null, "bukan-objek", { code: "" }, { formatted: "X" }]);
  assert.equal(codes.length, 1);
  assert.equal(codes[0]?.code, "ABCDEFGHJKLM");
});

test("parseOrders: balasan bukan daftar → daftar kosong", () => {
  assert.deepEqual(parseOrders(undefined), []);
  assert.deepEqual(parseOrders({ orders: [] }), []);
});

/* ---- Entitlement -------------------------------------------------- */

test("entitlement tanpa lisensi: verdict none, entitlement null", async () => {
  const { client } = clientWith(() =>
    jsonResponse({
      entitlement: null,
      verdict: { state: "none", allowed: false, daysLeft: null, reason: "Belum ada lisensi." },
      limits: null,
    }),
  );
  const state = await client.entitlement();
  assert.equal(state.entitlement, null);
  assert.equal(state.verdict.state, "none");
  assert.equal(state.limits, null);
});

test("entitlement dengan bentuk tak dikenal tidak melempar", async () => {
  const { client } = clientWith(() => jsonResponse({ apa: "ini" }));
  const state = await client.entitlement();
  assert.equal(state.entitlement, null);
  assert.equal(state.verdict.allowed, false);
  assert.equal(state.verdict.state, "none");
});
