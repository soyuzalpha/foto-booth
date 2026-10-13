/**
 * Tes klien HTTP panel galeri.
 *
 * Janji yang diuji:
 *
 *   1. **Satu galeri rusak tidak mengosongkan seluruh panel.** Balasan
 *      divalidasi per-item; yang gagal dibuang, sisanya tetap tampil.
 *   2. **Setiap request membawa token.** Tanpa header itu semua route
 *      mengembalikan 401 dan panel tampak "rusak" tanpa sebab yang jelas.
 *   3. **Field tambahan dari API tidak jadi `undefined` di layar.**
 *      `photoCount`/`url` tidak ada di `GallerySchema` — keduanya dibaca
 *      dengan nilai cadangan.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createGalleryClient,
  GalleryHttpError,
  parseGallerySummary,
  type GalleryClientOptions,
} from "./galleryClient.ts";

const TOKEN = "tok-123";

function galleryRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gal-1",
    eventId: "evt-1",
    hash: "AbCd1234",
    passwordProtected: false,
    expiresAt: "2026-02-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    photoCount: 12,
    url: "https://contoh.test/a/AbCd1234",
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
  options: Partial<GalleryClientOptions> = {},
): { client: ReturnType<typeof createGalleryClient>; calls: Call[] } {
  const calls: Call[] = [];
  const client = createGalleryClient({
    token: TOKEN,
    ...options,
    fetch: (async (url, init) => {
      const call = { url: String(url), init };
      calls.push(call);
      return respond(call);
    }) as typeof globalThis.fetch,
  });
  return { client, calls };
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

test("parseGallerySummary mengambil photoCount dan url dari balasan API", () => {
  assert.deepEqual(parseGallerySummary(galleryRaw()), {
    id: "gal-1",
    eventId: "evt-1",
    hash: "AbCd1234",
    passwordProtected: false,
    expiresAt: "2026-02-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    photoCount: 12,
    url: "https://contoh.test/a/AbCd1234",
  });
});

test("photoCount yang tidak masuk akal jadi 0, bukan NaN di layar", () => {
  assert.equal(parseGallerySummary(galleryRaw({ photoCount: undefined }))?.photoCount, 0);
  assert.equal(parseGallerySummary(galleryRaw({ photoCount: -3 }))?.photoCount, 0);
  assert.equal(parseGallerySummary(galleryRaw({ photoCount: Number.NaN }))?.photoCount, 0);
  assert.equal(parseGallerySummary(galleryRaw({ photoCount: "12" }))?.photoCount, 0);
  assert.equal(parseGallerySummary(galleryRaw({ url: undefined }))?.url, "");
});

test("galeri dengan bentuk tidak sah ditolak, bukan dipaksa masuk", () => {
  assert.equal(parseGallerySummary(null), null);
  assert.equal(parseGallerySummary({ ...galleryRaw(), hash: 12 }), null);
  assert.equal(parseGallerySummary({ ...galleryRaw(), id: undefined }), null);
});

/* ------------------------------------------------------------------ *
 * Request
 * ------------------------------------------------------------------ */

test("setiap request membawa token dan memakai prefix /v1", async () => {
  const { client, calls } = clientWith(() => jsonResponse({ galleries: [] }), {
    baseUrl: "https://contoh.test",
  });

  await client.listGalleries();

  assert.equal(calls[0]!.url, "https://contoh.test/v1/galleries");
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.match(headers.authorization ?? "", /^Bearer /i);
  assert.ok((headers.authorization ?? "").includes(TOKEN));
});

test("id galeri di-escape di URL", async () => {
  const { client, calls } = clientWith(() => jsonResponse(galleryRaw()));

  await client.getGallery("gal/aneh ?");

  assert.equal(calls[0]!.url, "/v1/galleries/gal%2Faneh%20%3F");
});

test("error HTTP jadi GalleryHttpError dengan pesan dari server", async () => {
  const { client } = clientWith(() => jsonResponse({ message: "galeri tidak ada" }, 404));

  await assert.rejects(
    () => client.getGallery("gal-1"),
    (error: unknown) => {
      assert.ok(error instanceof GalleryHttpError);
      assert.equal(error.status, 404);
      assert.equal(error.message, "galeri tidak ada");
      return true;
    },
  );
});

test("balasan error yang bukan JSON tetap memberi pesan dari status", async () => {
  const { client } = clientWith(() => new Response("nope", { status: 500 }));

  await assert.rejects(() => client.listEvents(), /HTTP 500/);
});

/* ------------------------------------------------------------------ *
 * Per-item, bukan borongan
 * ------------------------------------------------------------------ */

test("listGalleries membuang galeri rusak dan tetap menampilkan sisanya", async () => {
  const { client } = clientWith(() =>
    jsonResponse({
      galleries: [
        galleryRaw({ id: "baik-1" }),
        { id: "rusak" }, // hash hilang
        "bukan objek",
        galleryRaw({ id: "baik-2", photoCount: undefined }),
      ],
    }),
  );

  const galleries = await client.listGalleries();

  assert.deepEqual(galleries.map((g) => g.id), ["baik-1", "baik-2"]);
  assert.equal(galleries[1]!.photoCount, 0);
});

