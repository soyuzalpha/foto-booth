/**
 * Tes rute lisensi & order (Fase 10, FEATURE-MATRIX #84–#85).
 *
 * Yang diuji adalah janji-janji yang mahal kalau bocor:
 *
 *   · **Harga tidak pernah datang dari klien.** Body order yang mengirim
 *     `amountIdr: 1` tetap dicatat seharga katalog. Kalau ini bocor, pemegang
 *     token operator bisa membeli lisensi komersial seharga seribu rupiah.
 *   · **Kode aktivasi hanya terbit saat lunas.** Order yang masih `created`
 *     atau `pending` tidak boleh punya kode — kode yang sudah beredar sebelum
 *     uang masuk tidak bisa ditarik kembali.
 *   · **Transisi status tidak bisa mundur.** `paid → pending` dan
 *     `refunded → paid` harus 409; webhook gateway yang datang terlambat tidak
 *     boleh menghidupkan lisensi yang dananya sudah kembali.
 *   · **Refund mencabut kode.** Kode yang masih hidup setelah refund membuat
 *     pelanggan yang uangnya kembali tetap bisa mengaktifkan perangkatnya.
 *   · **Kode hanya bisa ditebus sekali.** Dua permintaan aktivasi bersamaan
 *     (klik ganda) tidak boleh menerbitkan lisensi dua kali.
 *   · **Provider yang belum hidup menjawab 501**, bukan membuat order yang
 *     menggantung di status yang tidak akan pernah bisa dibayar.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LICENSE_CATALOG, formatActivationCode, isActivationCode } from "@foto-booth/shared";

import { makeHarness, type TestHarness } from "../testing.ts";

const OPERATOR = "operator@example.com";

async function login(h: TestHarness, email = OPERATOR): Promise<string> {
  await h.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } });
  const code = h.mailer.lastCode(email);
  assert.ok(code !== null, "kode OTP harus sampai ke mailer");
  const verified = await h.app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    payload: { email, code },
  });
  assert.equal(verified.statusCode, 200);
  return (verified.json() as { token: string }).token;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

type OrderBody = {
  id: string;
  status: string;
  sku: string;
  skuName: string;
  amountIdr: number;
  reference: string | null;
  referenceFormatted: string | null;
  paidAt: string | null;
};

/** Buat order `manual`; mengembalikan order dari balasan. */
async function createOrder(
  h: TestHarness,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<OrderBody> {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/license/orders",
    headers: auth(token),
    payload: { sku: "booth-commercial", email: OPERATOR, provider: "manual", ...overrides },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { order: OrderBody }).order;
}

/** Pindahkan status order; `expect` = status HTTP yang diharapkan. */
async function setStatus(
  h: TestHarness,
  token: string,
  id: string,
  status: string,
  expect = 200,
): Promise<{ order: OrderBody; issuedCode: { code: string; formatted: string; state: string } | null }> {
  const res = await h.app.inject({
    method: "POST",
    url: `/v1/license/orders/${id}/status`,
    headers: auth(token),
    payload: { status },
  });
  assert.equal(res.statusCode, expect, res.body);
  return res.json() as { order: OrderBody; issuedCode: null };
}

/** Order yang sudah lunas + kode aktivasi terbit. */
async function paidOrder(
  h: TestHarness,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<{ order: OrderBody; code: string }> {
  const order = await createOrder(h, token, overrides);
  await setStatus(h, token, order.id, "pending");
  const { order: paid, issuedCode } = await setStatus(h, token, order.id, "paid");
  assert.ok(issuedCode !== null, "order lunas harus menerbitkan kode aktivasi");
  assert.ok(paid.reference !== null, "reference order lunas harus terisi");
  return { order: paid, code: issuedCode.code };
}

/* ---- Katalog ------------------------------------------------------ */

test("GET /v1/license/catalog publik: SKU + harga + provider live", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "GET", url: "/v1/license/catalog" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      items: { sku: string; priceIdr: number; limits: { maxActiveGalleries: number | null } }[];
      providers: { id: string; live: boolean }[];
    };
    assert.equal(body.items.length, 2);
    const commercial = body.items.find((i) => i.sku === "booth-commercial");
    assert.ok(commercial !== undefined);
    assert.equal(commercial.priceIdr, LICENSE_CATALOG["booth-commercial"].priceIdr);
    // Komersial tanpa batas galeri; kalau ini berubah, panel harga ikut bohong.
    assert.equal(commercial.limits.maxActiveGalleries, null);

    const qris = body.providers.find((p) => p.id === "qris");
    assert.ok(qris !== undefined);
    assert.equal(qris.live, false, "qris belum tersambung — katalog harus jujur");
    assert.equal(body.providers.find((p) => p.id === "manual")?.live, true);
  } finally {
    await h.close();
  }
});

