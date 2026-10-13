/**
 * Tes ujung-ke-ujung permukaan HTTP Fase 5.
 *
 * Semua lewat `app.inject` — tanpa port, tanpa jaringan. Yang diuji di sini
 * bukan bentuk halaman, tapi janji-janji yang gampang bocor:
 *
 *   · rute operator benar-benar menolak tanpa token;
 *   · key objek selalu berasal server, dan key album lain ditolak;
 *   · galeri berpassword tidak mengirim byte foto sebelum dibuka;
 *   · byte foto diproksi dari bucket (bucket tetap privat);
 *   · ZIP berisi semua foto dengan nama yang aman;
 *   · job TTL menghapus objek DULU, lalu barisnya.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GALLERY_BASE_PATH } from "@foto-booth/shared";

import { runTtlCleanup } from "../jobs/ttl.ts";
import { makeHarness, type TestHarness } from "../testing.ts";

const OPERATOR = "operator@example.com";

/** JPEG 1×1 terkecil — cukup untuk membuktikan byte-nya diteruskan apa adanya. */
const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

interface FakeS3 {
  fetch: typeof globalThis.fetch;
  /** Key yang pernah di-DELETE. */
  deleted: string[];
  /** Prefix yang pernah di-LIST. */
  listed: string[];
  /** Berapa kali objek di-GET. */
  gets: string[];
}

/**
 * Bucket palsu: cukup untuk tiga operasi yang dipakai server (GET objek, LIST,
 * DELETE). GET objek mengembalikan JPEG yang sama untuk key apa pun, jadi tes
 * bisa membandingkan byte tanpa menyiapkan berkas per key.
 *
 * LIST mensintesis satu key per prefix (`<prefix>001.jpg`) supaya penghapusan
 * benar-benar terlihat: kalau LIST mengembalikan kosong, `deletePrefix` tidak
 * pernah memanggil DELETE dan tes "objek dihapus" akan lulus tanpa membuktikan
 * apa pun.
 */
