import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CACHE_NAME,
  createModelCache,
  modelUrl,
  type CacheLike,
  type CacheStorageLike,
} from "./modelCache.ts";

/** Cache palsu: Map sederhana + hitungan put. */
function fakeCacheStorage(): CacheStorageLike & {
  store: Map<string, Response>;
  puts: number;
  openCount: number;
} {
  const store = new Map<string, Response>();
  const state = { store, puts: 0, openCount: 0 };

  const cache: CacheLike = {
    async match(request) {
      return store.get(request);
    },
    async put(request, response) {
      state.puts += 1;
      store.set(request, response);
    },
  };

  return {
    store,
    get puts() {
      return state.puts;
    },
    get openCount() {
      return state.openCount;
    },
    async open() {
      state.openCount += 1;
      return cache;
    },
    async delete() {
      const had = store.size > 0;
      store.clear();
      return had;
    },
    async has() {
      return true;
    },
  } as CacheStorageLike & { store: Map<string, Response>; puts: number; openCount: number };
}

function okResponse(body = "model"): Response {
  return new Response(body, { status: 200 });
}

test("modelUrl menggabungkan base & nama tanpa garis miring ganda", () => {
  assert.equal(modelUrl("", "gfpgan.onnx"), "/models/gfpgan.onnx");
  assert.equal(modelUrl("/", "gfpgan.onnx"), "/models/gfpgan.onnx");
  assert.equal(modelUrl("https://x.test", "/gfpgan.onnx"), "https://x.test/models/gfpgan.onnx");
  assert.equal(modelUrl("https://x.test/", "a/b.onnx"), "https://x.test/models/a/b.onnx");
});

test("ensure mengunduh sekali, panggilan kedua dari cache (tanpa jaringan)", async () => {
  const caches = fakeCacheStorage();
  let fetches = 0;
  const cache = createModelCache({
    caches,
    fetch: (async () => {
      fetches += 1;
      return okResponse("bytes");
    }) as unknown as typeof fetch,
  });

  const first = await cache.ensure("gfpgan.onnx");
  assert.ok(first !== null);
  assert.equal(fetches, 1);
  assert.equal(caches.puts, 1, "hasil harus disimpan");

  const second = await cache.ensure("gfpgan.onnx");
  assert.ok(second !== null);
  assert.equal(fetches, 1, "unduhan kedua harus dilayani cache");
  assert.equal(await cache.has("gfpgan.onnx"), true);
});

test("kegagalan menyimpan cache tidak menggagalkan pemakaian model", async () => {
  const store = new Map<string, Response>();
  const failing: CacheStorageLike = {
    async open() {
      return {
        async match() {
          return undefined;
        },
        async put() {
          throw new Error("kuota penuh");
        },
      };
    },
    async delete() {
      return false;
    },
    async has() {
      return true;
    },
  };

  const cache = createModelCache({
    caches: failing,
    fetch: (async () => okResponse("bytes")) as unknown as typeof fetch,
  });

  const res = await cache.ensure("gfpgan.onnx");
  assert.ok(res !== null, "response tetap dikembalikan walau put gagal");
  assert.equal(await res.text(), "bytes");
  assert.equal(store.size, 0);
});

test("tanpa caches API → tetap jalan, tiap panggilan ambil dari jaringan", async () => {
  let fetches = 0;
  const cache = createModelCache({
    caches: null,
    fetch: (async () => {
      fetches += 1;
      return okResponse();
    }) as unknown as typeof fetch,
  });

  assert.ok((await cache.ensure("m.onnx")) !== null);
  assert.ok((await cache.ensure("m.onnx")) !== null);
  assert.equal(fetches, 2);
  assert.equal(await cache.has("m.onnx"), false);
  assert.deepEqual(await cache.list(), []);
});

test("respons non-ok (404) diperlakukan sebagai gagal → null", async () => {
  const cache = createModelCache({
    caches: fakeCacheStorage(),
    fetch: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
  });
  assert.equal(await cache.ensure("hilang.onnx"), null);
});

test("fetch melempar → null, bukan crash", async () => {
  const cache = createModelCache({
    caches: fakeCacheStorage(),
    fetch: (async () => {
      throw new Error("jaringan mati");
    }) as unknown as typeof fetch,
  });
  assert.equal(await cache.ensure("m.onnx"), null);
});

test("cacheName default & bisa diganti; clear menghapus cache", async () => {
  assert.equal(createModelCache().cacheName, DEFAULT_CACHE_NAME);

  const caches = fakeCacheStorage();
  const cache = createModelCache({
    cacheName: "custom",
    caches,
    fetch: (async () => okResponse()) as unknown as typeof fetch,
  });
  await cache.ensure("m.onnx");
  assert.equal(caches.store.size, 1);
  await cache.clear();
  assert.equal(caches.store.size, 0);
});

test("list mengembalikan nama model yang tersimpan", async () => {
  const store = new Map<string, Response>();
  const caches: CacheStorageLike = {
    async open() {
      const cache: CacheLike & { keys(): Promise<{ url: string }[]> } = {
        async match(request: string) {
          return store.get(request);
        },
        async put(request: string, response: Response) {
          store.set(request, response);
        },
        async keys() {
          return [...store.keys()].map((url) => ({ url }));
        },
      };
      return cache;
    },
    async delete() {
      return true;
    },
    async has() {
      return true;
    },
  };

  const cache = createModelCache({ caches, fetch: (async () => okResponse()) as unknown as typeof fetch });
  await cache.ensure("a.onnx");
  await cache.ensure("b.onnx");
  assert.deepEqual((await cache.list()).sort(), ["a.onnx", "b.onnx"]);
});

test("list cocok dengan kunci cache ABSOLUT (perilaku nyata browser)", async () => {
  // Di browser, Cache Storage menyimpan URL **absolut**
  // (`http://host:5173/studio/models/x.tflite`), sedangkan prefix model relatif
  // (`/studio/models/`). `startsWith` biasa → daftar selalu kosong.
  const ORIGIN = "http://127.0.0.1:5173";
  const store = new Map<string, Response>();
  const abs = (u: string): string => new URL(u, ORIGIN).href;

  const caches: CacheStorageLike = {
    async open() {
      const cache: CacheLike & { keys(): Promise<{ url: string }[]> } = {
        // Tiru Cache Storage: kunci dinormalkan jadi URL absolut.
        async match(request: string) {
          return store.get(abs(request));
        },
        async put(request: string, response: Response) {
          store.set(abs(request), response);
        },
        async keys() {
          return [...store.keys()].map((url) => ({ url }));
        },
      };
      return cache;
    },
    async delete() {
      return true;
    },
    async has() {
      return true;
    },
  };

  const cache = createModelCache({
    caches,
    baseUrl: "/studio",
    fetch: (async () => okResponse()) as unknown as typeof fetch,
  });

  await cache.ensure("selfie_segmenter.tflite");
  await cache.ensure("gfpgan.onnx");

  // Kunci tersimpan harus absolut…
  assert.deepEqual([...store.keys()].sort(), [
    "http://127.0.0.1:5173/studio/models/gfpgan.onnx",
    "http://127.0.0.1:5173/studio/models/selfie_segmenter.tflite",
  ]);
  // …dan `list` tetap mengembalikan nama model tanpa duplikat.
  assert.deepEqual((await cache.list()).sort(), ["gfpgan.onnx", "selfie_segmenter.tflite"]);
});
