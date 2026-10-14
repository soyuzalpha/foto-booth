/**
 * Tes rute branding (Fase 9, FEATURE-MATRIX #61).
 *
 * Yang diuji bukan tampilan halaman tamu, tapi janji-janji yang gampang bocor:
 *
 *   · **`GET /v1/branding` publik** — halaman galeri tamu membacanya tanpa
 *     token; kalau ini butuh token, halaman tamu tidak akan pernah bisa
 *     menampilkan judul yang dipasang operator.
 *   · **`PUT` butuh token.** Tanpa itu, siapa pun bisa mengganti judul halaman
 *     galeri orang.
 *   · **Nilai dinormalkan sebelum disimpan.** `javascript:` di `logoUrl` dan
 *     baris baru di `heading` dirender ke HTML halaman tamu; keduanya harus
 *     mati di sini, bukan di klien.
 *   · **PUT menggabung, bukan menimpa.** Mengubah judul tidak boleh menghapus
 *     logo; `logoUrl: null` yang eksplisit tetap menghapus.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { APP_NAME, DEFAULT_BRANDING, BRANDING_HEADING_MAX } from "@foto-booth/shared";

import { makeHarness, type TestHarness } from "../testing.ts";

const OPERATOR = "operator@example.com";

async function login(h: TestHarness): Promise<string> {
  await h.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email: OPERATOR } });
  const code = h.mailer.lastCode(OPERATOR);
  assert.ok(code !== null, "kode OTP harus sampai ke mailer");
  const verified = await h.app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    payload: { email: OPERATOR, code },
  });
  assert.equal(verified.statusCode, 200);
  return (verified.json() as { token: string }).token;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

test("GET /v1/branding publik: tanpa setelan → default, isDefault true", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "GET", url: "/v1/branding" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { branding: unknown; isDefault: boolean };
    assert.deepEqual(body.branding, DEFAULT_BRANDING);
    assert.equal(body.isDefault, true);
  } finally {
    await h.close();
  }
});

test("PUT /v1/branding/admin tanpa token → 401", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({
      method: "PUT",
      url: "/v1/branding/admin",
      payload: { heading: "Pernikahan Andi & Sari" },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await h.close();
  }
});

test("PUT lalu GET: nilai tersimpan dan terbaca publik", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const put = await h.app.inject({
      method: "PUT",
      url: "/v1/branding/admin",
      headers: auth(token),
      payload: {
        heading: "Pernikahan Andi & Sari",
        subheading: "14 Oktober 2026 · #AndiSariForever",
        footer: "Terima kasih sudah hadir",
      },
    });
    assert.equal(put.statusCode, 200, put.body);
    const saved = (put.json() as { branding: { heading: string }; isDefault: boolean }).branding;
    assert.equal(saved.heading, "Pernikahan Andi & Sari");

    const get = await h.app.inject({ method: "GET", url: "/v1/branding" });
    const body = get.json() as { branding: { heading: string; subheading: string }; isDefault: boolean };
    assert.equal(body.branding.heading, "Pernikahan Andi & Sari");
    assert.equal(body.branding.subheading, "14 Oktober 2026 · #AndiSariForever");
    assert.equal(body.isDefault, false);
  } finally {
    await h.close();
  }
});

test("PUT menggabung: mengubah heading tidak menghapus logo", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    await h.app.inject({
      method: "PUT",
      url: "/v1/branding/admin",
      headers: auth(token),
      payload: { logoUrl: "https://cdn.example.com/logo.png", heading: "Judul lama" },
    });

    const put = await h.app.inject({
      method: "PUT",
      url: "/v1/branding/admin",
      headers: auth(token),
      payload: { heading: "Judul baru" },
    });
    const branding = (put.json() as { branding: { logoUrl: string | null; heading: string } }).branding;
    assert.equal(branding.heading, "Judul baru");
    assert.equal(branding.logoUrl, "https://cdn.example.com/logo.png");
  } finally {
    await h.close();
  }
});

test("logoUrl: javascript: dan data:text/html ditolak jadi null", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    for (const evil of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4="]) {
      const put = await h.app.inject({
        method: "PUT",
        url: "/v1/branding/admin",
        headers: auth(token),
        payload: { logoUrl: evil },
      });
      assert.equal(put.statusCode, 200, put.body);
      const branding = (put.json() as { branding: { logoUrl: string | null } }).branding;
      assert.equal(branding.logoUrl, null, `${evil} harus ditolak`);
    }
  } finally {
    await h.close();
  }
});

test("logoUrl https dan data:image diterima", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const ok = ["https://cdn.example.com/logo.png", "data:image/png;base64,iVBORw0KGgo="];
    for (const good of ok) {
      const put = await h.app.inject({
        method: "PUT",
        url: "/v1/branding/admin",
        headers: auth(token),
        payload: { logoUrl: good },
      });
      const branding = (put.json() as { branding: { logoUrl: string | null } }).branding;
      assert.equal(branding.logoUrl, good, `${good} harus diterima`);
    }
  } finally {
    await h.close();
  }
});

test("heading dipangkas ke batas dan baris baru dibuang", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const put = await h.app.inject({
      method: "PUT",
      url: "/v1/branding/admin",
      headers: auth(token),
      payload: { heading: `A${"x".repeat(200)}\nbaris kedua` },
    });
    const heading = (put.json() as { branding: { heading: string } }).branding.heading;
    assert.equal(heading.length, BRANDING_HEADING_MAX);
    assert.ok(!heading.includes("\n"), "baris baru harus hilang");
  } finally {
    await h.close();
  }
});

test("PUT body kosong → 400 (tidak ada yang diubah)", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const put = await h.app.inject({
      method: "PUT",
      url: "/v1/branding/admin",
      headers: auth(token),
      payload: {},
    });
    assert.equal(put.statusCode, 400);
  } finally {
    await h.close();
  }
});

test("DEFAULT_BRANDING tidak memakai nama aplikasi sebagai judul", async () => {
  // Judul default sengaja kosong supaya `resolvedHeading` bisa jatuh ke nama
  // acara dulu. Kalau defaultnya sudah berisi APP_NAME, nama acara tidak akan
  // pernah muncul di halaman tamu.
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "GET", url: "/v1/branding" });
    const branding = (res.json() as { branding: { heading: string } }).branding;
    assert.notEqual(branding.heading, APP_NAME);
    assert.equal(branding.heading, "");
  } finally {
    await h.close();
  }
});
