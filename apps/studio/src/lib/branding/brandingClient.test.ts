/**
 * Tes klien branding.
 *
 * Janji yang diuji:
 *
 *   1. **`GET /v1/branding` tidak butuh token** — halaman tamu memakainya, dan
 *      permintaan itu memang boleh datang tanpa sesi.
 *   2. **Simpan butuh token, dan menolak lebih awal tanpa token.** Kalau tidak,
 *      operator hanya melihat "gagal" tanpa tahu sebabnya.
 *   3. **Nilai rusak dari server dibersihkan, bukan diteruskan.** `heading`
 *      berisi baris baru tidak boleh lolos ke panel — nilai itu nanti dirender
 *      ke `<title>` halaman tamu.
 *   4. **`isDefault` dihitung kalau server tidak mengirimnya**, bukan ditebak.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_BRANDING, BRANDING_HEADING_MAX } from "@foto-booth/shared";

import {
  BrandingHttpError,
  createBrandingClient,
  parseBrandingState,
  type BrandingClientOptions,
} from "./brandingClient.ts";

const TOKEN = "tok-123";

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
  options: Partial<BrandingClientOptions> = {},
): { client: ReturnType<typeof createBrandingClient>; calls: Call[] } {
  const calls: Call[] = [];
  const client = createBrandingClient({
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

/* ---- Auth --------------------------------------------------------- */

test("GET /v1/branding tidak mengirim token", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ branding: DEFAULT_BRANDING }));
  await client.get();

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.url ?? "", /\/v1\/branding$/);
  const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, undefined);
});

test("simpan tanpa token ditolak di klien, tanpa menyentuh jaringan", async () => {
  const calls: Call[] = [];
  const client = createBrandingClient({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({});
    }) as typeof globalThis.fetch,
  });

  await assert.rejects(
    () => client.save({ heading: "Halo" }),
    (error: unknown) => error instanceof BrandingHttpError && error.status === 401,
  );
  assert.equal(calls.length, 0);
});

test("simpan mengirim token Bearer dan body JSON ke /branding/admin", async () => {
  const { client, calls } = clientWith(() =>
    jsonResponse({ branding: { ...DEFAULT_BRANDING, heading: "Halo" } }),
  );
  await client.save({ heading: "Halo" });

  assert.match(calls[0]?.url ?? "", /\/v1\/branding\/admin$/);
  assert.equal(calls[0]?.init?.method, "PUT");
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { heading: "Halo" });
});

/* ---- Pembersihan nilai -------------------------------------------- */

test("baris baru di heading dibersihkan sebelum sampai ke panel", async () => {
  const { client } = clientWith(() =>
    jsonResponse({ branding: { ...DEFAULT_BRANDING, heading: "Baris\nDua" } }),
  );
  const state = await client.get();

  assert.equal(state.branding.heading, "Baris Dua");
});

test("heading kepanjangan dipotong di batas, bukan diteruskan mentah", async () => {
  const { client } = clientWith(() =>
    jsonResponse({ branding: { ...DEFAULT_BRANDING, heading: "h".repeat(BRANDING_HEADING_MAX + 20) } }),
  );
  const state = await client.get();

  assert.equal(state.branding.heading.length, BRANDING_HEADING_MAX);
});

test("logoUrl ber-skema terlarang jadi null", async () => {
  const { client } = clientWith(() =>
    jsonResponse({ branding: { ...DEFAULT_BRANDING, logoUrl: "javascript:alert(1)" } }),
  );
  const state = await client.get();

  assert.equal(state.branding.logoUrl, null);
});

/* ---- isDefault ---------------------------------------------------- */

test("isDefault dipakai kalau server mengirimnya", async () => {
  const { client } = clientWith(() => jsonResponse({ branding: DEFAULT_BRANDING, isDefault: true }));
  const state = await client.get();

  assert.equal(state.isDefault, true);
});

test("isDefault dihitung kalau server tidak mengirimnya", () => {
  assert.equal(parseBrandingState({ branding: DEFAULT_BRANDING }).isDefault, true);
  assert.equal(
    parseBrandingState({ branding: { ...DEFAULT_BRANDING, heading: "Kita" } }).isDefault,
    false,
  );
});

test("balasan tidak berbentuk objek → default, bukan lemparan", () => {
  const state = parseBrandingState("bukan objek");
  assert.deepEqual(state.branding, DEFAULT_BRANDING);
  assert.equal(state.isDefault, true);
});

/* ---- Kegagalan HTTP ---------------------------------------------- */

test("pesan kegagalan diambil dari body JSON", async () => {
  const { client } = clientWith(() => jsonResponse({ message: "body tidak valid" }, 400));

  await assert.rejects(
    () => client.save({ heading: "x" }),
    (error: unknown) => error instanceof BrandingHttpError && error.message === "body tidak valid",
  );
});