function fakeS3(): FakeS3 {
  const deleted: string[] = [];
  const listed: string[] = [];
  const gets: string[] = [];

  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname;

    if (method === "DELETE") {
      deleted.push(decodeURIComponent(path));
      return Promise.resolve(new Response(null, { status: 200 }));
    }

    if (method === "GET" && new URL(url).searchParams.get("list-type") === "2") {
      const prefix = new URL(url).searchParams.get("prefix") ?? "";
      listed.push(prefix);
      const key = `${prefix}001.jpg`;
      return Promise.resolve(
        new Response(
          `<?xml version="1.0"?><ListBucketResult><Contents><Key>${key}</Key></Contents></ListBucketResult>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        ),
      );
    }

    if (method === "GET") {
      gets.push(decodeURIComponent(path));
      return Promise.resolve(
        new Response(JPEG_BYTES, {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": String(JPEG_BYTES.length) },
        }),
      );
    }

    return Promise.resolve(new Response("metode tidak didukung", { status: 405 }));
  };

  return { fetch: fetchImpl as typeof globalThis.fetch, deleted, listed, gets };
}

/** Masuk sebagai operator, kembalikan token sesi. */
async function login(h: TestHarness): Promise<string> {
  const requested = await h.app.inject({
    method: "POST",
    url: "/v1/auth/otp/request",
    payload: { email: OPERATOR },
  });
  assert.equal(requested.statusCode, 202);

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

/** Bikin acara + galeri; `password` opsional. */
async function seedGallery(
  h: TestHarness,
  token: string,
  options: { password?: string; ttlDays?: number } = {},
): Promise<{ galleryId: string; hash: string }> {
  const event = await h.app.inject({
    method: "POST",
    url: "/v1/events",
    headers: auth(token),
    payload: { name: "Pernikahan Asep & Nia", date: "2026-10-12", hashtag: "#asepnia" },
  });
  assert.equal(event.statusCode, 201);
  const eventId = (event.json() as { id: string }).id;

  const gallery = await h.app.inject({
    method: "POST",
    url: "/v1/galleries",
    headers: auth(token),
    payload: { eventId, ...options },
  });
  assert.equal(gallery.statusCode, 201);
  const body = gallery.json() as { id: string; hash: string; url: string };
  assert.ok(body.url.endsWith(`${GALLERY_BASE_PATH}${body.hash}`));
  return { galleryId: body.id, hash: body.hash };
}

/** Upload-url + register satu foto; kembalikan key-nya. */
async function seedPhoto(
  h: TestHarness,
  token: string,
  galleryId: string,
): Promise<{ photoId: string; key: string; thumbKey: string }> {
  const url = await h.app.inject({
    method: "POST",
    url: `/v1/galleries/${galleryId}/upload-url`,
    headers: auth(token),
    payload: { contentType: "image/jpeg", bytes: 1024, width: 800, height: 1200 },
  });
  assert.equal(url.statusCode, 200);
  const signed = url.json() as { photoId: string; key: string; thumbKey: string; uploadUrl: string };
  assert.match(signed.uploadUrl, /X-Amz-Signature=/);

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
  assert.equal(registered.statusCode, 201);
  return signed;
}

/* ---- Auth --------------------------------------------------------- */

test("kode OTP tidak pernah disimpan apa adanya", async () => {
  const h = await makeHarness();
  try {
    await h.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email: OPERATOR } });
    const code = h.mailer.lastCode(OPERATOR);
    assert.ok(code !== null);

    const rows = h.ctx.db.prepare("SELECT code_hash, salt FROM otp_codes WHERE email = ?").get(OPERATOR);
    assert.ok(rows !== undefined);
    assert.notEqual(rows.code_hash, code);
    assert.notEqual(rows.salt, code);
  } finally {
    await h.close();
  }
});

test("kode salah lima kali membuang kode, bukan memperbesar peluang", async () => {
  const h = await makeHarness();
  try {
    await h.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email: OPERATOR } });
    const code = h.mailer.lastCode(OPERATOR);
    assert.ok(code !== null);
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i += 1) {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/auth/otp/verify",
        payload: { email: OPERATOR, code: wrong },
      });
      assert.equal(res.statusCode, 400);
    }

    // Kode benar sekarang pun ditolak: barisnya sudah dibuang.
    const after = await h.app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      payload: { email: OPERATOR, code },
    });
    assert.equal(after.statusCode, 400);
    assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM otp_codes").get()?.n, 0);
  } finally {
    await h.close();
  }
});

test("kode yang sudah dipakai tidak bisa dipakai dua kali", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    assert.ok(token.length > 0);

    const rows = h.ctx.db.prepare("SELECT COUNT(*) AS n FROM otp_codes").get();
    assert.equal(rows?.n, 0);
  } finally {
    await h.close();
  }
});

test("rute operator menolak tanpa token", async () => {
  const h = await makeHarness();
  try {
    for (const [method, url] of [
      ["GET", "/v1/me"],
      ["GET", "/v1/events"],
      ["GET", "/v1/galleries"],
    ] as const) {
      const res = await h.app.inject({ method, url });
      assert.equal(res.statusCode, 401, `${method} ${url} harus 401`);
    }

    const forged = await h.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer bukan.token.asli" },
    });
    assert.equal(forged.statusCode, 401);
  } finally {
    await h.close();
  }
});

/* ---- Operator: acara, galeri, upload --------------------------------- */

test("POST /v1/galleries menolak acara yang tidak ada", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/galleries",
      headers: auth(token),
      payload: { eventId: "ev_tidak_ada" },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await h.close();
  }
});

test("key objek selalu berasal server dan memuat hash album", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/galleries/${galleryId}/upload-url`,
      headers: auth(token),
      payload: { contentType: "image/png", bytes: 2048, width: 600, height: 900 },
    });
    assert.equal(res.statusCode, 200);

    const body = res.json() as { key: string; thumbKey: string };
    assert.ok(body.key.includes(hash), "key harus memuat hash album");
    assert.match(body.key, /^photos\//);
    assert.match(body.thumbKey, /^thumbs\//);
    assert.ok(body.key.endsWith(".png"), "ekstensi ikut content-type");
  } finally {
    await h.close();
  }
});

test("upload-url menolak berkas di atas batas", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId } = await seedGallery(h, token);

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/galleries/${galleryId}/upload-url`,
      headers: auth(token),
      payload: { contentType: "image/jpeg", bytes: 26 * 1024 * 1024, width: 800, height: 1200 },
    });
    assert.equal(res.statusCode, 413);
  } finally {
    await h.close();
  }
});

test("pendaftaran foto menolak key milik album lain", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const a = await seedGallery(h, token);
    const b = await seedGallery(h, token);

    // URL sah untuk album A, tapi key A dipakai mendaftar ke album B.
    const signed = await h.app.inject({
      method: "POST",
      url: `/v1/galleries/${a.galleryId}/upload-url`,
      headers: auth(token),
      payload: { contentType: "image/jpeg", bytes: 1024, width: 800, height: 1200 },
    });
    const key = (signed.json() as { key: string; thumbKey: string; photoId: string });

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/galleries/${b.galleryId}/photos`,
      headers: auth(token),
      payload: {
        photoId: key.photoId,
        key: key.key,
        thumbKey: key.thumbKey,
        width: 800,
        height: 1200,
        bytes: 1024,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match((res.json() as { message: string }).message, /album ini/);
  } finally {
    await h.close();
  }
});