/* ---- Penjaga token ------------------------------------------------ */

test("semua rute order & aktivasi butuh token operator", async () => {
  const h = await makeHarness();
  try {
    const calls = [
      { method: "GET" as const, url: "/v1/license/orders" },
      { method: "POST" as const, url: "/v1/license/orders" },
      { method: "GET" as const, url: "/v1/license/orders/ord_x" },
      { method: "POST" as const, url: "/v1/license/orders/ord_x/status" },
      { method: "GET" as const, url: "/v1/license/activation-codes" },
      { method: "POST" as const, url: "/v1/license/activate" },
      { method: "GET" as const, url: "/v1/license/entitlement" },
    ];
    for (const call of calls) {
      const res = await h.app.inject(call);
      assert.equal(res.statusCode, 401, `${call.method} ${call.url} harus 401 tanpa token`);
    }
  } finally {
    await h.close();
  }
});

/* ---- Order -------------------------------------------------------- */

test("harga diambil dari katalog, bukan dari body klien", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const order = await createOrder(h, token, { amountIdr: 1, skuName: "Gratis", priceIdr: 0 });
    assert.equal(order.amountIdr, LICENSE_CATALOG["booth-commercial"].priceIdr);
    assert.equal(order.skuName, LICENSE_CATALOG["booth-commercial"].name);
    assert.equal(order.status, "created");
    assert.equal(order.reference, null, "belum lunas → belum ada kode");
  } finally {
    await h.close();
  }
});

test("provider qris menjawab 501, bukan order menggantung", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/license/orders",
      headers: auth(token),
      payload: { sku: "booth-personal", email: OPERATOR, provider: "qris" },
    });
    assert.equal(res.statusCode, 501);
    const body = res.json() as { error: string };
    assert.equal(body.error, "payment_unavailable");

    // Dan benar-benar tidak ada baris yang tertulis.
    const list = await h.app.inject({ method: "GET", url: "/v1/license/orders", headers: auth(token) });
    assert.deepEqual((list.json() as { orders: unknown[] }).orders, []);
  } finally {
    await h.close();
  }
});

test("SKU & provider tak dikenal ditolak 400", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    for (const payload of [
      { sku: "booth-enterprise", email: OPERATOR, provider: "manual" },
      { sku: "booth-personal", email: OPERATOR, provider: "bitcoin" },
      { sku: "booth-personal", email: "bukan-email", provider: "manual" },
    ]) {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/license/orders",
        headers: auth(token),
        payload,
      });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
  } finally {
    await h.close();
  }
});

test("daftar order bisa disaring status & email", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const a = await createOrder(h, token, { email: "a@example.com" });
    await createOrder(h, token, { email: "b@example.com" });
    await setStatus(h, token, a.id, "pending");

    const byStatus = await h.app.inject({
      method: "GET",
      url: "/v1/license/orders?status=pending",
      headers: auth(token),
    });
    const pending = (byStatus.json() as { orders: OrderBody[] }).orders;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.id, a.id);

    const byEmail = await h.app.inject({
      method: "GET",
      url: "/v1/license/orders?email=b%40example.com",
      headers: auth(token),
    });
    assert.equal((byEmail.json() as { orders: OrderBody[] }).orders.length, 1);

    const bad = await h.app.inject({
      method: "GET",
      url: "/v1/license/orders?status=lunas",
      headers: auth(token),
    });
    assert.equal(bad.statusCode, 400, "status tak dikenal harus 400, bukan daftar kosong");
  } finally {
    await h.close();
  }
});

