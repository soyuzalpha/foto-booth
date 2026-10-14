/**
 * Tes rute video guestbook (Fase 9, FEATURE-MATRIX #19).
 *
 * Yang diuji adalah janji-janji yang mahal kalau bocor:
 *
 *   · **`key` objek selalu milik acara yang benar.** Tamu meminta URL upload
 *     lewat hash galeri; id & key dibangun server. Mendaftarkan metadata dengan
 *     key milik acara lain harus ditolak, bukan diterima.
 *   · **Batas durasi/ukuran ditegakkan di server.** Klien menahannya, tapi
 *     klien bisa dimatikan; yang menentukan tetap validasi di sini.
 *   · **Entri yang disembunyikan tidak bisa dibaca tamu.** Baik dari daftar
 *     (`GET /v1/guestbook`) maupun dari byte medianya (`/media`) — id yang
 *     diketahui pun tidak boleh membocorkan berkas.
 *   · **Menghapus entri menghapus objeknya dulu.** Kalau baris dihapus lebih
 *     dulu, `key`-nya hilang dan berkas yatim tak bisa ditelusuri lagi.
 *
 * `fetch` palsu dipakai untuk jalur bucket (ambil & hapus objek) — tes tidak
 * pernah menyentuh jaringan, dan panggilan yang tidak diharapkan gagal jelas.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GUESTBOOK_MAX_SECONDS,
  GUESTBOOK_MAX_BYTES,
  guestbookKey,
} from "@foto-booth/shared";

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

/** Acara + galeri; mengembalikan hash galeri untuk jalur tamu. */
async function seedGallery(
  h: TestHarness,
  token: string,
): Promise<{ eventId: string; galleryId: string; hash: string }> {
  const event = await h.app.inject({
    method: "POST",
    url: "/v1/events",
    headers: auth(token),
    payload: { name: "Pernikahan Andi & Sari", date: "2026-10-14" },
  });
  assert.equal(event.statusCode, 201, event.body);
  const eventId = (event.json() as { id: string }).id;

  const gallery = await h.app.inject({
    method: "POST",
    url: "/v1/galleries",
    headers: auth(token),
    payload: { eventId },
  });
  assert.equal(gallery.statusCode, 201, gallery.body);
  const body = gallery.json() as { id: string; hash: string };
  return { eventId, galleryId: body.id, hash: body.hash };
}

/** Minta URL upload lalu daftarkan metadata; mengembalikan entri tersimpan. */
async function record(
  h: TestHarness,
  hash: string,
  bodyOverrides: Record<string, unknown> = {},
): Promise<{ statusCode: number; entry: { id: string; key: string; label: string; visible: boolean } }> {
  // URL upload selalu diminta dengan nilai sah; yang diuji lewat `bodyOverrides`
  // adalah pemeriksaan di `POST /v1/guestbook` (durasi/ukuran/label).
  const url = await h.app.inject({
    method: "POST",
    url: "/v1/guestbook/upload-url",
    payload: { galleryHash: hash, kind: "video", contentType: "video/webm", durationSeconds: 12, bytes: 4096, consent: true },
  });
  assert.equal(url.statusCode, 200, url.body);
  const signed = url.json() as { photoId: string; key: string };

  const res = await h.app.inject({
    method: "POST",
    url: "/v1/guestbook",
    payload: {
      galleryHash: hash,
      kind: "video",
      contentType: "video/webm",
      durationSeconds: 12,
      bytes: 4096,
      key: signed.key,
      consent: true,
      ...bodyOverrides,
    },
  });
  return { statusCode: res.statusCode, entry: (res.json() as { entry: never }).entry };
}

test("POST /v1/guestbook/upload-url publik: key di prefiks acara", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { eventId, hash } = await seedGallery(h, token);

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/guestbook/upload-url",
      payload: { galleryHash: hash, kind: "video", contentType: "video/webm", durationSeconds: 10, bytes: 2048, consent: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { key: string; uploadUrl: string };
    assert.ok(body.key.startsWith(`events/${eventId}/guestbook/`), body.key);
    assert.match(body.uploadUrl, /^http/, "URL harus bertanda tangan");
  } finally {
    await h.close();
  }
});

test("upload-url menolak hash galeri yang tidak ada", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/guestbook/upload-url",
      payload: { galleryHash: "tidakada", kind: "video", contentType: "video/webm", durationSeconds: 10, bytes: 2048 },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await h.close();
  }
});

test("POST /v1/guestbook menolak content type yang tidak didukung", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { eventId, hash } = await seedGallery(h, token);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/guestbook",
      payload: {
        galleryHash: hash,
        kind: "video",
        contentType: "application/zip",
        durationSeconds: 10,
        bytes: 2048,
        consent: true,
        key: guestbookKey(eventId, "gb123", "application/zip"),
      },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await h.close();
  }
});

test("POST /v1/guestbook menolak tanpa persetujuan UU PDP", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { eventId, hash } = await seedGallery(h, token);
    // Bentuk kiriman sah sepenuhnya kecuali centang persetujuan: harus ditolak
    // sebelum apa pun tersimpan, bukan diterima lalu dibersihkan belakangan.
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/guestbook",
      payload: {
        galleryHash: hash,
        kind: "video",
        contentType: "video/webm",
        durationSeconds: 10,
        bytes: 2048,
        key: guestbookKey(eventId, "gbnoconsent", "video/webm"),
      },
    });
    assert.equal(res.statusCode, 400, res.body);

    // Kiriman tanpa persetujuan tidak boleh menyisakan baris apa pun.
    const wall = await h.app.inject({ method: "GET", url: `/v1/guestbook?galleryHash=${hash}` });
    assert.equal((wall.json() as { entries: unknown[] }).entries.length, 0);
  } finally {
    await h.close();
  }
});

