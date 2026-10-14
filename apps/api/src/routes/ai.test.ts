/**
 * Tes proxy AI BYOK (Fase 8) — `POST /v1/ai/gemini`.
 *
 * Yang diuji di sini adalah janji-janji yang mahal kalau bocor:
 *
 *   · **Kunci tidak pernah keluar.** Tidak di balasan, tidak di URL upstream
 *     (kunci ke Google lewat header), tidak di query. Tes ini memeriksa URL
 *     yang benar-benar dipanggil `fetch` — kalau suatu hari kunci ikut ke query
 *     string, tes gagal.
 *   · **Kunci tidak bisa dipalsukan klien jadi prompt bebas.** Yang dikirim ke
 *     Gemini dibangun ulang server dari `task`/`style`/`custom`, jadi teks yang
 *     sampai ke upstream selalu bisa direproduksi.
 *   · **Foto asli tidak pernah hilang.** Semua kegagalan (kunci ditolak, kuota,
 *     diblokir, tanpa gambar, timeout) jadi balasan error yang jelas — tidak ada
 *     yang melempar ke luar handler.
 *   · **Rute ini bukan relay gratis.** Tanpa token operator, tanpa kunci yang
 *     masuk akal, atau terlalu sering → ditolak sebelum menyentuh jaringan.
 *
 * `fetch` di konteks palsu menolak secara default, jadi tes yang lupa
 * memalsukannya gagal dengan pesan jelas, bukan memanggil Google diam-diam.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_GEMINI_PATH,
  AI_KEY_HEADER,
  AI_MAX_INPUT_BYTES,
  AI_RATE_LIMIT,
  buildAiPrompt,
} from "@foto-booth/shared";

import { makeHarness, type TestHarness } from "../testing.ts";

const OPERATOR = "operator@example.com";
const KEY = "AIzaSyD-abcdefghijklmnopqrstuvwxyz_0123";

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

function headers(token: string, key: string | null = KEY): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(key === null ? {} : { [AI_KEY_HEADER]: key }),
  };
}

/** Body permintaan yang sah; tes hanya menimpa bagian yang penting. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { task: "style", style: "anime", mimeType: "image/jpeg", image: "AAAA", ...overrides };
}

interface FakeCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

/** `fetch` palsu yang merekam panggilan, bukan menyentuh jaringan. */
function fakeFetch(respond: (call: FakeCall) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fn = (async (url: unknown, init: unknown) => {
    const call: FakeCall = {
      url: String(url),
      init: (init ?? {}) as RequestInit,
      body: JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")),
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

function geminiImage(image = "BBBB", mimeType = "image/png"): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType, data: image } }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/* ---- Akses --------------------------------------------------------- */

test("tanpa token operator → 401, tanpa menyentuh jaringan", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(""), payload: body() });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { error: string }).error, "unauthorized");
  } finally {
    await h.close();
  }
});

test("tanpa header kunci → 401 dengan alasan yang bisa dibaca UI", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const res = await h.app.inject({
      method: "POST",
      url: AI_GEMINI_PATH,
      headers: headers(token, null),
      payload: body(),
    });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { reason: string }).reason, "no_key");
  } finally {
    await h.close();
  }
});

test("kunci yang jelas salah tempel ditolak sebelum memanggil upstream", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const res = await h.app.inject({
      method: "POST",
      url: AI_GEMINI_PATH,
      headers: headers(token, "AIza pendek"),
      payload: body(),
    });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { reason: string }).reason, "no_key");
  } finally {
    await h.close();
  }
});

test("body yang tidak sesuai bentuk → 400", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    for (const payload of [
      body({ task: "upscale" }),
      body({ style: "vaporwave" }),
      body({ mimeType: "video/mp4" }),
      body({ image: "" }),
      body({ custom: "x".repeat(5000) }),
    ]) {
      const res = await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(token), payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
  } finally {
    await h.close();
  }
});

test("gambar melebihi batas ditolak 413 sebelum dikirim ke Gemini", async () => {
  const { fetch: fake, calls } = fakeFetch(() => geminiImage());
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    // base64 ~4/3 dari byte biner; lewati batas dengan margin aman.
    const oversized = "A".repeat(Math.ceil((AI_MAX_INPUT_BYTES * 4) / 3) + 8);
    const res = await h.app.inject({
      method: "POST",
      url: AI_GEMINI_PATH,
      headers: headers(token),
      payload: body({ image: oversized }),
    });
    assert.equal(res.statusCode, 413);
    assert.equal((res.json() as { error: string }).error, "image_too_large");
    assert.equal(calls.length, 0, "upstream tidak boleh dipanggil untuk gambar kebesaran");
  } finally {
    await h.close();
  }
});

/* ---- Jalur bahagia ------------------------------------------------- */