test("listGalleries mengembalikan [] kalau bentuk balasannya bukan daftar", async () => {
  const { client } = clientWith(() => jsonResponse({ galleries: "bukan array" }));
  assert.deepEqual(await client.listGalleries(), []);
});

test("listEvents menyaring acara rusak tanpa melempar", async () => {
  const { client } = clientWith(() =>
    jsonResponse({
      events: [
        { id: "evt-1", name: "Pernikahan", date: "2026-03-01", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "evt-2", name: "", date: "2026-03-01", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    }),
  );

  assert.deepEqual((await client.listEvents()).map((e) => e.id), ["evt-1"]);
});

test("getGallery memisahkan galeri, acara, dan foto yang sah saja", async () => {
  const { client } = clientWith(() =>
    jsonResponse({
      ...galleryRaw(),
      event: { id: "evt-1", name: "Pernikahan", date: "2026-03-01", createdAt: "2026-01-01T00:00:00.000Z" },
      photos: [
        {
          id: "p1",
          galleryId: "gal-1",
          url: "https://bucket.test/photos/1.jpg",
          thumbUrl: "https://bucket.test/thumbs/1.jpg",
          width: 6000,
          height: 4000,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        { id: "p2" }, // tidak lengkap
      ],
    }),
  );

  const detail = await client.getGallery("gal-1");

  assert.equal(detail.event?.name, "Pernikahan");
  assert.deepEqual(detail.photos.map((p) => p.id), ["p1"]);
  assert.equal(detail.photoCount, 12);
});

test("getGallery memberi event null kalau acaranya tidak dikenali", async () => {
  const { client } = clientWith(() => jsonResponse({ ...galleryRaw(), event: null, photos: [] }));

  const detail = await client.getGallery("gal-1");
  assert.equal(detail.event, null);
});

test("getGallery melempar kalau galerinya sendiri tidak dikenali", async () => {
  const { client } = clientWith(() => jsonResponse({ id: "rusak" }));

  await assert.rejects(() => client.getGallery("gal-1"), /tidak dikenali/);
});

/* ------------------------------------------------------------------ *
 * Tulis
 * ------------------------------------------------------------------ */

test("createEvent mengirim body JSON dan memvalidasi balasannya", async () => {
  const { client, calls } = clientWith(() =>
    jsonResponse({
      id: "evt-9",
      name: "Ulang tahun",
      date: "2026-04-01",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );

  const event = await client.createEvent({ name: "Ulang tahun", date: "2026-04-01" });

  assert.equal(event.id, "evt-9");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    name: "Ulang tahun",
    date: "2026-04-01",
  });
});

test("createEvent melempar kalau balasannya tidak dikenali", async () => {
  const { client } = clientWith(() => jsonResponse({ id: "evt-9" }));

  await assert.rejects(() => client.createEvent({ name: "x", date: "2026-04-01" }), /tidak dikenali/);
});

test("createGallery mengembalikan galeri lengkap dengan photoCount 0", async () => {
  const { client, calls } = clientWith(() => jsonResponse(galleryRaw({ photoCount: 0, url: "https://contoh.test/a/AbCd1234" })));

  const gallery = await client.createGallery({ eventId: "evt-1" });

  assert.equal(gallery.photoCount, 0);
  assert.equal(calls[0]!.init?.method, "POST");
});

test("deleteGallery melaporkan apa yang benar-benar dihapus", async () => {
  const { client, calls } = clientWith(() =>
    jsonResponse({ deleted: true, removedObjects: 14, removedPhotos: 7 }),
  );

  const report = await client.deleteGallery("gal-1");

  assert.deepEqual(report, { deleted: true, removedObjects: 14, removedPhotos: 7 });
  assert.equal(calls[0]!.init?.method, "DELETE");
});

test("deleteGallery tidak mengarang angka kalau balasannya tidak lengkap", async () => {
  const { client } = clientWith(() => jsonResponse({}));

  assert.deepEqual(await client.deleteGallery("gal-1"), {
    deleted: false,
    removedObjects: 0,
    removedPhotos: 0,
  });
});

test("profile membaca email, jumlah galeri, dan entitlement", async () => {
  const { client, calls } = clientWith(() =>
    jsonResponse({
      email: "a@b.c",
      galleries: 3,
      entitlement: { id: "e1", email: "a@b.c", plan: "personal", status: "active", maxActiveGalleries: 5, issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: null },
    }),
  );

  const profile = await client.profile();

  assert.equal(calls[0]!.url, "/v1/me");
  assert.equal(profile.email, "a@b.c");
  assert.equal(profile.galleries, 3);
  assert.equal(profile.entitlement?.plan, "personal");
});

test("profile tidak melempar saat entitlement kosong", async () => {
  const { client } = clientWith(() => jsonResponse({ email: "a@b.c" }));

  const profile = await client.profile();
  assert.equal(profile.entitlement, null);
  assert.equal(profile.galleries, 0);
});