test("POST /v1/guestbook menolak durasi melebihi batas", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    const res = await record(h, hash, { durationSeconds: GUESTBOOK_MAX_SECONDS + 1 });
    assert.equal(res.statusCode, 400);
  } finally {
    await h.close();
  }
});

test("POST /v1/guestbook menolak berkas melebihi batas", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    const res = await record(h, hash, { bytes: GUESTBOOK_MAX_BYTES + 1 });
    assert.equal(res.statusCode, 400);
  } finally {
    await h.close();
  }
});

test("POST /v1/guestbook menolak key milik acara lain", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/guestbook",
      payload: {
        galleryHash: hash,
        kind: "video",
        contentType: "video/webm",
        durationSeconds: 10,
        bytes: 2048,
        consent: true,
        key: guestbookKey("acara-lain", "gb999", "video/webm"),
      },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await h.close();
  }
});

test("label kosong jadi 'Tamu', label terisi dipertahankan", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);

    const anon = await record(h, hash);
    assert.equal(anon.statusCode, 201, JSON.stringify(anon.entry));
    assert.equal(anon.entry.label, "Tamu");

    const named = await record(h, hash, { label: "  Budi  " });
    assert.equal(named.entry.label, "Budi");
  } finally {
    await h.close();
  }
});

test("GET /v1/guestbook publik: hanya entri terlihat", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    const a = await record(h, hash, { label: "Tamu A" });
    const b = await record(h, hash, { label: "Tamu B" });

    // Sembunyikan yang kedua sebagai operator.
    const hidden = await h.app.inject({
      method: "PATCH",
      url: `/v1/guestbook/admin/${b.entry.id}`,
      headers: auth(token),
      payload: { visible: false },
    });
    assert.equal(hidden.statusCode, 200, hidden.body);

    const list = await h.app.inject({ method: "GET", url: `/v1/guestbook?galleryHash=${hash}` });
    assert.equal(list.statusCode, 200, list.body);
    const entries = (list.json() as { entries: { id: string }[] }).entries;
    const ids = entries.map((entry) => entry.id);
    assert.ok(ids.includes(a.entry.id), "entri terlihat harus muncul");
    assert.ok(!ids.includes(b.entry.id), "entri tersembunyi tidak boleh muncul");
  } finally {
    await h.close();
  }
});

test("media entri tersembunyi → 404 (tidak bocor walau id diketahui)", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    const b = await record(h, hash);
    await h.app.inject({
      method: "PATCH",
      url: `/v1/guestbook/admin/${b.entry.id}`,
      headers: auth(token),
      payload: { visible: false },
    });

    const media = await h.app.inject({ method: "GET", url: `/v1/guestbook/${b.entry.id}/media` });
    assert.equal(media.statusCode, 404);
  } finally {
    await h.close();
  }
});

test("media entri terlihat diproksi dari bucket", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const calls: string[] = [];
  const h = await makeHarness({
    fetch: (async (url: unknown) => {
      calls.push(String(url));
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "video/webm", "content-length": String(bytes.byteLength) },
      });
    }) as unknown as typeof globalThis.fetch,
  });
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    const entry = await record(h, hash);

    const media = await h.app.inject({ method: "GET", url: `/v1/guestbook/${entry.entry.id}/media` });
    assert.equal(media.statusCode, 200, media.body);
    assert.equal(media.headers["content-type"], "video/webm");
    assert.equal(calls.length, 1, "harus tepat satu GET ke bucket");
  } finally {
    await h.close();
  }
});

test("admin tanpa token → 401", async () => {
  const h = await makeHarness();
  try {
    const list = await h.app.inject({ method: "GET", url: "/v1/guestbook/admin?eventId=x" });
    assert.equal(list.statusCode, 401);
    const patch = await h.app.inject({
      method: "PATCH",
      url: "/v1/guestbook/admin/gb1",
      payload: { visible: false },
    });
    assert.equal(patch.statusCode, 401);
  } finally {
    await h.close();
  }
});

test("DELETE menghapus objek dulu, baru baris", async () => {
  const methods: string[] = [];
  const h = await makeHarness({
    fetch: (async (_url: unknown, init: unknown) => {
      methods.push(String((init as RequestInit | undefined)?.method ?? "GET"));
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch,
  });
  try {
    const token = await login(h);
    const { eventId, hash } = await seedGallery(h, token);
    const entry = await record(h, hash);

    const del = await h.app.inject({
      method: "DELETE",
      url: `/v1/guestbook/admin/${entry.entry.id}`,
      headers: auth(token),
    });
    assert.equal(del.statusCode, 200, del.body);
    assert.deepEqual(methods, ["DELETE"], "objek harus dihapus dari bucket");

    // Barisnya benar-benar hilang.
    const list = await h.app.inject({
      method: "GET",
      url: `/v1/guestbook/admin?eventId=${eventId}&includeHidden=1`,
      headers: auth(token),
    });
    assert.equal(list.statusCode, 200, list.body);
    const ids = (list.json() as { entries: { id: string }[] }).entries.map((row) => row.id);
    assert.ok(!ids.includes(entry.entry.id), "entri harus hilang dari daftar");
  } finally {
    await h.close();
  }
});

test("PATCH visible non-boolean → 400", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    const entry = await record(h, hash);
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/guestbook/admin/${entry.entry.id}`,
      headers: auth(token),
      payload: { visible: "ya" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await h.close();
  }
});
