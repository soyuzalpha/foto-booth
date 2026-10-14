/**
 * Tes permukaan HTTP leads (Fase 9).
 *
 * Semua lewat `app.inject` — tanpa port, tanpa jaringan. Yang diuji bukan
 * tampilan form, tapi janji-janji yang gampang bocor:
 *
 *   · rute operator menolak tanpa token, rute tamu tidak butuh token;
 *   · **tanpa consent tidak ada yang tersimpan** — di jalur JSON maupun jalur
 *     form HTML (dua pintu masuk, satu aturan);
 *   · honeypot menjawab sukses palsu dan tidak menulis apa pun;
 *   · `key` field selalu diturunkan server, dan dua label sama tidak saling
 *     menimpa;
 *   · CSV diekspor dengan kolom dari definisi field, bukan dari kunci yang
 *     kebetulan ada di baris;
 *   · hak hapus UU PDP benar-benar menghapus baris;
 *   · kunjungan galeri dihitung sekali per hari, bukan sekali per muat.
 *
 * Waktu dipegang konteks (`FIXED_NOW`), jadi "hari ini" tidak bergantung pada
 * jam mesin yang menjalankan tes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GALLERY_BASE_PATH, LEAD_RATE_LIMIT, LEAD_CONSENT_TEXT } from "@foto-booth/shared";

import { makeHarness, type TestHarness } from "../testing.ts";
import { listLeads } from "../store.ts";

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

/** Acara + galeri; kembalikan id acara dan hash galeri. */
async function seedGallery(
  h: TestHarness,
  token: string,
): Promise<{ eventId: string; galleryId: string; hash: string }> {
  const event = await h.app.inject({
    method: "POST",
    url: "/v1/events",
    headers: auth(token),
    payload: { name: "Pernikahan Asep & Nia", date: "2026-10-12", hashtag: "#asepnia" },
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

/** Buat definisi field lewat API operator. */
async function seedField(
  h: TestHarness,
  token: string,
  payload: Record<string, unknown>,
): Promise<{ id: string; key: string; label: string }> {
  const created = await h.app.inject({
    method: "POST",
    url: "/v1/leads/admin/fields",
    headers: auth(token),
    payload: { type: "text", ...payload },
  });
  assert.equal(created.statusCode, 201, `gagal buat field: ${created.body}`);
  return created.json() as { id: string; key: string; label: string };
}

/* ---- Field yang ditanyakan ----------------------------------------- */

test("GET /v1/leads/fields mengembalikan field global + milik acara itu", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { eventId, hash } = await seedGallery(h, token);
    await seedField(h, token, { label: "Nama Lengkap", required: true, sortOrder: 1 });
    await seedField(h, token, { label: "Kode Meja", eventId, sortOrder: 2 });
    await seedField(h, token, { label: "Field Nonaktif", active: false });

    const res = await h.app.inject({ method: "GET", url: `/v1/leads/fields?galleryHash=${hash}` });
    assert.equal(res.statusCode, 200);
    const keys = (res.json() as { fields: { key: string }[] }).fields.map((f) => f.key);
    assert.deepEqual(keys, ["nama_lengkap", "kode_meja"]);
  } finally {
    await h.close();
  }
});

test("GET /v1/leads/fields menolak galeri yang tidak dikenal", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "GET", url: "/v1/leads/fields?galleryHash=tidakada" });
    assert.equal(res.statusCode, 404);
  } finally {
    await h.close();
  }
});

test("GET /v1/leads/fields tanpa acara & galeri hanya mengembalikan field global", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { eventId } = await seedGallery(h, token);
    await seedField(h, token, { label: "Global" });
    await seedField(h, token, { label: "Khusus Acara", eventId });

    const res = await h.app.inject({ method: "GET", url: "/v1/leads/fields" });
    const keys = (res.json() as { fields: { key: string }[] }).fields.map((f) => f.key);
    assert.deepEqual(keys, ["global"]);
  } finally {
    await h.close();
  }
});

/* ---- Kiriman tamu -------------------------------------------------- */

