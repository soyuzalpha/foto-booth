/**
 * Tes klien guestbook.
 *
 * Janji yang diuji:
 *
 *   1. **Rute tamu tidak mengirim token; rute operator mengirimnya.** Kalau
 *      token ikut ke endpoint publik, ia hanya menambah permukaan kebocoran.
 *   2. **Satu entri rusak dibuang, sisanya tetap tampil.** Dinding guestbook
 *      tidak boleh kosong gara-gara satu baris buruk.
 *   3. **Operator menolak lebih awal tanpa token** — 401 di klien, tanpa
 *      menyentuh jaringan.
 *   4. **`mediaUrl` mengarah ke API, bukan bucket.** Bucket privat; entri yang
 *      disembunyikan harus lewat jalur yang bisa menolak.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { API_PREFIX } from "@foto-booth/shared";

import {
  GuestbookHttpError,
  createGuestbookClient,
  parseEntries,
  type GuestbookClientOptions,
} from "./guestbookClient.ts";

const TOKEN = "tok-123";

function entryRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gb-1",
    eventId: "evt-1",
    galleryId: "gal-1",
    kind: "video",
    contentType: "video/webm",
    key: "events/evt-1/guestbook/gb-1.webm",
    durationSeconds: 12,
    bytes: 4096,
    label: "Tamu",
    visible: true,
    createdAt: "2026-10-14T02:00:00.000Z",
    ...overrides,
  };
}

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
  options: Partial<GuestbookClientOptions> = {},
): { client: ReturnType<typeof createGuestbookClient>; calls: Call[] } {
  const calls: Call[] = [];
  const client = createGuestbookClient({
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

test("rute tamu tidak mengirim token", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ entries: [], total: 0 }));
  await client.wall({ eventId: "evt-1" });

  const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, undefined);
});

test("rute operator mengirim token Bearer", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ entries: [], total: 0 }));
  await client.adminList("evt-1");

  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
});

test("operator tanpa token ditolak di klien, tanpa menyentuh jaringan", async () => {
  const calls: Call[] = [];
  const client = createGuestbookClient({
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({});
    }) as typeof globalThis.fetch,
  });

  await assert.rejects(
    () => client.adminList("evt-1"),
    (error: unknown) => error instanceof GuestbookHttpError && error.status === 401,
  );
  await assert.rejects(
    () => client.setVisible("gb-1", false),
    (error: unknown) => error instanceof GuestbookHttpError && error.status === 401,
  );
  await assert.rejects(
    () => client.remove("gb-1"),
    (error: unknown) => error instanceof GuestbookHttpError && error.status === 401,
  );
  assert.equal(calls.length, 0);
});

/* ---- Validasi per-item ------------------------------------------- */

test("entri rusak dibuang, sisanya tetap tampil", () => {
  const entries = parseEntries([
    entryRaw({ id: "gb-1" }),
    { id: "gb-2" }, // tidak lengkap → dibuang
    entryRaw({ id: "gb-3", kind: "audio", contentType: "audio/webm" }),
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["gb-1", "gb-3"],
  );
});

test("balasan bukan array → dinding kosong, bukan lemparan", async () => {
  const { client } = clientWith(() => jsonResponse({ entries: "bukan array", total: 3 }));
  const wall = await client.wall({ eventId: "evt-1" });

  assert.deepEqual(wall.entries, []);
  assert.equal(wall.total, 3);
});

/* ---- Upload & rekam ---------------------------------------------- */

test("upload-url dan record memakai body JSON, tanpa token", async () => {
  const { client, calls } = clientWith((call) => {
    if (call.url.endsWith("/guestbook/upload-url")) {
      return jsonResponse({
        photoId: "gb-9",
        uploadUrl: "https://bucket.example/put",
        thumbUploadUrl: "https://bucket.example/put",
        key: "events/evt-1/guestbook/gb-9.webm",
        thumbKey: "events/evt-1/guestbook/gb-9.webm",
        expiresAt: "2026-10-14T03:00:00.000Z",
      });
    }
    return jsonResponse({ entry: entryRaw({ id: "gb-9" }) }, 201);
  });

  const signed = await client.requestUploadUrl({
    galleryHash: "abc123",
    kind: "video",
    contentType: "video/webm",
    durationSeconds: 12,
    bytes: 4096,
    consent: true,
  });
  assert.equal(signed.key, "events/evt-1/guestbook/gb-9.webm");

  const entry = await client.record({
    galleryHash: "abc123",
    kind: "video",
    contentType: "video/webm",
    durationSeconds: 12,
    bytes: 4096,
    consent: true,
    key: signed.key,
    label: "Rina",
  });
  assert.equal(entry.id, "gb-9");

  const headers = calls[1]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, undefined);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)).label, "Rina");
});

/* ---- URL media ---------------------------------------------------- */

test("mediaUrl menunjuk ke API, bukan bucket", () => {
  const client = createGuestbookClient({ baseUrl: "https://api.example" });
  assert.equal(client.mediaUrl("gb 1"), `https://api.example${API_PREFIX}/guestbook/gb%201/media`);
});

/* ---- Kegagalan ---------------------------------------------------- */

test("404 diteruskan sebagai error berstatus", async () => {
  const { client } = clientWith(() => jsonResponse({ message: "pesan tidak ditemukan" }, 404));

  await assert.rejects(
    () => client.setVisible("gb-x", false),
    (error: unknown) =>
      error instanceof GuestbookHttpError &&
      error.status === 404 &&
      error.message === "pesan tidak ditemukan",
  );
});
