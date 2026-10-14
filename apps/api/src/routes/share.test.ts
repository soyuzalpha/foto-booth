/**
 * Tes halaman share publik ber-branding (Fase 9).
 *
 * Halaman ini dibaca dua audiens yang tidak bisa dilihat bersamaan: crawler
 * WhatsApp/Telegram (yang cuma membaca `<head>`) dan tamu (yang melihat kartu +
 * tombol). Yang diuji di sini bukan tampilannya, tapi janji-janji yang gampang
 * bocor:
 *
 *   · **Hash tak dikenal → 404 HTML**, bukan halaman kosong ber-status 200.
 *     Kartu share yang "berhasil" untuk galeri yang sudah dihapus membuat
 *     tautan mati terlihat hidup.
 *   · **Meta OG berasal dari branding tersimpan.** Kalau judulnya dirakit ulang
 *     di sini, kartu share akan berbeda dari halaman yang dibuka tamu.
 *   · **Tanpa logo tidak ada `og:image` sama sekali.** `content=""` membuat
 *     crawler menampilkan kotak rusak, bukan kartu tanpa gambar.
 *   · **Nilai operator di-escape di `<title>` dan di atribut meta.** `heading`
 *     bisa berisi `<script>` atau tanda kutip; satu yang lolos berarti markup
 *     tamu bisa dipecah dari halaman yang tautannya dibagikan ke grup keluarga.
 *   · **Halaman galeri tamu memakai judul branding**, bukan nama aplikasi —
 *     itu inti white-label.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { APP_NAME, DEFAULT_BRANDING, GALLERY_BASE_PATH } from "@foto-booth/shared";

import { makeHarness, type TestHarness } from "../testing.ts";

const OPERATOR = "operator@example.com";

/** Judul operator yang memuat markup & kutip — sengaja jahat, tapi sah. */
const EVIL_HEADING = `Nia "quoted" <script>alert(1)</script>`;

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

/**
 * Bikin acara + galeri lewat API operator, bukan lewat `insertGallery`.
 *
 * Dipakai jalur HTTP supaya tes ini gagal kalau pembuatan galeri berubah bentuk
 * — bukan cuma kalau render halamannya berubah.
 */
async function seedGallery(
  h: TestHarness,
  token: string,
  eventName = "Pernikahan Asep & Nia",
): Promise<{ galleryId: string; hash: string }> {
  const event = await h.app.inject({
    method: "POST",
    url: "/v1/events",
    headers: auth(token),
    payload: { name: eventName, date: "2026-10-12", hashtag: "#asepnia" },
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
  return { galleryId: body.id, hash: body.hash };
}

/** Simpan branding lewat rute operator — jalur yang sama dengan studio. */
async function saveBrandingVia(
  h: TestHarness,
  token: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const put = await h.app.inject({
    method: "PUT",
    url: "/v1/branding/admin",
    headers: auth(token),
    payload,
  });
  assert.equal(put.statusCode, 200, put.body);
}

test("hash tidak dikenal → 404 HTML di kedua bentuk path", async () => {
  const h = await makeHarness();
  try {
    // Kedua path menunjuk handler yang sama; diuji keduanya supaya alias tidak
    // diam-diam jadi jalur yang tidak pernah dibaca siapa pun.
    for (const url of ["/s/tidakada", `${GALLERY_BASE_PATH}tidakada/share`]) {
      const res = await h.app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 404, `${url} harus 404`);
      assert.match(res.headers["content-type"] ?? "", /text\/html/);
      assert.match(res.body, /Galeri tidak ditemukan/);
    }
  } finally {
    await h.close();
  }
});

test("share: og:title & og:description dari branding yang tersimpan", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    await saveBrandingVia(h, token, {
      heading: "Pernikahan Andi & Sari",
      subheading: "14 Oktober 2026 · #AndiSariForever",
      footer: "Terima kasih sudah hadir",
    });

    const res = await h.app.inject({ method: "GET", url: `/s/${hash}` });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);

    // `&` harus jadi `&amp;` di atribut — nilai branding, bukan teks biasa.
    assert.match(res.body, /property="og:title" content="Pernikahan Andi &amp; Sari"/);
    assert.match(res.body, /property="og:description" content="14 Oktober 2026 · #AndiSariForever"/);
    assert.match(res.body, /<title>Pernikahan Andi &amp; Sari<\/title>/);
    assert.match(res.body, /<meta name="twitter:card" content="summary">/);

    // Halaman juga menautkan galeri tamu dan memuat tombol share dari
    // SHARE_CHANNELS: deep link (tanpa JS) untuk whatsapp/email/sms, tombol
    // ber-data untuk native/copy.
    assert.match(res.body, new RegExp(`href="https?://[^"]*${GALLERY_BASE_PATH}${hash}"`));
    assert.match(res.body, /href="https:\/\/wa\.me\/\?text=/);
    assert.match(res.body, /href="mailto:\?subject=/);
    assert.match(res.body, /href="sms:\?body=/);
    assert.match(res.body, /data-share="native"/);
    assert.match(res.body, /data-share="copy"/);
  } finally {
    await h.close();
  }
});

test("share: logoUrl null → tidak ada og:image sama sekali", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    await saveBrandingVia(h, token, { heading: "Tanpa logo" });

    const res = await h.app.inject({ method: "GET", url: `/s/${hash}` });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes("og:image"), "og:image tidak boleh muncul tanpa logo");
    assert.ok(!res.body.includes("<img class=\"logo\""), "logo kosong tidak boleh jadi <img>");
  } finally {
    await h.close();
  }
});