test("POST /v1/leads menyimpan kiriman yang sah", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);
    await seedField(h, token, { label: "Nama Lengkap", required: true });

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/leads",
      payload: { galleryHash: hash, values: { nama_lengkap: "Budi Santoso" }, consent: true },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { received: boolean; stored: boolean; id: string };
    assert.equal(body.stored, true);
    assert.ok(body.id.startsWith("lead_"));

    const stored = listLeads(h.ctx.db, { galleryId });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.values.nama_lengkap, "Budi Santoso");
    // Consent disalin apa adanya beserta versinya — bukti persetujuan, bukan flag UI.
    assert.equal(stored[0]?.consent, true);
    assert.equal(stored[0]?.consentText, LEAD_CONSENT_TEXT);
    assert.equal(stored[0]?.consentVersion, "1");
    assert.equal(stored[0]?.source, "gallery");
  } finally {
    await h.close();
  }
});

test("POST /v1/leads menolak body tanpa consent", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/leads",
      payload: { galleryHash: hash, values: {}, consent: false },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(listLeads(h.ctx.db, { galleryId }).length, 0);
  } finally {
    await h.close();
  }
});

test("POST /v1/leads menolak field wajib yang kosong", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);
    await seedField(h, token, { label: "Nama Lengkap", required: true });

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/leads",
      payload: { galleryHash: hash, values: {}, consent: true },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { error: string; errors: { key: string }[] };
    assert.equal(body.error, "invalid_values");
    assert.deepEqual(
      body.errors.map((e) => e.key),
      ["nama_lengkap"],
    );
    assert.equal(listLeads(h.ctx.db, { galleryId }).length, 0);
  } finally {
    await h.close();
  }
});

test("POST /v1/leads honeypot menjawab sukses palsu tanpa menyimpan", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/leads",
      payload: {
        galleryHash: hash,
        values: {},
        consent: true,
        website: "http://spam.example.com",
      },
    });
    assert.equal(res.statusCode, 201);
    assert.equal((res.json() as { stored: boolean }).stored, false);
    assert.equal(listLeads(h.ctx.db, { galleryId }).length, 0);
  } finally {
    await h.close();
  }
});

test("POST /v1/leads dibatasi laju per IP", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);

    const payload = { galleryHash: hash, values: {}, consent: true };
    for (let i = 0; i < LEAD_RATE_LIMIT; i += 1) {
      const res = await h.app.inject({ method: "POST", url: "/v1/leads", payload });
      assert.equal(res.statusCode, 201, `kiriman ke-${i + 1} harus lolos`);
    }

    const blocked = await h.app.inject({ method: "POST", url: "/v1/leads", payload });
    assert.equal(blocked.statusCode, 429);
    assert.ok(blocked.headers["retry-after"] !== undefined);
  } finally {
    await h.close();
  }
});

test("POST /v1/leads menolak galeri yang tidak dikenal", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/leads",
      payload: { galleryHash: "tidakada", values: {}, consent: true },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await h.close();
  }
});

/* ---- Konfigurasi field (operator) ---------------------------------- */

test("rute operator leads menolak tanpa token", async () => {
  const h = await makeHarness();
  try {
    const calls: [string, string][] = [
      ["GET", "/v1/leads/admin/fields"],
      ["POST", "/v1/leads/admin/fields"],
      ["PATCH", "/v1/leads/admin/fields/lf_1"],
      ["DELETE", "/v1/leads/admin/fields/lf_1"],
      ["GET", "/v1/leads/admin/leads"],
      ["GET", "/v1/leads/admin/export.csv"],
      ["DELETE", "/v1/leads/admin/leads/lead_1"],
    ];
    for (const [method, url] of calls) {
      const res = await h.app.inject({ method: method as "GET", url, payload: {} });
      assert.equal(res.statusCode, 401, `${method} ${url} harus 401 tanpa token`);
    }
  } finally {
    await h.close();
  }
});

test("POST /v1/leads/admin/fields menurunkan key dari label", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const field = await seedField(h, token, { label: "Nomor WhatsApp" });
    assert.equal(field.key, "nomor_whatsapp");
  } finally {
    await h.close();
  }
});

