/**
 * Tes klien proxy AI (Fase 8).
 *
 * Dua janji yang diuji di sini, dan keduanya mahal kalau bocor:
 *
 *   1. **Kunci hanya di header.** `fetch` palsu memeriksa header & body; kalau
 *      suatu hari kunci ikut ke body (dan karenanya ke log server), tes gagal.
 *   2. **Tidak ada yang melempar.** Jalur foto kiosk memanggil ini; kegagalan
 *      apa pun harus kembali sebagai `{ ok: false, reason }` supaya foto asli
 *      tetap dipakai. Termasuk: jaringan mati, batas waktu, dan balasan yang
 *      bukan JSON.
 *
 * `reason` diuji karena UI memutuskan dari situ: `rate_limited` menawarkan coba
 * lagi, `rejected` membuka pengaturan, `blocked` tidak menawarkan apa pun.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AI_GEMINI_PATH, AI_KEY_HEADER } from "@foto-booth/shared";

import { createAiClient, messageFromBody, reasonFromBody } from "./aiClient.ts";

const KEY = "AIzaSyD-abcdefghijklmnopqrstuvwxyz_0123";
const TOKEN = "token-operator";

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = (async (url: unknown, init: unknown) => {
    const call: Call = {
      url: String(url),
      init: (init ?? {}) as RequestInit,
      body: JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as Record<string, unknown>,
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

function client(fetchImpl: typeof globalThis.fetch, overrides: { token?: string; key?: string } = {}) {
  return createAiClient({
    token: overrides.token ?? TOKEN,
    key: overrides.key ?? KEY,
    fetch: fetchImpl,
  });
}

const INPUT = {
  task: "style" as const,
  style: "anime" as const,
  mimeType: "image/jpeg" as const,
  image: "AAAA",
};

function ok(image = "BBBB", mimeType = "image/png", prompt = "prompt"): Response {
  return new Response(JSON.stringify({ image, mimeType, prompt }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function failure(status: number, reason: string, message = "pesan server"): Response {
  return new Response(JSON.stringify({ error: reason, reason, message, statusCode: status }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* ---- Jalur bahagia ------------------------------------------------- */

test("permintaan sah → hasil + prompt, tanpa kunci di body", async () => {
  const { fetch: fake, calls } = fakeFetch(() => ok("HASIL", "image/jpeg", "Restyle this photo…"));
  const result = await client(fake).generate({ ...INPUT, custom: "langit senja" });

  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.image : null, "HASIL");
  assert.equal(result.ok === true ? result.mimeType : null, "image/jpeg");
  assert.equal(result.ok === true ? result.prompt : null, "Restyle this photo…");

  const call = calls[0]!;
  assert.ok(call.url.endsWith(AI_GEMINI_PATH), call.url);
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers[AI_KEY_HEADER], KEY);
  assert.deepEqual(call.body, {
    task: "style",
    style: "anime",
    custom: "langit senja",
    mimeType: "image/jpeg",
    image: "AAAA",
  });
  // Kunci tidak boleh ada di body (bocor lewat log) atau di URL.
  assert.ok(!JSON.stringify(call.body).includes(KEY));
  assert.ok(!call.url.includes(KEY));
});

test("tanpa instruksi tambahan, field `custom` tidak dikirim", async () => {
  const { fetch: fake, calls } = fakeFetch(() => ok());
  await client(fake).generate(INPUT);
  assert.ok(!("custom" in calls[0]!.body), "custom kosong tidak perlu dikirim");
});

/* ---- Kegagalan ------------------------------------------------------ */

test("kegagalan server dipetakan ke reason yang stabil", async () => {
  const cases: [number, string][] = [
    [401, "rejected"],
    [429, "rate_limited"],
    [413, "too_large"],
    [422, "blocked"],
    [502, "no_image"],
    [504, "timeout"],
  ];
  for (const [status, reason] of cases) {
    const { fetch: fake } = fakeFetch(() => failure(status, reason));
    const result = await client(fake).generate(INPUT);
    assert.equal(result.ok, false, `status ${status}`);
    assert.equal(result.ok === false ? result.reason : null, reason);
    assert.equal(result.ok === false ? result.status : null, status);
  }
});

test("hanya kegagalan sementara yang ditandai retryable", async () => {
  const retryable: [number, string, boolean][] = [
    [429, "rate_limited", true],
    [504, "timeout", true],
    [502, "no_image", false],
    [401, "rejected", false],
    [422, "blocked", false],
    [400, "invalid", false],
  ];
  for (const [status, reason, expected] of retryable) {
    const { fetch: fake } = fakeFetch(() => failure(status, reason));
    const result = await client(fake).generate(INPUT);
    assert.equal(result.ok === false ? result.retryable : null, expected, reason);
  }
});

test("jaringan gagal → reason network, bukan lempar", async () => {
  const { fetch: fake } = fakeFetch(() => {
    throw new Error("koneksi putus");
  });
  const result = await client(fake).generate(INPUT);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : null, "network");
  assert.equal(result.ok === false ? result.retryable : null, true);
});

test("batas waktu lokal → reason timeout", async () => {
  const { fetch: fake } = fakeFetch(() => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  });
  const result = await client(fake, {}).generate(INPUT);
  assert.equal(result.ok === false ? result.reason : null, "timeout");
});

test("balasan bukan JSON → reason no_image, bukan lempar", async () => {
  const { fetch: fake } = fakeFetch(() => new Response("<html>", { status: 200 }));
  const result = await client(fake).generate(INPUT);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : null, "no_image");
});

test("balasan sukses tanpa gambar → no_image", async () => {
  const { fetch: fake } = fakeFetch(
    () => new Response(JSON.stringify({ prompt: "x" }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  const result = await client(fake).generate(INPUT);
  assert.equal(result.ok === false ? result.reason : null, "no_image");
});

test("pesan error tidak pernah memuat kunci", async () => {
  const { fetch: fake } = fakeFetch(() => failure(401, "rejected", "kunci Gemini ditolak"));
  const result = await client(fake).generate(INPUT);
  assert.equal(result.ok, false);
  assert.ok(!(result.ok === false ? result.message : "").includes(KEY));
});

/* ---- Pemetaan body -------------------------------------------------- */

test("reasonFromBody mengenali kode lama & tidak dikenal", () => {
  assert.equal(reasonFromBody({ reason: "rate_limited" }), "rate_limited");
  assert.equal(reasonFromBody({ error: "unauthorized" }), "unauthorized");
  assert.equal(reasonFromBody({ error: "image_too_large" }), "too_large");
  assert.equal(reasonFromBody({ error: "sesuatu" }), "unknown");
  assert.equal(reasonFromBody(null), "unknown");
  assert.equal(reasonFromBody("teks"), "unknown");
});

test("messageFromBody memakai pesan server, atau status", () => {
  assert.equal(messageFromBody({ message: "kuota penuh" }, 429), "kuota penuh");
  assert.equal(messageFromBody({}, 500), "HTTP 500");
  assert.equal(messageFromBody(null, 502), "HTTP 502");
});
