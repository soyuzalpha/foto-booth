/**
 * Tes cache konten offline.
 *
 * Yang diuji adalah **angka dan perilaku**, bukan tampilan:
 *
 *   - katalog disimpan sebelum aset diunduh (jaringan mati di tengah → daftar
 *     tetap ada);
 *   - aset yang gagal tidak menggagalkan sinkronisasi, tapi dihitung `failed`;
 *   - katalog yang belum pernah disinkronkan → `null`, bukan error;
 *   - `resolveCachedAsset` membuat object URL **dan** pemanggil bisa
 *     melepasnya (kalau tidak, blob hidup terus).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ContentItem, ContentKind } from "@foto-booth/shared";

import {
  MemoryContentCache,
  loadCachedCatalog,
  resolveCachedAsset,
  syncContent,
  type AssetFetcher,
  type CatalogFetcher,
} from "./contentCache.ts";

function item(id: string, kind: ContentKind = "stickers"): ContentItem {
  return {
    id,
    kind,
    name: id,
    url: `https://cdn.example.com/${kind}/${id}.png`,
    tags: [],
  };
}

function catalogOf(...ids: string[]): CatalogFetcher {
  return async () => ids.map((id) => item(id));
}

function assetsFor(available: string[]): AssetFetcher {
  const set = new Set(available);
  return async (url) => {
    if (!set.has(url)) return null;
    return new Blob([`bytes:${url}`], { type: "image/png" });
  };
}

test("syncContent menyimpan katalog dan semua aset yang bisa diunduh", async () => {
  const cache = new MemoryContentCache();
  const a = item("a");
  const b = item("b");

  const result = await syncContent(
    cache,
    "stickers",
    { catalog: async () => [a, b], asset: assetsFor([a.url, b.url]) },
    new Date("2026-10-12T10:00:00.000Z"),
  );

  assert.deepEqual(result, {
    kind: "stickers",
    items: 2,
    assets: 2,
    failed: 0,
    syncedAt: "2026-10-12T10:00:00.000Z",
  });

  const cached = await cache.getCatalog("stickers");
  assert.deepEqual(
    cached?.items.map((i) => i.id),
    ["a", "b"],
  );
  assert.deepEqual(await cache.assetUrls(), [a.url, b.url]);
});

test("syncContent menghitung aset yang gagal sebagai failed, katalog tetap tersimpan", async () => {
  const cache = new MemoryContentCache();
  const a = item("a");
  const b = item("b");

  const result = await syncContent(cache, "stickers", {
    catalog: async () => [a, b],
    asset: assetsFor([a.url]),
  });

  assert.equal(result.items, 2);
  assert.equal(result.assets, 1);
  assert.equal(result.failed, 1);

  // Yang penting: daftar tetap ada walau satu gambar belum terunduh.
  const cached = await cache.getCatalog("stickers");
  assert.equal(cached?.items.length, 2);
  assert.equal(await cache.getAsset(b.url), null);
});

test("syncContent menyimpan katalog SEBELUM mengunduh aset", async () => {
  const cache = new MemoryContentCache();
  const order: string[] = [];

  const originalPut = cache.putCatalog.bind(cache);
  cache.putCatalog = async (catalog) => {
    order.push("catalog");
    return originalPut(catalog);
  };

  await syncContent(cache, "frames", {
    catalog: async () => [item("f1", "frames")],
    asset: async (url) => {
      order.push("asset");
      return new Blob([url]);
    },
  });

  assert.deepEqual(order, ["catalog", "asset"]);
});

test("syncContent mencatat katalog kosong sebagai hasil yang sah", async () => {
  const cache = new MemoryContentCache();
  const result = await syncContent(cache, "backgrounds", {
    catalog: catalogOf(),
    asset: assetsFor([]),
  });

  assert.equal(result.items, 0);
  assert.equal(result.assets, 0);
  assert.deepEqual((await cache.getCatalog("backgrounds"))?.items, []);
});

test("loadCachedCatalog mengembalikan null untuk kategori yang belum disinkronkan", async () => {
  const cache = new MemoryContentCache();
  assert.equal(await loadCachedCatalog(cache, "starters"), null);
});

test("loadCachedCatalog mengembalikan katalog tersimpan beserta waktunya", async () => {
  const cache = new MemoryContentCache();
  await syncContent(
    cache,
    "starters",
    { catalog: catalogOf("s1", "s2"), asset: assetsFor([]) },
    new Date("2026-10-12T09:30:00.000Z"),
  );

  const cached = await loadCachedCatalog(cache, "starters");
  assert.equal(cached?.kind, "starters");
  assert.equal(cached?.items.length, 2);
  assert.equal(cached?.syncedAt, "2026-10-12T09:30:00.000Z");
});

test("kategori terpisah — satu kategori tidak menimpa kategori lain", async () => {
  const cache = new MemoryContentCache();
  await syncContent(cache, "frames", { catalog: catalogOf("f1"), asset: assetsFor([]) });
  await syncContent(cache, "stickers", { catalog: catalogOf("s1"), asset: assetsFor([]) });

  assert.deepEqual(
    (await cache.getCatalog("frames"))?.items.map((i) => i.id),
    ["f1"],
  );
  assert.deepEqual(
    (await cache.getCatalog("stickers"))?.items.map((i) => i.id),
    ["s1"],
  );
});

test("resolveCachedAsset membuat object URL dari blob yang tersimpan", async () => {
  const cache = new MemoryContentCache();
  const a = item("a");
  await cache.putAsset(a.url, new Blob(["x"], { type: "image/png" }));

  let created = 0;
  const resolved = await resolveCachedAsset(cache, a.url, () => {
    created += 1;
    return "blob:fake-1";
  });

  assert.equal(resolved?.url, "blob:fake-1");
  assert.equal(created, 1);
});

test("resolveCachedAsset mengembalikan null kalau aset tidak ada di cache", async () => {
  const cache = new MemoryContentCache();
  assert.equal(await resolveCachedAsset(cache, "https://cdn.example.com/nope.png"), null);
});

test("release() dari resolveCachedAsset melepas object URL yang dibuatnya", async () => {
  const cache = new MemoryContentCache();
  const url = "https://cdn.example.com/x.png";
  await cache.putAsset(url, new Blob(["x"]));

  const revoked: string[] = [];
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (objectUrl: string) => {
    revoked.push(objectUrl);
  };

  try {
    const resolved = await resolveCachedAsset(cache, url, () => "blob:fake-2");
    assert.notEqual(resolved, null);
    assert.deepEqual(revoked, []);

    resolved?.release();
    assert.deepEqual(revoked, ["blob:fake-2"]);
  } finally {
    URL.revokeObjectURL = originalRevoke;
  }
});

test("createContentCache pakai IndexedDB kalau tersedia, memory kalau tidak", async () => {
  const { createContentCache } = await import("./contentCache.ts");

  const withIdb = createContentCache({ indexedDB: {} as IDBFactory });
  assert.equal(withIdb.kind, "indexeddb");

  const without = createContentCache({});
  assert.equal(without.kind, "memory");
});