test("dua field dengan label sama tidak saling menimpa", async () => {
  // Kalau key-nya sama, nilai kiriman tamu untuk satu field akan menimpa yang
  // lain tanpa error apa pun — dan itu baru kelihatan setelah data hilang.
  const h = await makeHarness();
  try {
    const token = await login(h);
    const first = await seedField(h, token, { label: "Nama" });
    const second = await seedField(h, token, { label: "Nama" });
    assert.equal(first.key, "nama");
    assert.equal(second.key, "nama_2");
    assert.notEqual(first.id, second.id);
  } finally {
    await h.close();
  }
});

test("label yang seluruhnya non-alfanumerik tetap menghasilkan key yang unik", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const first = await seedField(h, token, { label: "???" });
    const second = await seedField(h, token, { label: "???" });
    assert.equal(first.key, "field");
    assert.notEqual(second.key, first.key);
  } finally {
    await h.close();
  }
});

test("POST /v1/leads/admin/fields menolak select tanpa pilihan", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/leads/admin/fields",
      headers: auth(token),
      payload: { label: "Tahu dari", type: "select" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await h.close();
  }
});

test("POST /v1/leads/admin/fields menolak acara yang tidak ada", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/leads/admin/fields",
      headers: auth(token),
      payload: { label: "Kode", type: "text", eventId: "ev_tidakada" },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await h.close();
  }
});

test("PATCH /v1/leads/admin/fields/:id menyunting tanpa mengubah key", async () => {
  // Label boleh berubah; key tidak. Kalau key ikut berubah, nilai yang sudah
  // terkumpul kehilangan artinya.
  const h = await makeHarness();
  try {
    const token = await login(h);
    const field = await seedField(h, token, { label: "Nama Lengkap" });

    const patched = await h.app.inject({
      method: "PATCH",
      url: `/v1/leads/admin/fields/${field.id}`,
      headers: auth(token),
      payload: { label: "Nama Tamu", required: true },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    const body = patched.json() as { key: string; label: string; required: boolean };
    assert.equal(body.key, "nama_lengkap");
    assert.equal(body.label, "Nama Tamu");
    assert.equal(body.required, true);
  } finally {
    await h.close();
  }
});

test("PATCH field select menjadi tanpa pilihan ditolak", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const field = await seedField(h, token, {
      label: "Tahu dari",
      type: "select",
      options: ["Instagram"],
    });

    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/leads/admin/fields/${field.id}`,
      headers: auth(token),
      payload: { options: [] },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await h.close();
  }
});

test("DELETE /v1/leads/admin/fields/:id menghapus definisi tapi menyimpan nilai lama", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);
    const field = await seedField(h, token, { label: "Nama Lengkap" });

    await h.app.inject({
      method: "POST",
      url: "/v1/leads",
      payload: { galleryHash: hash, values: { nama_lengkap: "Budi" }, consent: true },
    });

    const removed = await h.app.inject({
      method: "DELETE",
      url: `/v1/leads/admin/fields/${field.id}`,
      headers: auth(token),
    });
    assert.equal(removed.statusCode, 200);

    const stored = listLeads(h.ctx.db, { galleryId });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.values.nama_lengkap, "Budi");
  } finally {
    await h.close();
  }
});

test("DELETE field yang tidak ada → 404", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const res = await h.app.inject({
      method: "DELETE",
      url: "/v1/leads/admin/fields/lf_tidakada",
      headers: auth(token),
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await h.close();
  }
});

/* ---- Daftar & ekspor ----------------------------------------------- */

test("GET /v1/leads/admin/leads menyertakan definisi field", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    await seedField(h, token, { label: "Nama Lengkap" });
    await h.app.inject({
      method: "POST",
      url: "/v1/leads",
      payload: { galleryHash: hash, values: { nama_lengkap: "Budi" }, consent: true },
    });

    const res = await h.app.inject({ method: "GET", url: "/v1/leads/admin/leads", headers: auth(token) });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { leads: unknown[]; fields: { key: string }[] };
    assert.equal(body.leads.length, 1);
    assert.deepEqual(
      body.fields.map((f) => f.key),
      ["nama_lengkap"],
    );
  } finally {
    await h.close();
  }
});

test("GET /v1/leads/admin/export.csv mengeluarkan kolom dari definisi field", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    await seedField(h, token, { label: "Nama Lengkap", sortOrder: 1 });
    await seedField(h, token, { label: "No. HP", type: "phone", sortOrder: 2 });

    await h.app.inject({
      method: "POST",
      url: "/v1/leads",
      payload: {
        galleryHash: hash,
        values: { nama_lengkap: "Budi", no_hp: "081234567890" },
        consent: true,
      },
    });

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/leads/admin/export.csv",
      headers: auth(token),
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] as string, /text\/csv/);
    assert.match(res.headers["content-disposition"] as string, /attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"/);

    const rows = res.body.trimEnd().split("\r\n");
    assert.equal(rows[0], '"waktu","nama_acara","galeri","consent","versi_consent","Nama Lengkap","No. HP"');
    assert.equal(rows.length, 2);
    assert.match(rows[1] ?? "", /"Budi"/);
    assert.match(rows[1] ?? "", /"081234567890"/);
    assert.match(rows[1] ?? "", /"Pernikahan Asep & Nia"/);
  } finally {
    await h.close();
  }
});

test("ekspor CSV dengan filter acara memberi nama berkas yang spesifik", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { eventId } = await seedGallery(h, token);
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/leads/admin/export.csv?eventId=${eventId}`,
      headers: auth(token),
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-disposition"] as string, new RegExp(`leads-${eventId}-\\d{4}-\\d{2}-\\d{2}\\.csv`));
  } finally {
    await h.close();
  }
});

