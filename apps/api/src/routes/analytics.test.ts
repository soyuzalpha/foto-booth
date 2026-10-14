/**
 * Tes permukaan HTTP analytics (Fase 9).
 *
 * Yang diuji bukan tampilan dasbor, tapi janji-janji yang gampang bocor:
 *
 *   · rute operator menolak tanpa token;
 *   · rentang tanggal menyaring **tanggal acara**, bukan tanggal baris dibuat;
 *   · kunjungan dihitung **sekali per galeri per hari** — satu orang yang
 *     menekan refresh tidak boleh menaikkan angka acara;
 *   · angka per acara tidak saling mencemari (galeri acara lain tidak ikut);
 *   · `totals` benar-benar jumlah dari `events`.
 *
 * Waktu dipegang konteks (`FIXED_NOW`), jadi "hari ini" tidak bergantung pada
 * jam mesin yang menjalankan tes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GALLERY_BASE_PATH } from "@foto-booth/shared";

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

/** Acara + galeri untuk satu tanggal. */
async function seedEvent(
  h: TestHarness,
  token: string,
  name: string,
  date: string,
): Promise<{ eventId: string; galleryId: string; hash: string }> {
  const event = await h.app.inject({
    method: "POST",
    url: "/v1/events",
    headers: auth(token),
    payload: { name, date },
  });
  assert.equal(event.statusCode, 201, `gagal buat acara: ${event.body}`);
  const eventId = (event.json() as { id: string }).id;

  const gallery = await h.app.inject({
    method: "POST",
    url: "/v1/galleries",
    headers: auth(token),
    payload: { eventId },
  });
  assert.equal(gallery.statusCode, 201, `gagal buat galeri: ${gallery.body}`);
  const body = gallery.json() as { id: string; hash: string };
  return { eventId, galleryId: body.id, hash: body.hash };
}

/** Upload-url + register satu foto (tidak menyentuh jaringan). */
async function seedPhoto(h: TestHarness, token: string, galleryId: string): Promise<void> {
  const url = await h.app.inject({
    method: "POST",
    url: `/v1/galleries/${galleryId}/upload-url`,
    headers: auth(token),
    payload: { contentType: "image/jpeg", bytes: 1024, width: 800, height: 1200 },
  });
  assert.equal(url.statusCode, 200, url.body);
  const signed = url.json() as { photoId: string; key: string; thumbKey: string };

  const registered = await h.app.inject({
    method: "POST",
    url: `/v1/galleries/${galleryId}/photos`,
    headers: auth(token),
    payload: {
      photoId: signed.photoId,
      key: signed.key,
      thumbKey: signed.thumbKey,
      width: 800,
      height: 1200,
      bytes: 1024,
    },
  });
  assert.equal(registered.statusCode, 201, registered.body);
}

/** Kunjungi halaman galeri seperti tamu, dengan cookie harian opsional. */
async function visit(
  h: TestHarness,
  hash: string,
  seenDay?: string,
): Promise<{ statusCode: number; setCookie: string | undefined }> {
  const res = await h.app.inject({
    method: "GET",
    url: `${GALLERY_BASE_PATH}${hash}`,
    ...(seenDay === undefined ? {} : { cookies: { [`fb_seen_${hash}`]: seenDay } }),
  });
  return { statusCode: res.statusCode, setCookie: res.headers["set-cookie"] as string | undefined };
}

interface Overview {
  from: string;
  to: string;
  totals: { events: number; galleries: number; photos: number; views: number; leads: number };
  events: { eventId: string; name: string; date: string; galleries: number; photos: number; views: number; leads: number }[];
}

/* ---- Akses --------------------------------------------------------- */

test("GET /v1/analytics/overview menolak tanpa token", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "GET", url: "/v1/analytics/overview" });
    assert.equal(res.statusCode, 401);
  } finally {
    await h.close();
  }
});

test("GET /v1/analytics/overview menolak from/to yang bukan YYYY-MM-DD", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    for (const query of ["?from=12-10-2026", "?to=kemarin", "?from=2026/10/12"]) {
      const res = await h.app.inject({
        method: "GET",
        url: `/v1/analytics/overview${query}`,
        headers: auth(token),
      });
      assert.equal(res.statusCode, 400, `${query} harus ditolak`);
    }
  } finally {
    await h.close();
  }
});