test("GET satu order menyertakan kodenya; order tak ada → 404", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { order } = await paidOrder(h, token);

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/license/orders/${order.id}`,
      headers: auth(token),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { codes: { code: string; state: string }[] };
    assert.equal(body.codes.length, 1);
    assert.equal(body.codes[0]?.state, "unredeemed");

    const missing = await h.app.inject({
      method: "GET",
      url: "/v1/license/orders/ord_tidakada",
      headers: auth(token),
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await h.close();
  }
});

/* ---- Kode aktivasi terbit saat lunas ------------------------------ */

test("kode aktivasi hanya terbit saat lunas, dan berbentuk kode yang sah", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const order = await createOrder(h, token);

    // `created → created` bukan transisi; jawabannya error, bukan order.
    await setStatus(h, token, order.id, "created", 409);

    const pending = await setStatus(h, token, order.id, "pending");
    assert.equal(pending.issuedCode, null, "pending belum lunas → belum ada kode");
    assert.equal(pending.order.reference, null);

    const paid = await setStatus(h, token, order.id, "paid");
    assert.ok(paid.issuedCode !== null);
    assert.equal(paid.order.paidAt !== null, true, "paidAt harus terisi saat lunas");
    assert.equal(isActivationCode(paid.issuedCode.code), true);
    assert.equal(paid.issuedCode.code.length, 12);
    assert.equal(
      paid.issuedCode.formatted,
      formatActivationCode(paid.issuedCode.code),
      "bentuk tampilan = bentuk ternormalisasi berkelompok",
    );
    assert.equal(paid.order.reference, paid.issuedCode.code, "reference = kode yang diterbitkan");
  } finally {
    await h.close();
  }
});

test("dua order lunas menerbitkan dua kode berbeda", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const first = await paidOrder(h, token);
    const second = await paidOrder(h, token);
    assert.notEqual(first.code, second.code);
  } finally {
    await h.close();
  }
});

/* ---- Transisi status --------------------------------------------- */

test("transisi mundur ditolak 409", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { order } = await paidOrder(h, token);

    // paid → pending: webhook yang datang terlambat tidak boleh menurunkannya.
    await setStatus(h, token, order.id, "pending", 409);
    await setStatus(h, token, order.id, "failed", 409);
    // paid → paid: tidak ada perubahan.
    await setStatus(h, token, order.id, "paid", 409);
    // status tak dikenal.
    await setStatus(h, token, order.id, "lunas", 400);

    const still = await h.app.inject({
      method: "GET",
      url: `/v1/license/orders/${order.id}`,
      headers: auth(token),
    });
    assert.equal((still.json() as { order: OrderBody }).order.status, "paid");
  } finally {
    await h.close();
  }
});

test("order refunded tidak bisa dihidupkan lagi", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { order } = await paidOrder(h, token);
    await setStatus(h, token, order.id, "refunded");
    await setStatus(h, token, order.id, "paid", 409);
    await setStatus(h, token, order.id, "pending", 409);
  } finally {
    await h.close();
  }
});

test("refund mencabut kode yang sudah terbit", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { code } = await paidOrder(h, token);

    // Cari order lewat daftar kode supaya tes ini tidak bergantung pada
    // variabel yang mudah tertukar.
    const list = await h.app.inject({
      method: "GET",
      url: "/v1/license/activation-codes",
      headers: auth(token),
    });
    const codes = (list.json() as { codes: { code: string; state: string; orderId: string }[] }).codes;
    const entry = codes.find((c) => c.code === code);
    assert.ok(entry !== undefined);

    await setStatus(h, token, entry.orderId, "refunded");

    const after = await h.app.inject({
      method: "GET",
      url: "/v1/license/activation-codes",
      headers: auth(token),
    });
    const revoked = (after.json() as { codes: { code: string; state: string }[] }).codes.find(
      (c) => c.code === code,
    );
    assert.equal(revoked?.state, "revoked");

    // Dan kode itu memang tidak bisa ditebus lagi.
    const activate = await h.app.inject({
      method: "POST",
      url: "/v1/license/activate",
      headers: auth(token),
      payload: { code },
    });
    assert.equal(activate.statusCode, 409);
  } finally {
    await h.close();
  }
});

/* ---- Menebus kode ------------------------------------------------- */

test("menebus kode menerbitkan entitlement sesuai plan SKU", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { code } = await paidOrder(h, token, { sku: "booth-personal" });

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/license/activate",
      headers: auth(token),
      payload: { code: formatActivationCode(code) },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      entitlement: { plan: string; status: string; maxActiveGalleries: number | null };
      verdict: { allowed: boolean; state: string };
      limits: { allowsWhiteLabel: boolean; allowsCommercialUse: boolean };
      code: { state: string };
    };
    assert.equal(body.entitlement.plan, "personal");
    assert.equal(body.entitlement.status, "active");
    assert.equal(body.entitlement.maxActiveGalleries, 3);
    assert.equal(body.verdict.allowed, true);
    assert.equal(body.verdict.state, "active");
    assert.equal(body.limits.allowsWhiteLabel, false, "personal bukan white-label");
    assert.equal(body.code.state, "redeemed");
  } finally {
    await h.close();
  }
});

test("kode bisa ditebus walau ditulis dengan spasi & huruf kecil", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { code } = await paidOrder(h, token);
    const messy = ` ${formatActivationCode(code).toLowerCase()} `;

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/license/activate",
      headers: auth(token),
      payload: { code: messy },
    });
    assert.equal(res.statusCode, 200, res.body);
  } finally {
    await h.close();
  }
});

test("kode salah bentuk → 400, kode tak ada → 404, kode terpakai → 409", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);

    for (const bad of ["", "ABC", "AAAAAAAAAAAA".replace(/A/g, "I"), "1234567890IO"]) {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/license/activate",
        headers: auth(token),
        payload: { code: bad },
      });
      assert.equal(res.statusCode, 400, `"${bad}" harus 400 (bukan kode)`);
    }

    const missing = await h.app.inject({
      method: "POST",
      url: "/v1/license/activate",
      headers: auth(token),
      payload: { code: "ABCD-EFGH-JKLM" },
    });
    assert.equal(missing.statusCode, 404);

    const { code } = await paidOrder(h, token);
    const first = await h.app.inject({
      method: "POST",
      url: "/v1/license/activate",
      headers: auth(token),
      payload: { code },
    });
    assert.equal(first.statusCode, 200);

    const again = await h.app.inject({
      method: "POST",
      url: "/v1/license/activate",
      headers: auth(token),
      payload: { code },
    });
    assert.equal(again.statusCode, 409, "kode yang sama tidak boleh ditebus dua kali");
  } finally {
    await h.close();
  }
});

test("kode ditebus operator lain → entitlement milik operator itu, bukan pembuat order", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { code } = await paidOrder(h, token);

    const other = "lain@example.com";
    const otherToken = await login(h, other);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/license/activate",
      headers: auth(otherToken),
      payload: { code },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { entitlement: { email: string } }).entitlement.email, other);

    // Operator pertama tidak ikut mendapat lisensi.
    const mine = await h.app.inject({
      method: "GET",
      url: "/v1/license/entitlement",
      headers: auth(token),
    });
    assert.equal((mine.json() as { entitlement: unknown }).entitlement, null);
  } finally {
    await h.close();
  }
});

/* ---- Entitlement & batas galeri ---------------------------------- */

test("tanpa lisensi: verdict allowed false, dan galeri baru tetap boleh", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/license/entitlement",
      headers: auth(token),
    });
    const body = res.json() as { entitlement: unknown; verdict: { allowed: boolean; state: string } };
    assert.equal(body.entitlement, null);
    assert.equal(body.verdict.allowed, false);
    assert.equal(body.verdict.state, "none");

    // Tanpa lisensi (operator lokal) galeri tetap bisa dibuat — mode jujur
    // hari ini adalah "tanpa lisensi", bukan "terkunci".
    const event = await h.app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth(token),
      payload: { name: "Acara uji", date: "2026-10-14" },
    });
    assert.equal(event.statusCode, 201, event.body);
    const gallery = await h.app.inject({
      method: "POST",
      url: "/v1/galleries",
      headers: auth(token),
      payload: { eventId: (event.json() as { id: string }).id },
    });
    assert.equal(gallery.statusCode, 201, gallery.body);
  } finally {
    await h.close();
  }
});

test("lisensi personal membatasi galeri aktif (max 3)", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { code } = await paidOrder(h, token, { sku: "booth-personal" });
    await h.app.inject({
      method: "POST",
      url: "/v1/license/activate",
      headers: auth(token),
      payload: { code },
    });

    const event = await h.app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth(token),
      payload: { name: "Acara uji", date: "2026-10-14" },
    });
    const eventId = (event.json() as { id: string }).id;

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const gallery = await h.app.inject({
        method: "POST",
        url: "/v1/galleries",
        headers: auth(token),
        payload: { eventId },
      });
      statuses.push(gallery.statusCode);
    }
    assert.equal(statuses[3], 402, `galeri ke-4 harus ditolak lisensi (dapat ${statuses.join(",")})`);
  } finally {
    await h.close();
  }
});