test("permintaan sah → gambar hasil + prompt yang benar-benar dipakai", async () => {
  const { fetch: fake, calls } = fakeFetch(() => geminiImage("HASIL"));
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    const res = await h.app.inject({
      method: "POST",
      url: AI_GEMINI_PATH,
      headers: headers(token),
      payload: body({ custom: "dengan langit senja" }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const json = res.json() as { image: string; mimeType: string; prompt: string };
    assert.equal(json.image, "HASIL");
    assert.equal(json.mimeType, "image/png");
    // Prompt di balasan = prompt yang dikirim ke upstream = prompt shared.
    assert.equal(json.prompt, buildAiPrompt("style", "anime", "dengan langit senja"));

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    const parts = (call.body as { contents: { parts: unknown[] }[] }).contents[0]!.parts as {
      text?: string;
      inlineData?: { mimeType: string; data: string };
    }[];
    assert.equal(parts[0]?.text, json.prompt);
    assert.equal(parts[1]?.inlineData?.data, "AAAA");
    assert.equal(parts[1]?.inlineData?.mimeType, "image/jpeg");
  } finally {
    await h.close();
  }
});

test("kunci dikirim lewat header ke upstream, tidak pernah ke URL atau body", async () => {
  const { fetch: fake, calls } = fakeFetch(() => geminiImage());
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(token), payload: body() });

    const call = calls[0]!;
    const sent = call.init.headers as Record<string, string>;
    assert.equal(sent["x-goog-api-key"], KEY);
    // Yang paling penting: kunci tidak ada di URL (bocor lewat log/Referer) …
    assert.ok(!call.url.includes(KEY), "kunci tidak boleh ada di URL upstream");
    // … dan tidak ada di body permintaan.
    assert.ok(!JSON.stringify(call.body).includes(KEY), "kunci tidak boleh ada di body upstream");
  } finally {
    await h.close();
  }
});

test("balasan sukses tidak pernah memuat kunci", async () => {
  const { fetch: fake } = fakeFetch(() => geminiImage());
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    const res = await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(token), payload: body() });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes(KEY), "kunci bocor di balasan");
  } finally {
    await h.close();
  }
});

/* ---- Kegagalan upstream -------------------------------------------- */

test("kunci ditolak Google → 401, bukan 500", async () => {
  const { fetch: fake } = fakeFetch(() => new Response("{\"error\":{}}", { status: 403 }));
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    const res = await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(token), payload: body() });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { reason: string }).reason, "rejected");
  } finally {
    await h.close();
  }
});

test("kuota penuh → 429 dengan reason rate_limited", async () => {
  const { fetch: fake } = fakeFetch(() => new Response("{}", { status: 429 }));
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    const res = await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(token), payload: body() });
    assert.equal(res.statusCode, 429);
    assert.equal((res.json() as { reason: string }).reason, "rate_limited");
  } finally {
    await h.close();
  }
});

test("jawaban tanpa gambar → 502 no_image", async () => {
  const { fetch: fake } = fakeFetch(
    () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "maaf" }] } }] }), { status: 200 }),
  );
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    const res = await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(token), payload: body() });
    assert.equal(res.statusCode, 502);
    assert.equal((res.json() as { reason: string }).reason, "no_image");
  } finally {
    await h.close();
  }
});

test("diblokir filter → 422 dan alasannya disebut", async () => {
  const { fetch: fake } = fakeFetch(
    () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 }),
  );
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    const res = await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(token), payload: body() });
    assert.equal(res.statusCode, 422);
    const json = res.json() as { reason: string; message: string };
    assert.equal(json.reason, "blocked");
    assert.ok(json.message.includes("SAFETY"));
  } finally {
    await h.close();
  }
});

test("jaringan gagal → 502 network, bukan lempar", async () => {
  const { fetch: fake } = fakeFetch(() => {
    throw new Error("koneksi putus");
  });
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    const res = await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(token), payload: body() });
    assert.equal(res.statusCode, 502);
    assert.equal((res.json() as { reason: string }).reason, "network");
  } finally {
    await h.close();
  }
});

test("waktu habis → 504 timeout (kiosk tidak boleh menggantung)", async () => {
  const { fetch: fake } = fakeFetch(() => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  });
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    const res = await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(token), payload: body() });
    assert.equal(res.statusCode, 504);
    assert.equal((res.json() as { reason: string }).reason, "timeout");
  } finally {
    await h.close();
  }
});

test("jawaban upstream bukan JSON → 502 upstream", async () => {
  const { fetch: fake } = fakeFetch(() => new Response("<html>bukan json</html>", { status: 200 }));
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    const res = await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(token), payload: body() });
    assert.equal(res.statusCode, 502);
    assert.equal((res.json() as { reason: string }).reason, "upstream");
  } finally {
    await h.close();
  }
});

/* ---- Pembatas laju -------------------------------------------------- */

test("pembatas laju per kunci: yang ke-(N+1) ditolak 429", async () => {
  const { fetch: fake } = fakeFetch(() => geminiImage());
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    for (let i = 0; i < AI_RATE_LIMIT; i += 1) {
      const res = await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(token), payload: body() });
      assert.equal(res.statusCode, 200, `permintaan ke-${i + 1} harus lolos`);
    }
    const blocked = await h.app.inject({
      method: "POST",
      url: AI_GEMINI_PATH,
      headers: headers(token),
      payload: body(),
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal((blocked.json() as { reason: string }).reason, "rate_limited");
    assert.ok(blocked.headers["retry-after"], "harus menyertakan Retry-After");
  } finally {
    await h.close();
  }
});

test("pembatas laju memisahkan kunci yang berbeda", async () => {
  const { fetch: fake } = fakeFetch(() => geminiImage());
  const h = await makeHarness({ fetch: fake });
  try {
    const token = await login(h);
    for (let i = 0; i < AI_RATE_LIMIT; i += 1) {
      await h.app.inject({ method: "POST", url: AI_GEMINI_PATH, headers: headers(token), payload: body() });
    }
    const otherKey = "AIzaSyD-zyxwvutsrqponmlkjihgfedcba_9876";
    const res = await h.app.inject({
      method: "POST",
      url: AI_GEMINI_PATH,
      headers: headers(token, otherKey),
      payload: body(),
    });
    assert.equal(res.statusCode, 200, "kunci lain harus punya jatah sendiri");
  } finally {
    await h.close();
  }
});