test("share: logoUrl ada → og:image memakai URL logo", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    await saveBrandingVia(h, token, { logoUrl: "https://cdn.example.com/logo.png" });

    const res = await h.app.inject({ method: "GET", url: `/s/${hash}` });
    assert.equal(res.statusCode, 200);
    assert.match(
      res.body,
      /property="og:image" content="https:\/\/cdn\.example\.com\/logo\.png"/,
    );
  } finally {
    await h.close();
  }
});

test("share: <script> dan tanda kutip operator di-escape, bukan mentah", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    await saveBrandingVia(h, token, {
      heading: EVIL_HEADING,
      subheading: `Sub "kutip" <img src=x onerror=alert(1)>`,
    });

    const res = await h.app.inject({ method: "GET", url: `/s/${hash}` });
    assert.equal(res.statusCode, 200);

    // Markup mentah tidak boleh ada di mana pun — kalau ada, halaman share yang
    // dibagikan ke grup keluarga bisa menjalankan skrip di browser tamu.
    assert.ok(!res.body.includes("<script>alert(1)</script>"), "script operator harus mati");
    assert.ok(!res.body.includes("<img src=x onerror=alert(1)>"), "markup operator harus mati");

    // Yang harus ada: bentuk ter-escape di <title> dan di atribut meta.
    assert.match(res.body, /<title>Nia &quot;quoted&quot; &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
    assert.match(
      res.body,
      /property="og:title" content="Nia &quot;quoted&quot; &lt;script&gt;alert\(1\)&lt;\/script&gt;"/,
    );
    assert.match(
      res.body,
      /property="og:description" content="Sub &quot;kutip&quot; &lt;img src=x onerror=alert\(1\)&gt;"/,
    );
  } finally {
    await h.close();
  }
});

test("halaman galeri tamu memakai judul branding, bukan nama aplikasi", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    await saveBrandingVia(h, token, {
      heading: "Pernikahan Andi & Sari",
      subheading: "14 Oktober 2026 · #AndiSariForever",
      footer: "Terima kasih sudah hadir",
    });

    const res = await h.app.inject({ method: "GET", url: `${GALLERY_BASE_PATH}${hash}` });
    assert.equal(res.statusCode, 200);

    assert.match(res.body, /<title>Pernikahan Andi &amp; Sari<\/title>/);
    assert.match(res.body, /<h1>Pernikahan Andi &amp; Sari<\/h1>/);
    assert.match(res.body, /<p>14 Oktober 2026 · #AndiSariForever<\/p>/);
    assert.match(res.body, /Terima kasih sudah hadir/);
    // Nama aplikasi hanya boleh muncul kalau operator memang mengetiknya.
    assert.ok(!res.body.includes(APP_NAME), "nama aplikasi tidak boleh jadi judul halaman");
  } finally {
    await h.close();
  }
});

test("halaman galeri tamu tanpa branding → jatuh ke nama acara, bukan APP_NAME", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);

    // Belum pernah ada branding tersimpan: getBranding mengembalikan null dan
    // halaman harus tetap punya judul dari nama acara.
    const res = await h.app.inject({ method: "GET", url: `${GALLERY_BASE_PATH}${hash}` });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<title>Pernikahan Asep &amp; Nia<\/title>/);
    assert.ok(!res.body.includes(APP_NAME), "nama aplikasi tidak boleh jadi judul halaman");
    assert.equal(DEFAULT_BRANDING.heading, "");
  } finally {
    await h.close();
  }
});
