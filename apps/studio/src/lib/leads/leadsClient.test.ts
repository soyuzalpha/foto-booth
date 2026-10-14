/**
 * Tes klien HTTP panel leads & analytics.
 *
 * Janji yang diuji:
 *
 *   1. **Satu baris rusak tidak mengosongkan seluruh panel.** Balasan
 *      divalidasi per-item; yang gagal dibuang, sisanya tetap tampil.
 *   2. **Setiap request membawa token.** Tanpa header itu semua route
 *      mengembalikan 401 dan panel tampak "rusak" tanpa sebab yang jelas.
 *   3. **Ekspor CSV mengembalikan teks dan nama berkasnya**, bukan blob —
 *      unduhan disusun di panel, di sini yang diuji isinya.
 *   4. **Angka yang tidak dikenali jadi `null`, bukan lemparan.** Dasbor
 *      kosong lebih baik daripada tab leads yang mati total.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createLeadsClient,
  filenameFromDisposition,
  LeadsHttpError,
  type LeadsClientOptions,
} from "./leadsClient.ts";

const TOKEN = "tok-123";

function fieldRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fld-1",
    eventId: null,
    key: "nama",
    label: "Nama",
    type: "text",
    required: true,
    options: [],
    helpText: null,
    sortOrder: 0,
    active: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function leadRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "lead-1",
    eventId: null,
    galleryId: "gal-1",
    values: { nama: "Budi Santoso", suka: true },
    consent: true,
    consentText: "Saya setuju data saya disimpan.",
    consentVersion: "v1",
    source: "gallery",
    createdAt: "2026-10-12T02:00:00.000Z",
    ...overrides,
  };
}

function overviewRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: "2026-07-16",
    to: "2026-11-13",
    totals: { events: 1, galleries: 2, photos: 40, views: 7, leads: 3 },
    events: [
      {
        eventId: "evt-1",
        name: "Pernikahan Budi & Ani",
        date: "2026-10-12",
        galleries: 2,
        photos: 40,
        views: 7,
        leads: 3,
      },
    ],
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

/** Klien dengan `fetch` palsu; `calls` mencatat setiap request. */
function clientWith(
  respond: (call: Call) => Response | Promise<Response>,
  options: Partial<LeadsClientOptions> = {},
): { client: ReturnType<typeof createLeadsClient>; calls: Call[] } {
  const calls: Call[] = [];
  const client = createLeadsClient({
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

/* ---- Penjaga autentikasi ----------------------------------------- */

test("setiap request membawa token Bearer", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ fields: [], maxFields: 8 }));
  await client.listFields();

  assert.equal(calls.length, 1);
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
});

test("ekspor CSV juga membawa token, walau tidak lewat helper send()", async () => {
  const { client, calls } = clientWith(
    () => new Response("a,b\n1,2\n", { headers: { "content-type": "text/csv" } }),
  );
  await client.exportCsv();

  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
});

/* ---- Field -------------------------------------------------------- */

test("daftar field membuang baris rusak, sisanya tetap tampil", async () => {
  const { client } = clientWith(() =>
    jsonResponse({
      fields: [
        fieldRaw({ id: "fld-1", key: "nama" }),
        // Tipe di luar daftar dikenal → dibuang.
        fieldRaw({ id: "fld-2", key: "aneh", type: "warna" }),
        fieldRaw({ id: "fld-3", key: "email", type: "email" }),
      ],
      maxFields: 12,
    }),
  );

  const { fields, maxFields } = await client.listFields();
  assert.deepEqual(
    fields.map((field) => field.id),
    ["fld-1", "fld-3"],
  );
  assert.equal(maxFields, 12);
});

test("balasan field yang bukan daftar menghasilkan daftar kosong, bukan lemparan", async () => {
  const { client } = clientWith(() => jsonResponse({ fields: "bukan-daftar" }));
  assert.deepEqual(await client.listFields(), { fields: [], maxFields: null });
});

test("maxFields yang tidak ada jadi null, bukan undefined", async () => {
  const { client } = clientWith(() => jsonResponse({ fields: [fieldRaw()] }));
  const { maxFields } = await client.listFields();
  assert.equal(maxFields, null);
});

test("daftar field menyusun query eventId", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ fields: [] }));
  await client.listFields("evt 1");

  assert.match(calls[0]?.url ?? "", /\/v1\/leads\/admin\/fields\?eventId=evt%201$/);
});

test("buat field mem-POST body dan memvalidasi balasannya", async () => {
  const { client, calls } = clientWith(() => jsonResponse(fieldRaw({ id: "fld-baru" }), 201));

  const created = await client.createField({ label: "Nama", type: "text", required: true, options: [], active: true });

  assert.equal(created.id, "fld-baru");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.match(calls[0]?.url ?? "", /\/v1\/leads\/admin\/fields$/);
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
});

test("balasan field yang tidak dikenali jadi LeadsHttpError", async () => {
  const { client } = clientWith(() => jsonResponse({ field: "aneh" }, 201));
  await assert.rejects(
    () => client.createField({ label: "Nama", type: "text", required: false, options: [], active: true }),
    (error: unknown) => error instanceof LeadsHttpError && error.status === 201,
  );
});

test("patch field memakai PATCH dan id ter-encode", async () => {
  const { client, calls } = clientWith(() => jsonResponse(fieldRaw({ active: false })));

  const updated = await client.updateField("fld/1", { active: false });
  assert.equal(updated.active, false);
  assert.equal(calls[0]?.init?.method, "PATCH");
  assert.match(calls[0]?.url ?? "", /\/v1\/leads\/admin\/fields\/fld%2F1$/);
});

