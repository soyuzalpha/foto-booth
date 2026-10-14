/**
 * Tes pengendali daftar leads (`createLeadsController`).
 *
 * Logikanya sengaja dipisah dari React supaya janji yang tidak kelihatan di UI
 * bisa dibuktikan di sini:
 *
 *   1. **Tanpa token, jangan memanggil API.** Kiosk yang belum login akan
 *      menembakkan 401 beruntun kalau `refresh` tetap jalan.
 *   2. **Balapan respons dibuang.** Operator menekan "Muat ulang" dua kali;
 *      respons pertama yang datang belakangan tidak boleh menimpa yang baru.
 *   3. **Aksi yang mengubah data memuat ulang dari server**, bukan menambal
 *      lokal — daftar di layar harus sama dengan yang dilihat server.
 *   4. **Satu kegagalan tidak mengosongkan yang lain.** Angka gagal tidak
 *      menghapus data tamu yang sudah tampil.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AnalyticsOverview, Lead, LeadField } from "@foto-booth/shared";

import type { LeadsClient } from "./leadsClient.ts";
import { createLeadsController, type LeadsState } from "./useLeads.ts";

function field(id: string, overrides: Partial<LeadField> = {}): LeadField {
  return {
    id,
    eventId: null,
    key: id,
    label: id,
    type: "text",
    required: false,
    options: [],
    helpText: null,
    sortOrder: 0,
    active: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function lead(id: string, overrides: Partial<Lead> = {}): Lead {
  return {
    id,
    eventId: null,
    galleryId: "gal-1",
    values: { nama: "Budi Santoso" },
    consent: true,
    consentText: "Saya setuju.",
    consentVersion: "v1",
    source: "gallery",
    createdAt: "2026-10-12T02:00:00.000Z",
    ...overrides,
  };
}

function overview(): AnalyticsOverview {
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
  };
}

interface FakeClient extends LeadsClient {
  calls: string[];
  nextFields: () => Promise<LeadField[]>;
  nextLeads: () => Promise<Lead[]>;
  nextAnalytics: () => Promise<AnalyticsOverview | null>;
}

function fakeClient(): FakeClient {
  let nextFields: () => Promise<LeadField[]> = async () => [field("nama")];
  let nextLeads: () => Promise<Lead[]> = async () => [lead("lead-1")];
  let nextAnalytics: () => Promise<AnalyticsOverview | null> = async () => overview();
  const calls: string[] = [];

  return {
    calls,
    get nextFields() {
      return nextFields;
    },
    set nextFields(value: () => Promise<LeadField[]>) {
      nextFields = value;
    },
    get nextLeads() {
      return nextLeads;
    },
    set nextLeads(value: () => Promise<Lead[]>) {
      nextLeads = value;
    },
    get nextAnalytics() {
      return nextAnalytics;
    },
    set nextAnalytics(value: () => Promise<AnalyticsOverview | null>) {
      nextAnalytics = value;
    },

    async listFields() {
      calls.push("listFields");
      return { fields: await nextFields(), maxFields: 12 };
    },
    async createField(body) {
      calls.push(`createField:${body.label}`);
      return field("baru", { label: body.label });
    },
    async updateField(id, body) {
      calls.push(`updateField:${id}`);
      return field(id, body as Partial<LeadField>);
    },
    async deleteField(id) {
      calls.push(`deleteField:${id}`);
    },
    async listLeads() {
      calls.push("listLeads");
      return { leads: await nextLeads(), fields: [field("nama")] };
    },
    async deleteLead(id) {
      calls.push(`deleteLead:${id}`);
    },
    async exportCsv() {
      calls.push("exportCsv");
      return { filename: "leads.csv", csv: "waktu,nama\n" };
    },
    async analytics() {
      calls.push("analytics");
      return nextAnalytics();
    },
  };
}

/* ---- Penjaga token ------------------------------------------------ */

test("tanpa klien (belum login), refresh tidak memanggil API", async () => {
  const states: LeadsState[] = [];
  const controller = createLeadsController({
    client: null,
    onState: (state) => states.push(state),
  });

  await controller.refresh();

  const last = controller.getState();
  assert.deepEqual(last.fields, []);
  assert.deepEqual(last.leads, []);
  assert.equal(last.analytics, null);
  // Yang penting: tidak ada state "memuat" yang tak pernah selesai.
  assert.ok(states.every((state) => state.loading === false));
});