/* ---- Bentuk jawaban ------------------------------------------------ */

test("overview kosong mengembalikan totals nol dan daftar kosong", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/analytics/overview?from=2026-10-01&to=2026-10-31",
      headers: auth(token),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Overview;
    assert.deepEqual(body.totals, { events: 0, galleries: 0, photos: 0, views: 0, leads: 0 });
    assert.deepEqual(body.events, []);
    assert.equal(body.from, "2026-10-01");
    assert.equal(body.to, "2026-10-31");
  } finally {
    await h.close();
  }
});

test("overview hanya memuat acara di dalam rentang tanggal acaranya", async () => {
  // Operator bertanya "acara bulan lalu bagaimana"; acara bisa dibuat jauh
  // sebelum hari-H, jadi yang disaring adalah tanggal acaranya.
  const h = await makeHarness();
  try {
    const token = await login(h);
    await seedEvent(h, token, "Acara September", "2026-09-20");
    await seedEvent(h, token, "Acara Oktober", "2026-10-12");

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/analytics/overview?from=2026-10-01&to=2026-10-31",
      headers: auth(token),
    });
    const body = res.json() as Overview;
    assert.deepEqual(
      body.events.map((event) => event.name),
      ["Acara Oktober"],
    );
  } finally {
    await h.close();
  }
});

test("overview mengurutkan acara terbaru dulu", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    await seedEvent(h, token, "Lama", "2026-10-01");
    await seedEvent(h, token, "Baru", "2026-10-20");
    await seedEvent(h, token, "Tengah", "2026-10-10");

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/analytics/overview?from=2026-10-01&to=2026-10-31",
      headers: auth(token),
    });
    const body = res.json() as Overview;
    assert.deepEqual(
      body.events.map((event) => event.name),
      ["Baru", "Tengah", "Lama"],
    );
  } finally {
    await h.close();
  }
});

/* ---- Kunjungan ----------------------------------------------------- */