test("ekspor CSV tanpa data tetap punya header", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    await seedField(h, token, { label: "Nama Lengkap" });
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/leads/admin/export.csv",
      headers: auth(token),
    });
    assert.equal(res.body.trimEnd().split("\r\n").length, 1);
  } finally {
    await h.close();
  }
});

test("DELETE /v1/leads/admin/leads/:id benar-benar menghapus barisnya (UU PDP)", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/leads",
      payload: { galleryHash: hash, values: {}, consent: true },
    });
    const leadId = (created.json() as { id: string }).id;

    const removed = await h.app.inject({
      method: "DELETE",
      url: `/v1/leads/admin/leads/${leadId}`,
      headers: auth(token),
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(listLeads(h.ctx.db, { galleryId }).length, 0);
  } finally {
    await h.close();
  }
});

/* ---- Jalur form HTML di halaman galeri ----------------------------- */

test("halaman galeri menampilkan form data tamu kalau ada field aktif", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    await seedField(h, token, { label: "Nama Lengkap", required: true });

    const res = await h.app.inject({ method: "GET", url: `${GALLERY_BASE_PATH}${hash}` });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<form method="post"/);
    assert.match(res.body, /name="nama_lengkap"/);
    assert.match(res.body, /name="consent"/);
    assert.match(res.body, /name="website"/, "honeypot harus ikut dirender");
  } finally {
    await h.close();
  }
});

test("halaman galeri tanpa field aktif tidak menampilkan form sama sekali", async () => {
  // Form yang cuma berisi checkbox consent membuat tamu menyetujui sesuatu
  // yang tidak diminta — itu masalah kepatuhan, bukan kerapian.
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);

    const res = await h.app.inject({ method: "GET", url: `${GALLERY_BASE_PATH}${hash}` });
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /name="consent"/);
  } finally {
    await h.close();
  }
});

test("POST form galeri menyimpan data lalu mengalihkan ke ?status=terkirim", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);
    await seedField(h, token, { label: "Nama Lengkap", required: true });
    await seedField(h, token, { label: "Ikut grup WA", type: "checkbox" });

    const res = await h.app.inject({
      method: "POST",
      url: `${GALLERY_BASE_PATH}${hash}/lead`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "nama_lengkap=Budi+Santoso&ikut_grup_wa=1&consent=1",
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, `${GALLERY_BASE_PATH}${hash}?status=terkirim`);

    const stored = listLeads(h.ctx.db, { galleryId });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.values.nama_lengkap, "Budi Santoso");
    assert.equal(stored[0]?.values.ikut_grup_wa, true);
    assert.equal(stored[0]?.source, "gallery");
  } finally {
    await h.close();
  }
});