test("aksi tanpa klien ditolak, bukan diam-diam tidak terjadi", async () => {
  const controller = createLeadsController({ client: null });
  await assert.rejects(
    () => controller.createField({ label: "Nama", type: "text", required: false, options: [], active: true }),
    /belum login/,
  );
  await assert.rejects(() => controller.removeLead("lead-1"), /belum login/);
});

/* ---- Pemuatan ----------------------------------------------------- */

test("refresh memuat field dan data tamu sekaligus", async () => {
  const client = fakeClient();
  client.nextLeads = async () => [lead("lead-1"), lead("lead-2")];
  const controller = createLeadsController({ client });

  await controller.refresh();

  const state = controller.getState();
  assert.deepEqual(
    state.leads.map((row) => row.id),
    ["lead-1", "lead-2"],
  );
  assert.equal(state.fields.length, 1);
  assert.equal(state.maxFields, 12);
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
});

test("angka dimuat terpisah dari data tamu", async () => {
  const client = fakeClient();
  const controller = createLeadsController({ client });

  await controller.refreshAnalytics();
  assert.equal(controller.getState().analytics?.totals.photos, 40);

  await controller.refresh();
  // Data tamu tidak menghapus angka yang sudah dimuat.
  assert.equal(controller.getState().analytics?.totals.photos, 40);
});

test("angka gagal tidak mengosongkan data tamu yang sudah tampil", async () => {
  const client = fakeClient();
  const controller = createLeadsController({ client });

  await controller.refresh();
  await controller.refreshAnalytics();
  assert.equal(controller.getState().analytics?.totals.photos, 40);

  client.nextAnalytics = async () => {
    throw new Error("analytics mati");
  };
  await controller.refreshAnalytics();

  const state = controller.getState();
  assert.equal(state.leads.length, 1);
  // Angka lama tetap tampil, bukan direset ke null: satu permintaan gagal
  // tidak boleh mengosongkan dasbor yang sudah terisi.
  assert.equal(state.analytics?.totals.photos, 40);
  assert.match(state.error ?? "", /analytics mati/);
});

test("gagal memuat menandai galat dan mematikan tanda memuat", async () => {
  const client = fakeClient();
  client.nextLeads = async () => {
    throw new Error("db terkunci");
  };
  const controller = createLeadsController({ client });

  await controller.refresh();

  const state = controller.getState();
  assert.equal(state.loading, false);
  assert.match(state.error ?? "", /db terkunci/);
});

/* ---- Balapan respons ---------------------------------------------- */

test("respons lama yang datang belakangan tidak menimpa yang baru", async () => {
  const client = fakeClient();
  const controller = createLeadsController({ client });

  // Deferred eksplisit: `let fn = null` lalu diisi di dalam closure tidak
  // dilacak oleh analisis alur tipe TypeScript, jadi dipakai objek.
  const gate: { open: (() => void) | null } = { open: null };
  client.nextLeads = () =>
    new Promise<Lead[]>((resolve) => {
      gate.open = () => resolve([lead("lama")]);
    });

  const first = controller.refresh();
  client.nextLeads = async () => [lead("baru")];
  const second = controller.refresh();

  await second;
  gate.open?.();
  await first;

  assert.deepEqual(
    controller.getState().leads.map((row) => row.id),
    ["baru"],
  );
});

/* ---- Aksi yang mengubah data -------------------------------------- */

test("buat field memanggil API lalu memuat ulang dari server", async () => {
  const client = fakeClient();
  const controller = createLeadsController({ client });

  await controller.createField({ label: "Email", type: "email", required: true, options: [], active: true });

  assert.deepEqual(client.calls, ["createField:Email", "listFields", "listLeads"]);
});

test("hapus field memanggil API lalu memuat ulang dari server", async () => {
  const client = fakeClient();
  const controller = createLeadsController({ client });

  await controller.deleteField("fld-1");

  assert.deepEqual(client.calls, ["deleteField:fld-1", "listFields", "listLeads"]);
});

test("buang data tamu memanggil API lalu memuat ulang dari server", async () => {
  const client = fakeClient();
  const controller = createLeadsController({ client });

  await controller.removeLead("lead-1");

  assert.deepEqual(client.calls, ["deleteLead:lead-1", "listFields", "listLeads"]);
});

test("ekspor CSV meneruskan filter apa adanya tanpa memuat ulang", async () => {
  const client = fakeClient();
  const controller = createLeadsController({ client });

  const result = await controller.exportCsv({ eventId: "evt-1" });
  assert.equal(result.filename, "leads.csv");
  assert.deepEqual(client.calls, ["exportCsv"]);
});
