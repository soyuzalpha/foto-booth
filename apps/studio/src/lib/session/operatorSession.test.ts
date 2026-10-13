/**
 * Tes sesi operator.
 *
 * Yang diuji bukan "bisa menyimpan token", tapi dua janji yang gagalnya baru
 * terasa di lapangan:
 *
 *   1. **Token kedaluwarsa dibuang saat dibaca** — kalau tidak, panel galeri
 *      tampak login padahal setiap request 401, dan operator menyalahkan API.
 *   2. **Penyimpanan yang gagal tidak mematikan aplikasi** — mode privat dan
 *      kuota penuh membuat `setItem` melempar; kiosk harus tetap jalan.
 *
 * `localStorage` dipalsukan supaya batas kedaluwarsa bisa diuji tanpa menunggu
 * waktu nyata.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AuthHttpError,
  clearSession,
  createAuthClient,
  isSessionExpired,
  loadSession,
  parseSession,
  SESSION_STORAGE_KEY,
  saveSession,
  sessionFromApi,
  type OperatorSession,
  type StorageLike,
} from "./operatorSession.ts";

const NOW = new Date("2026-01-01T00:00:00Z");
const LATER = "2026-01-01T06:00:00.000Z";
const EARLIER = "2025-12-31T23:59:00.000Z";

/** `localStorage` palsu; `failOn` meniru mode privat / kuota penuh. */
function fakeStorage(options: { failOn?: "get" | "set" | "remove" } = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key) {
      if (options.failOn === "get") throw new Error("SecurityError");
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (options.failOn === "set") throw new Error("QuotaExceededError");
      data.set(key, value);
    },
    removeItem(key) {
      if (options.failOn === "remove") throw new Error("SecurityError");
      data.delete(key);
    },
  };
}

function session(overrides: Partial<OperatorSession> = {}): OperatorSession {
  return { token: "tok-1", email: "a@b.c", expiresAt: LATER, ...overrides };
}

test("parseSession menolak bentuk yang tidak lengkap", () => {
  assert.equal(parseSession(null), null);
  assert.equal(parseSession("bukan objek"), null);
  assert.equal(parseSession({}), null);
  assert.equal(parseSession({ token: "", email: "a@b.c", expiresAt: LATER }), null);
  assert.equal(parseSession({ token: "t", email: "", expiresAt: LATER }), null);
  assert.equal(parseSession({ token: "t", email: "a@b.c", expiresAt: "bukan tanggal" }), null);
});

test("parseSession mengembalikan hanya tiga field yang dipakai", () => {
  const parsed = parseSession({ token: "t", email: "a@b.c", expiresAt: LATER, isAdmin: true });
  assert.deepEqual(parsed, { token: "t", email: "a@b.c", expiresAt: LATER });
});

test("token yang berakhir tepat sekarang sudah dianggap kedaluwarsa", () => {
  // Batasnya `<=`: memperlakukannya sebagai sah cuma menunda 401 satu request.
  assert.equal(isSessionExpired(session({ expiresAt: NOW.toISOString() }), NOW), true);
  assert.equal(isSessionExpired(session({ expiresAt: LATER }), NOW), false);
});

test("loadSession membuang token kedaluwarsa DARI penyimpanan", () => {
  const storage = fakeStorage();
  storage.data.set(SESSION_STORAGE_KEY, JSON.stringify(session({ expiresAt: EARLIER })));

  assert.equal(loadSession(NOW, storage), null);
  // Yang penting: entrinya benar-benar hilang, bukan cuma disaring di memori.
  assert.equal(storage.data.has(SESSION_STORAGE_KEY), false);
});

test("loadSession mengembalikan sesi yang masih berlaku", () => {
  const storage = fakeStorage();
  const saved = session();
  storage.data.set(SESSION_STORAGE_KEY, JSON.stringify(saved));

  assert.deepEqual(loadSession(NOW, storage), saved);
});