test("hapus field memakai DELETE dan tidak membaca body", async () => {
  const { client, calls } = clientWith(() => new Response(null, { status: 204 }));
  await client.deleteField("fld-1");
  assert.equal(calls[0]?.init?.method, "DELETE");
});

/* ---- Data tamu ---------------------------------------------------- */

test("daftar data tamu menyusun query dan membuang baris rusak", async () => {
  const { client, calls } = clientWith(() =>
    jsonResponse({
      leads: [
        leadRaw({ id: "lead-1" }),
        // Consent bukan boolean → melanggar skema → dibuang.
        leadRaw({ id: "lead-2", consent: "ya" }),
        leadRaw({ id: "lead-3" }),
      ],
      fields: [fieldRaw()],
    }),
  );

  const { leads, fields } = await client.listLeads({ eventId: "evt-1", limit: 50 });
  assert.deepEqual(
    leads.map((lead) => lead.id),
    ["lead-1", "lead-3"],
  );
  assert.equal(fields.length, 1);
  assert.match(calls[0]?.url ?? "", /\/v1\/leads\/admin\/leads\?eventId=evt-1&limit=50$/);
});

test("tanpa filter, daftar data tamu tidak menempelkan tanda tanya kosong", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ leads: [], fields: [] }));
  await client.listLeads();
  assert.match(calls[0]?.url ?? "", /\/v1\/leads\/admin\/leads$/);
});

test("nilai boolean di data tamu tetap boolean, bukan jadi string", async () => {
  const { client } = clientWith(() => jsonResponse({ leads: [leadRaw()], fields: [] }));
  const { leads } = await client.listLeads();
  assert.equal(leads[0]?.values.suka, true);
});

test("hapus data tamu memakai DELETE", async () => {
  const { client, calls } = clientWith(() => new Response(null, { status: 204 }));
  await client.deleteLead("lead-1");
  assert.equal(calls[0]?.init?.method, "DELETE");
});

/* ---- Ekspor CSV --------------------------------------------------- */

test("ekspor CSV mengembalikan teks dan nama berkas dari header", async () => {
  const { client } = clientWith(
    () =>
      new Response("waktu,nama\n2026-10-12,Budi\n", {
        headers: {
          "content-type": "text/csv",
          "content-disposition": "attachment; filename=\"leads-2026-10-12.csv\"",
        },
      }),
  );

  const result = await client.exportCsv({ eventId: "evt-1" });
  assert.equal(result.filename, "leads-2026-10-12.csv");
  assert.match(result.csv, /Budi/);
});

test("tanpa content-disposition, nama berkas jatuh ke cadangan", async () => {
  const { client } = clientWith(() => new Response("a\n", { headers: { "content-type": "text/csv" } }));
  const result = await client.exportCsv();
  assert.equal(result.filename, "leads.csv");
});

test("nama berkas UTF-8 menang atas versi ASCII-nya", () => {
  const header = "attachment; filename=\"leads.csv\"; filename*=UTF-8''leads%20Oktober.csv";
  assert.equal(filenameFromDisposition(header, "cadangan.csv"), "leads Oktober.csv");
});

test("nama berkas dengan persen-encoding rusak jatuh ke bentuk biasa", () => {
  const header = "attachment; filename=\"aman.csv\"; filename*=UTF-8''rusak%ZZ.csv";
  assert.equal(filenameFromDisposition(header, "cadangan.csv"), "aman.csv");
});

test("header kosong memakai nama cadangan", () => {
  assert.equal(filenameFromDisposition(null, "cadangan.csv"), "cadangan.csv");
});

/* ---- Analytics ---------------------------------------------------- */

test("angka per acara dibaca apa adanya", async () => {
  const { client, calls } = clientWith(() => jsonResponse(overviewRaw()));
  const overview = await client.analytics({ from: "2026-10-01", to: "2026-10-31" });

  assert.equal(overview?.totals.photos, 40);
  assert.equal(overview?.events[0]?.name, "Pernikahan Budi & Ani");
  assert.match(calls[0]?.url ?? "", /\/v1\/analytics\/overview\?from=2026-10-01&to=2026-10-31$/);
});

test("angka yang tidak dikenali jadi null, bukan lemparan", async () => {
  const { client } = clientWith(() => jsonResponse({ aneh: true }));
  assert.equal(await client.analytics(), null);
});

test("angka negatif melanggar skema → null", async () => {
  const { client } = clientWith(() =>
    jsonResponse(overviewRaw({ totals: { events: 1, galleries: 2, photos: -3, views: 7, leads: 3 } })),
  );
  assert.equal(await client.analytics(), null);
});

/* ---- Galat HTTP --------------------------------------------------- */

test("galat HTTP memakai pesan dari server, bukan status telanjang", async () => {
  const { client } = clientWith(() =>
    jsonResponse({ error: "unauthorized", message: "token tidak sah", statusCode: 401 }, 401),
  );

  await assert.rejects(
    () => client.listLeads(),
    (error: unknown) => error instanceof LeadsHttpError && error.message === "token tidak sah",
  );
});

test("galat tanpa body JSON jatuh ke status", async () => {
  const { client } = clientWith(() => new Response("boom", { status: 500 }));
  await assert.rejects(
    () => client.listFields(),
    (error: unknown) => error instanceof LeadsHttpError && error.message === "HTTP 500",
  );
});
