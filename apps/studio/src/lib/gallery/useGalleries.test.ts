/**
 * Tes pengendali daftar galeri (`createGalleriesController`).
 *
 * Logikanya sengaja dipisah dari React supaya dua janji yang tidak kelihatan
 * di UI bisa dibuktikan di sini:
 *
 *   1. **Tanpa token, jangan memanggil API.** Kiosk yang belum login akan
 *      menembakkan 401 beruntun kalau `refresh` tetap jalan.
 *   2. **Balapan respons dibuang.** Operator menekan "Muat ulang" dua kali;
 *      respons pertama yang datang belakangan tidak boleh menimpa yang baru.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createGalleriesController, type GalleriesState } from "./useGalleries.ts";
import type { GalleryClient, GallerySummary } from "./galleryClient.ts";

function summary(id: string, overrides: Partial<GallerySummary> = {}): GallerySummary {
  return {
    id,
    eventId: "evt-1",
    hash: `hash-${id}`,
    passwordProtected: false,
    expiresAt: "2026-02-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    photoCount: 0,
    url: `https://contoh.test/a/hash-${id}`,
    ...overrides,
  };
}

interface FakeClient extends GalleryClient {
  calls: string[];
  /** Ubah hasil `listGalleries` berikutnya. */
  next: () => Promise<GallerySummary[]>;
}

function fakeClient(initial: () => Promise<GallerySummary[]> = async () => []): FakeClient {
  let next = initial;
  const calls: string[] = [];
  return {
    calls,
    get next() {
      return next;
    },
    set next(value: () => Promise<GallerySummary[]>) {
      next = value;
    },
    async listEvents() {
      calls.push("listEvents");
      return [];
    },
    async createEvent(body) {
      calls.push("createEvent");
      return { id: "evt-9", createdAt: "2026-01-01T00:00:00.000Z", ...body };
    },
    async listGalleries() {
      calls.push("listGalleries");
      return next();
    },
    async getGallery(id) {
      calls.push("getGallery");
      return { ...summary(id), event: null, photos: [] };
    },
    async createGallery(body) {
      calls.push("createGallery");
      return summary("gal-baru", { eventId: body.eventId });
    },
    async deleteGallery(id) {
      calls.push(`deleteGallery:${id}`);
      return { deleted: true, removedObjects: 0, removedPhotos: 0 };
    },
    async profile() {
      calls.push("profile");
      return { email: "a@b.c", galleries: 0, entitlement: null };
    },
  };
}

/** Janji yang bisa diselesaikan dari luar — untuk menguji urutan balapan. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("tanpa klien, refresh TIDAK memanggil API sama sekali", async () => {
  const states: GalleriesState[] = [];
  const controller = createGalleriesController({ client: null, onState: (s) => states.push(s) });

  await controller.refresh();

  assert.deepEqual(controller.getState(), { galleries: [], loading: false, error: null });
  // Satu pun tidak boleh terlihat "loading": belum login bukan proses memuat.
  assert.deepEqual(states, [{ galleries: [], loading: false, error: null }]);
});

test("refresh menyalakan loading lalu mengisi daftar", async () => {
  const client = fakeClient(async () => [summary("gal-1"), summary("gal-2")]);
  const states: GalleriesState[] = [];
  const controller = createGalleriesController({ client, onState: (s) => states.push(s) });

  await controller.refresh();

  assert.deepEqual(
    states.map((s) => s.loading),
    [true, false],
  );
  assert.deepEqual(controller.getState().galleries.map((g) => g.id), ["gal-1", "gal-2"]);
  assert.equal(controller.getState().error, null);
});

test("daftar lama tetap tampil selama memuat (layar tidak berkedip kosong)", async () => {
  const client = fakeClient(async () => [summary("gal-1")]);
  const controller = createGalleriesController({ client });

  await controller.refresh();

  const pending = deferred<GallerySummary[]>();
  client.next = () => pending.promise;
  const inflight = controller.refresh();

  assert.deepEqual(controller.getState().galleries.map((g) => g.id), ["gal-1"]);
  assert.equal(controller.getState().loading, true);

  pending.resolve([summary("gal-1"), summary("gal-2")]);
  await inflight;
});

test("respons yang datang belakangan dari refresh lama dibuang", async () => {
  const client = fakeClient();
  const controller = createGalleriesController({ client });

  const first = deferred<GallerySummary[]>();
  const second = deferred<GallerySummary[]>();

  client.next = () => first.promise;
  const inflightA = controller.refresh();

  client.next = () => second.promise;
  const inflightB = controller.refresh();

  // Yang baru selesai lebih dulu, yang lama menyusul — urutan ini yang
  // sebenarnya terjadi di jaringan, dan inilah yang bikin daftar "mundur".
  second.resolve([summary("gal-baru")]);
  await inflightB;
  first.resolve([summary("gal-lama")]);
  await inflightA;

  assert.deepEqual(controller.getState().galleries.map((g) => g.id), ["gal-baru"]);
});

test("kegagalan memuat jadi pesan, dan daftar lama tidak dihapus", async () => {
  const client = fakeClient(async () => [summary("gal-1")]);
  const controller = createGalleriesController({ client });
  await controller.refresh();

  client.next = async () => {
    throw new Error("jaringan putus");
  };
  await controller.refresh();

  const state = controller.getState();
  assert.equal(state.error, "jaringan putus");
  assert.equal(state.loading, false);
  assert.deepEqual(state.galleries.map((g) => g.id), ["gal-1"]);
});

test("error yang bukan Error tetap punya pesan", async () => {
  const client = fakeClient();
  const controller = createGalleriesController({ client });

  // Bukan `throw` di dalam async: nilai apa pun bisa ditolak, dan UI harus
  // tetap punya pesan yang bisa ditampilkan.
  client.next = () => Promise.reject("putus");
  await controller.refresh();

  assert.equal(controller.getState().error, "putus");
});

test("createGallery meminta daftar ulang ke server, bukan menebak hasilnya", async () => {
  const client = fakeClient(async () => [summary("gal-baru")]);
  const controller = createGalleriesController({ client });

  const created = await controller.createGallery({ eventId: "evt-1" });

  assert.equal(created.id, "gal-baru");
  // `photoCount` dan `url` dihitung server — menebaknya bikin angka di panel
  // berbeda dari yang dilihat tamu.
  assert.deepEqual(client.calls, ["createGallery", "listGalleries"]);
  assert.deepEqual(controller.getState().galleries.map((g) => g.id), ["gal-baru"]);
});

test("removeGallery menghapus lalu memuat ulang", async () => {
  const client = fakeClient(async () => []);
  const controller = createGalleriesController({ client });

  await controller.removeGallery("gal-1");

  assert.deepEqual(client.calls, ["deleteGallery:gal-1", "listGalleries"]);
});

test("aksi tulis tanpa klien melempar 'belum login', bukan gagal senyap", async () => {
  const controller = createGalleriesController({ client: null });

  await assert.rejects(() => controller.createGallery({ eventId: "evt-1" }), /belum login/);
  await assert.rejects(() => controller.removeGallery("gal-1"), /belum login/);
  await assert.rejects(
    () => controller.createEvent({ name: "x", date: "2026-04-01" }),
    /belum login/,
  );
});