test("key dengan `..` ditolak walaupun prefix albumnya cocok", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/galleries/${galleryId}/photos`,
      headers: auth(token),
      payload: {
        photoId: "ph_evil",
        key: `photos/${hash}/../../etc/passwd`,
        thumbKey: `thumbs/${hash}/x.jpg`,
        width: 800,
        height: 1200,
        bytes: 1024,
      },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await h.close();
  }
});

/* ---- Galeri publik ------------------------------------------------ */

test("hash tidak dikenal → 404 HTML, bukan JSON", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "GET", url: `${GALLERY_BASE_PATH}tidakada` });
    assert.equal(res.statusCode, 404);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(res.body, /Galeri tidak ditemukan/);
  } finally {
    await h.close();
  }
});

test("halaman galeri memuat meta OG yang bisa dibaca crawler", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);
    await seedPhoto(h, token, galleryId);

    const res = await h.app.inject({ method: "GET", url: `${GALLERY_BASE_PATH}${hash}` });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /property="og:title" content="Pernikahan Asep &amp; Nia"/);
    assert.match(res.body, /property="og:image"/);
    assert.match(res.body, new RegExp(`${hash}/og\\.png`));
    // Galeri tamu tidak boleh diindeks mesin pencari.
    assert.match(res.body, /name="robots" content="noindex"/);
  } finally {
    await h.close();
  }
});

test("galeri berpassword tidak mengirim byte sebelum dibuka", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token, { password: "rahasia123" });
    const photo = await seedPhoto(h, token, galleryId);

    const page = await h.app.inject({ method: "GET", url: `${GALLERY_BASE_PATH}${hash}` });
    assert.equal(page.statusCode, 401);
    assert.match(page.body, /Galeri ini pakai password/);

    const bytes = await h.app.inject({ method: "GET", url: `${GALLERY_BASE_PATH}${hash}/photo/${photo.photoId}` });
    assert.equal(bytes.statusCode, 401);

    const zip = await h.app.inject({ method: "GET", url: `${GALLERY_BASE_PATH}${hash}/zip` });
    assert.equal(zip.statusCode, 401);

    // Password salah → kembali ke halaman dengan penanda salah.
    const wrong = await h.app.inject({
      method: "POST",
      url: `${GALLERY_BASE_PATH}${hash}/unlock`,
      payload: { password: "salahsekali" },
    });
    assert.equal(wrong.statusCode, 303);
    assert.match(wrong.headers.location ?? "", /salah=1$/);

    // Password benar → cookie buka-kunci, lalu foto terbuka.
    const right = await h.app.inject({
      method: "POST",
      url: `${GALLERY_BASE_PATH}${hash}/unlock`,
      payload: { password: "rahasia123" },
    });
    assert.equal(right.statusCode, 303);

    const cookie = right.headers["set-cookie"];
    assert.ok(typeof cookie === "string" && cookie.includes("fb_unlock="));
    // Cookie hanya berisi token bertanda tangan, bukan passwordnya.
    assert.ok(!cookie.includes("rahasia123"));
    assert.match(cookie, /HttpOnly/);

    const cookieValue = cookie.split(";")[0] ?? "";
    const opened = await h.app.inject({
      method: "GET",
      url: `${GALLERY_BASE_PATH}${hash}`,
      headers: { cookie: cookieValue },
    });
    assert.equal(opened.statusCode, 200);
    assert.match(opened.body, /Unduh semua/);
  } finally {
    await h.close();
  }
});

test("cookie buka-kunci yang dikarang diabaikan", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token, { password: "rahasia123" });

    const res = await h.app.inject({
      method: "GET",
      url: `${GALLERY_BASE_PATH}${hash}`,
      headers: { cookie: "fb_unlock=sudah-login-pokoknya" },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await h.close();
  }
});

test("byte foto diproksi dari bucket apa adanya", async () => {
  const s3 = fakeS3();
  const h = await makeHarness({ fetch: s3.fetch });
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);
    const photo = await seedPhoto(h, token, galleryId);

    const res = await h.app.inject({
      method: "GET",
      url: `${GALLERY_BASE_PATH}${hash}/photo/${photo.photoId}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "image/jpeg");
    assert.equal(res.headers["content-length"], String(JPEG_BYTES.length));
    assert.deepEqual(new Uint8Array(res.rawPayload), JPEG_BYTES);

    // Bucket tetap privat: yang diambil server adalah key objek, bukan URL publik.
    assert.equal(s3.gets.length, 1);
    assert.ok(s3.gets[0]?.endsWith(photo.key), `GET harus ke ${photo.key}`);
  } finally {
    await h.close();
  }
});