test("POST form galeri tanpa centang consent tidak menyimpan apa pun", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);
    await seedField(h, token, { label: "Nama Lengkap" });

    const res = await h.app.inject({
      method: "POST",
      url: `${GALLERY_BASE_PATH}${hash}/lead`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "nama_lengkap=Budi+Santoso",
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, `${GALLERY_BASE_PATH}${hash}?status=gagal`);
    assert.equal(listLeads(h.ctx.db, { galleryId }).length, 0);
  } finally {
    await h.close();
  }
});

test("POST form galeri dengan field wajib kosong mengalihkan ke ?status=gagal", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);
    await seedField(h, token, { label: "Nama Lengkap", required: true });

    const res = await h.app.inject({
      method: "POST",
      url: `${GALLERY_BASE_PATH}${hash}/lead`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "consent=1",
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, `${GALLERY_BASE_PATH}${hash}?status=gagal`);
    assert.equal(listLeads(h.ctx.db, { galleryId }).length, 0);
  } finally {
    await h.close();
  }
});

test("POST form galeri honeypot terisi → sukses palsu, tanpa menyimpan", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);
    await seedField(h, token, { label: "Nama Lengkap" });

    const res = await h.app.inject({
      method: "POST",
      url: `${GALLERY_BASE_PATH}${hash}/lead`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "nama_lengkap=Bot&consent=1&website=http%3A%2F%2Fspam.example.com",
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, `${GALLERY_BASE_PATH}${hash}?status=terkirim`);
    assert.equal(listLeads(h.ctx.db, { galleryId }).length, 0);
  } finally {
    await h.close();
  }
});

test("POST form galeri ke hash tak dikenal → 404", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({
      method: "POST",
      url: `${GALLERY_BASE_PATH}tidakada/lead`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "consent=1",
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await h.close();
  }
});

/* ---- Kuota kiriman ------------------------------------------------ */

test("form galeri dibatasi laju, bukan cuma jalur JSON", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { galleryId, hash } = await seedGallery(h, token);
    await seedField(h, token, { label: "Nama Lengkap" });

    const postForm = () =>
      h.app.inject({
        method: "POST",
        url: `${GALLERY_BASE_PATH}${hash}/lead`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "nama_lengkap=Budi&consent=1",
      });

    for (let i = 0; i < LEAD_RATE_LIMIT; i += 1) {
      const res = await postForm();
      assert.equal(
        res.headers.location,
        `${GALLERY_BASE_PATH}${hash}?status=terkirim`,
        `kiriman form ke-${i + 1} harus lolos`,
      );
    }

    const blocked = await postForm();
    assert.equal(blocked.statusCode, 303);
    assert.equal(blocked.headers.location, `${GALLERY_BASE_PATH}${hash}?status=penuh`);
    assert.equal(listLeads(h.ctx.db, { galleryId }).length, LEAD_RATE_LIMIT, "yang ditahan tidak ditulis");
  } finally {
    await h.close();
  }
});

test("kuota dibagi antara form galeri dan POST /v1/leads", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);

    const payload = { galleryHash: hash, values: {}, consent: true };
    for (let i = 0; i < LEAD_RATE_LIMIT; i += 1) {
      const res = await h.app.inject({ method: "POST", url: "/v1/leads", payload });
      assert.equal(res.statusCode, 201, `kiriman JSON ke-${i + 1} harus lolos`);
    }

    // Kalau dua jalur punya hitungan sendiri-sendiri, ini akan lolos — dan
    // batasnya jadi dua kali lipat dari yang tertulis di konstanta.
    const viaForm = await h.app.inject({
      method: "POST",
      url: `${GALLERY_BASE_PATH}${hash}/lead`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "consent=1",
    });
    assert.equal(viaForm.headers.location, `${GALLERY_BASE_PATH}${hash}?status=penuh`);
  } finally {
    await h.close();
  }
});

test("halaman galeri menjelaskan kiriman yang ditahan", async () => {
  const h = await makeHarness();
  try {
    const token = await login(h);
    const { hash } = await seedGallery(h, token);
    await seedField(h, token, { label: "Nama Lengkap" });

    const res = await h.app.inject({ method: "GET", url: `${GALLERY_BASE_PATH}${hash}?status=penuh` });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /terlalu banyak/);
  } finally {
    await h.close();
  }
});