test("kunjungan dihitung sekali per galeri per hari", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { eventId, hash } = await seedEvent(h, token, "Pernikahan", "2026-10-12");

    // Tamu pertama: belum ada cookie → dihitung, dan server memasang cookie.
    const first = await visit(h, hash);
    assert.equal(first.statusCode, 200);
    assert.match(first.setCookie ?? "", new RegExp(`fb_seen_${hash}=2026-10-12`));

    // Tamu kedua membawa cookie hari ini → tidak menambah angka.
    await visit(h, hash, "2026-10-12");

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/analytics/overview?from=2026-10-01&to=2026-10-31`,
      headers: auth(token),
    });
    const entry = (res.json() as Overview).events.find((event) => event.eventId === eventId);
    assert.equal(entry?.views, 1);
  } finally {
    await h.close();
  }
});

test("hari berbeda menambah kunjungan baru", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { eventId, hash } = await seedEvent(h, token, "Pernikahan", "2026-10-12");

    await visit(h, hash);
    // Cookie dari hari sebelumnya: tamu membuka lagi keesokan harinya.
    await visit(h, hash, "2026-10-11");

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/analytics/overview?from=2026-10-01&to=2026-10-31",
      headers: auth(token),
    });
    const entry = (res.json() as Overview).events.find((event) => event.eventId === eventId);
    assert.equal(entry?.views, 2);
  } finally {
    await h.close();
  }
});

test("halaman galeri berpassword tidak dihitung sebelum dibuka", async () => {
  // Kalau dihitung saat halaman password dirender, angka kunjungan jadi
  // ukuran "berapa orang mencoba", bukan "berapa orang melihat fotonya".
  const h = await makeHarness();
  try {
    const token = await login(h);
    const event = await h.app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth(token),
      payload: { name: "Privat", date: "2026-10-12" },
    });
    const eventId = (event.json() as { id: string }).id;
    const gallery = await h.app.inject({
      method: "POST",
      url: "/v1/galleries",
      headers: auth(token),
      payload: { eventId, password: "rahasia123" },
    });
    const hash = (gallery.json() as { hash: string }).hash;

    const locked = await visit(h, hash);
    assert.equal(locked.statusCode, 401);
    assert.equal(locked.setCookie, undefined, "halaman terkunci tidak memasang cookie kunjungan");

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/analytics/overview?from=2026-10-01&to=2026-10-31",
      headers: auth(token),
    });
    const entry = (res.json() as Overview).events.find((event) => event.eventId === eventId);
    assert.equal(entry?.views, 0);
  } finally {
    await h.close();
  }
});

/* ---- Angka lain ---------------------------------------------------- */

test("foto & galeri dihitung per acara, bukan mencampur acara lain", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const a = await seedEvent(h, token, "Acara A", "2026-10-12");
    const b = await seedEvent(h, token, "Acara B", "2026-10-12");

    await seedPhoto(h, token, a.galleryId);
    await seedPhoto(h, token, a.galleryId);
    await seedPhoto(h, token, b.galleryId);

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/analytics/overview?from=2026-10-01&to=2026-10-31",
      headers: auth(token),
    });
    const body = res.json() as Overview;
    const first = body.events.find((event) => event.eventId === a.eventId);
    const second = body.events.find((event) => event.eventId === b.eventId);

    assert.equal(first?.photos, 2);
    assert.equal(second?.photos, 1);
    assert.equal(first?.galleries, 1);
    assert.equal(second?.galleries, 1);
  } finally {
    await h.close();
  }
});

test("leads dihitung per acara", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const a = await seedEvent(h, token, "Acara A", "2026-10-12");
    const b = await seedEvent(h, token, "Acara B", "2026-10-12");

    const field = await h.app.inject({
      method: "POST",
      url: "/v1/leads/admin/fields",
      headers: auth(token),
      payload: { label: "Nama Lengkap", type: "text" },
    });
    assert.equal(field.statusCode, 201, field.body);

    for (const values of [{ nama_lengkap: "Budi" }, { nama_lengkap: "Siti" }]) {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/leads",
        payload: { galleryHash: a.hash, values, consent: true },
      });
      assert.equal(res.statusCode, 201, res.body);
    }
    const other = await h.app.inject({
      method: "POST",
      url: "/v1/leads",
      payload: { galleryHash: b.hash, values: { nama_lengkap: "Andi" }, consent: true },
    });
    assert.equal(other.statusCode, 201, other.body);

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/analytics/overview?from=2026-10-01&to=2026-10-31",
      headers: auth(token),
    });
    const body = res.json() as Overview;
    assert.equal(body.events.find((event) => event.eventId === a.eventId)?.leads, 2);
    assert.equal(body.events.find((event) => event.eventId === b.eventId)?.leads, 1);
  } finally {
    await h.close();
  }
});

test("totals adalah jumlah dari events", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const a = await seedEvent(h, token, "Acara A", "2026-10-12");
    const b = await seedEvent(h, token, "Acara B", "2026-10-12");

    await seedPhoto(h, token, a.galleryId);
    await seedPhoto(h, token, b.galleryId);
    await visit(h, a.hash);
    await visit(h, b.hash);

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/analytics/overview?from=2026-10-01&to=2026-10-31",
      headers: auth(token),
    });
    const body = res.json() as Overview;

    assert.equal(body.totals.events, body.events.length);
    for (const key of ["galleries", "photos", "views", "leads"] as const) {
      const sum = body.events.reduce((total, event) => total + event[key], 0);
      assert.equal(body.totals[key], sum, `totals.${key} harus jumlah dari events`);
    }
    assert.equal(body.totals.photos, 2);
    assert.equal(body.totals.views, 2);
  } finally {
    await h.close();
  }
});

test("rentang bawaan mencakup acara yang baru selesai", async () => {
  // Dasbor dibuka untuk melihat yang baru selesai; kalau bawaannya kosong,
  // halaman pertama terlihat seperti "tidak ada data" padahal ada.
  const h = await makeHarness();
  try {
    const token = await login(h);
    await seedEvent(h, token, "Hari Ini", "2026-10-12");

    const res = await h.app.inject({ method: "GET", url: "/v1/analytics/overview", headers: auth(token) });
    const body = res.json() as Overview;
    assert.deepEqual(
      body.events.map((event) => event.name),
      ["Hari Ini"],
    );
  } finally {
    await h.close();
  }
});