test("loadSession tidak melempar untuk JSON rusak atau penyimpanan rusak", () => {
  const broken = fakeStorage();
  broken.data.set(SESSION_STORAGE_KEY, "{bukan json");

  assert.equal(loadSession(NOW, broken), null);
  assert.equal(loadSession(NOW, fakeStorage({ failOn: "get" })), null);
  assert.equal(loadSession(NOW, null), null);
});

test("saveSession mengembalikan false kalau penyimpanan menolak", () => {
  assert.equal(saveSession(session(), fakeStorage()), true);
  assert.equal(saveSession(session(), fakeStorage({ failOn: "set" })), false);
  assert.equal(saveSession(session(), null), false);
});

test("clearSession tidak melempar walau penyimpanan rusak", () => {
  assert.doesNotThrow(() => clearSession(fakeStorage({ failOn: "remove" })));
  assert.doesNotThrow(() => clearSession(null));
});

test("sessionFromApi memetakan balasan API apa adanya", () => {
  assert.deepEqual(
    sessionFromApi({ token: "t", email: "a@b.c", expiresAt: LATER }),
    { token: "t", email: "a@b.c", expiresAt: LATER },
  );
});

/* ------------------------------------------------------------------ *
 * Klien OTP
 * ------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("requestOtp memakai POST ke /v1/auth/otp/request dan tidak menyentuh kode", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const client = createAuthClient({
    baseUrl: "https://contoh.test",
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ sent: true, expiresAt: LATER });
    }) as typeof globalThis.fetch,
  });

  const result = await client.requestOtp("a@b.c");

  assert.equal(calls[0]!.url, "https://contoh.test/v1/auth/otp/request");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { email: "a@b.c" });
  assert.deepEqual(result, { sent: true, expiresAt: LATER });
});

test("requestOtp meneruskan kode hanya kalau server mengirimkannya (mode dev)", async () => {
  const client = createAuthClient({
    fetch: (async () => jsonResponse({ sent: true, expiresAt: LATER, code: "123456" })) as typeof globalThis.fetch,
  });

  assert.deepEqual(await client.requestOtp("a@b.c"), {
    sent: true,
    expiresAt: LATER,
    code: "123456",
  });
});

test("requestOtp menolak balasan yang tidak dikenali", async () => {
  const client = createAuthClient({
    fetch: (async () => jsonResponse({ ok: true })) as typeof globalThis.fetch,
  });

  await assert.rejects(() => client.requestOtp("a@b.c"), /tidak dikenali/);
});

test("verifyOtp mengembalikan sesi tervalidasi, dan menolak balasan tanpa token", async () => {
  const good = createAuthClient({
    fetch: (async () => jsonResponse({ token: "t", email: "a@b.c", expiresAt: LATER })) as typeof globalThis.fetch,
  });
  assert.deepEqual(await good.verifyOtp("a@b.c", "123456"), {
    token: "t",
    email: "a@b.c",
    expiresAt: LATER,
  });

  const bad = createAuthClient({
    fetch: (async () => jsonResponse({ email: "a@b.c" })) as typeof globalThis.fetch,
  });
  await assert.rejects(() => bad.verifyOtp("a@b.c", "123456"), /token yang sah/);
});

test("error HTTP membawa status dan pesan dari server", async () => {
  const client = createAuthClient({
    fetch: (async () =>
      jsonResponse({ error: "unauthorized", message: "kode salah", statusCode: 401 }, 401)) as typeof globalThis.fetch,
  });

  await assert.rejects(
    () => client.verifyOtp("a@b.c", "000000"),
    (error: unknown) => {
      assert.ok(error instanceof AuthHttpError);
      assert.equal(error.status, 401);
      assert.equal(error.message, "kode salah");
      return true;
    },
  );
});

test("balasan error yang bukan JSON tetap menghasilkan pesan yang bisa dibaca", async () => {
  const client = createAuthClient({
    fetch: (async () => new Response("<html>502</html>", { status: 502 })) as typeof globalThis.fetch,
  });

  await assert.rejects(() => client.requestOtp("a@b.c"), /HTTP 502/);
});