test("ZIP berisi semua foto dengan nama yang aman", async () => {
  const s3 = fakeS3();
  const h = await makeHarness({ fetch: s3.fetch });
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);
    await seedPhoto(h, token, galleryId);
    await seedPhoto(h, token, galleryId);

    const res = await h.app.inject({ method: "GET", url: `${GALLERY_BASE_PATH}${hash}/zip` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/zip");
    assert.match(res.headers["content-disposition"] ?? "", /filename="Pernikahan-Asep-Nia\.zip"/);

    const bytes = Buffer.from(res.rawPayload);
    assert.equal(bytes.subarray(0, 2).toString("latin1"), "PK");
    // Nama folder + nomor urut + id foto ada di central directory.
    assert.match(bytes.toString("latin1"), /Pernikahan-Asep-Nia\/001-/);
    assert.match(bytes.toString("latin1"), /Pernikahan-Asep-Nia\/002-/);
  } finally {
    await h.close();
  }
});

test("nama folder ZIP dibersihkan dari karakter aneh", async () => {
  const { sanitizeFolder } = await import("./gallery.ts");
  assert.equal(sanitizeFolder("Pernikahan Asep & Nia"), "Pernikahan-Asep-Nia");
  assert.equal(sanitizeFolder("../../etc/passwd"), "etcpasswd");
  assert.equal(sanitizeFolder(""), "galeri");
  assert.equal(sanitizeFolder("   "), "galeri");
});

/* ---- TTL ---------------------------------------------------------- */

test("job TTL menghapus objek dulu, lalu baris foto dan galeri", async () => {
  const s3 = fakeS3();
  const h = await makeHarness({ fetch: s3.fetch });
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token, { ttlDays: 1 });
    await seedPhoto(h, token, galleryId);

    // Belum kedaluwarsa → tidak ada yang dihapus.
    const early = await runTtlCleanup(h.ctx);
    assert.equal(early.galleriesDeleted, 0);
    assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM galleries").get()?.n, 1);

    // Majukan dua hari.
    h.setNow(new Date("2026-10-14T00:00:00.000Z"));

    const report = await runTtlCleanup(h.ctx);
    assert.equal(report.galleriesScanned, 1);
    assert.equal(report.galleriesDeleted, 1);
    assert.equal(report.photosDeleted, 1);
    assert.equal(report.failures.length, 0);

    // Objek dihapus lewat prefix album (photos/, thumbs/, og/).
    assert.deepEqual([...s3.listed].sort(), [
      `og/${hash}.png`,
      `photos/${hash}/`,
      `thumbs/${hash}/`,
    ]);
    assert.equal(s3.deleted.length, 3);
    assert.ok(s3.deleted.some((path) => path.includes(`photos/${hash}/`)));
    assert.ok(s3.deleted.some((path) => path.includes(`thumbs/${hash}/`)));
    assert.ok(s3.deleted.some((path) => path.includes(`og/${hash}.png`)));

    // Baris ikut hilang, jadi galeri tidak bisa dibuka lagi.
    assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM galleries").get()?.n, 0);
    assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM photos").get()?.n, 0);

    const page = await h.app.inject({ method: "GET", url: `${GALLERY_BASE_PATH}${hash}` });
    assert.equal(page.statusCode, 404);
  } finally {
    await h.close();
  }
});

test("kegagalan menghapus objek menyisakan galeri supaya bisa dicoba lagi", async () => {
  const failing = (() => Promise.reject(new Error("bucket mati"))) as typeof globalThis.fetch;
  const h = await makeHarness({ fetch: failing });
  try {
    const token = await login(h);
    const { galleryId } = await seedGallery(h, token, { ttlDays: 1 });
    await seedPhoto(h, token, galleryId);

    h.setNow(new Date("2026-10-14T00:00:00.000Z"));
    const report = await runTtlCleanup(h.ctx);

    assert.equal(report.galleriesDeleted, 0);
    assert.equal(report.failures.length, 1);
    // Barisnya TIDAK dihapus: kalau dihapus, objeknya jadi sampah permanen.
    assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM galleries").get()?.n, 1);
    assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM photos").get()?.n, 1);
  } finally {
    await h.close();
  }
});

test("job TTL membuang kode OTP basi", async () => {
  const h = await makeHarness();
  try {
    await h.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email: OPERATOR } });
    assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM otp_codes").get()?.n, 1);

    h.setNow(new Date("2026-10-12T01:00:00.000Z"));
    const report = await runTtlCleanup(h.ctx);
    assert.equal(report.otpsDeleted, 1);
    assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM otp_codes").get()?.n, 0);
  } finally {
    await h.close();
  }
});
