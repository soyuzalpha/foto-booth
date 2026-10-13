/**
 * Cache model AI besar — unduh sekali, lalu offline.
 *
 * Model seperti GFPGAN (ratusan MB) terlalu besar untuk ikut bundel aplikasi,
 * tapi kiosk harus tetap bisa memakainya **tanpa internet** setelah sinkron
 * pertama. Jembatannya Cache Storage: `fetch` sekali dari `/models/*`, simpan,
 * dan seterusnya dibaca dari cache.
 *
 * Prinsip yang dijaga di sini:
 *
 *   · **Cache itu best-effort.** Kalau `caches` tidak ada (mode privat, browser
 *     lama) atau `put` gagal (kuota), model tetap dikembalikan ke pemanggil —
 *     cuma tidak tersimpan. Kegagalan menyimpan tidak boleh menggagalkan foto.
 *   · **Satu unduhan per model.** `ensure` memeriksa cache dulu; panggilan
 *     kedua tidak menyentuh jaringan.
 *   · Semua ketergantungan (`caches`, `fetch`) bisa disuntik, jadi perilakunya
 *     diuji tanpa browser.
 */

/** Subset `Cache` yang dipakai. */
export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

/** Subset `CacheStorage` yang dipakai. */
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  delete(name: string): Promise<boolean>;
  has(name: string): Promise<boolean>;
}

export interface ModelCacheOptions {
  /** Nama cache. Default `fb-models`. */
  cacheName?: string;
  /** Awalan URL model; default kosong (path relatif `/models/...`). */
  baseUrl?: string;
  /** `caches` global; `null`/`undefined` = cache tidak tersedia. */
  caches?: CacheStorageLike | null;
  /** `fetch`; bisa disuntik untuk tes. */
  fetch?: typeof fetch;
}

export interface ModelCache {
  /** Nama cache yang dipakai (untuk ditampilkan di panel debug). */
  readonly cacheName: string;
  /**
   * Pastikan model tersedia. Mengembalikan `Response` (dari cache atau
   * jaringan), atau `null` kalau tidak bisa didapat sama sekali.
   */
  ensure(name: string): Promise<Response | null>;
  /** Apakah model sudah ada di cache (tanpa menyentuh jaringan). */
  has(name: string): Promise<boolean>;
  /** Nama model yang sudah tersimpan di cache. */
  list(): Promise<string[]>;
  /** Kosongkan cache (mis. operator mau hemat ruang). */
  clear(): Promise<void>;
}

export const DEFAULT_CACHE_NAME = "fb-models";

/** URL absolut model dari nama relatif. */
export function modelUrl(baseUrl: string, name: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const clean = name.startsWith("/") ? name.slice(1) : name;
  return `${base}/models/${clean}`;
}

export function createModelCache(options: ModelCacheOptions = {}): ModelCache {
  const cacheName = options.cacheName ?? DEFAULT_CACHE_NAME;
  const baseUrl = options.baseUrl ?? "";
  const cachesApi = options.caches ?? null;
  const doFetch = options.fetch ?? globalThis.fetch;

  /** Buka cache; `null` kalau tidak tersedia. */
  async function openCache(): Promise<CacheLike | null> {
    if (cachesApi === null) return null;
    try {
      return await cachesApi.open(cacheName);
    } catch {
      return null;
    }
  }

  async function fetchModel(url: string): Promise<Response | null> {
    try {
      const response = await doFetch(url);
      return response.ok ? response : null;
    } catch {
      return null;
    }
  }

  return {
    cacheName,

    async ensure(name) {
      const url = modelUrl(baseUrl, name);
      const cache = await openCache();

      if (cache !== null) {
        try {
          const hit = await cache.match(url);
          if (hit !== undefined) return hit;
        } catch {
          // `match` gagal → anggap tidak ada, lanjut ke jaringan.
        }
      }

      const response = await fetchModel(url);
      if (response === null) return null;

      // Simpan best-effort. Kegagalan di sini **tidak** menggagalkan pemakaian
      // model — fotonya masih bisa diproses, cuma tidak offline.
      if (cache !== null) {
        try {
          // `put` mengonsumsi body; klon dulu supaya yang dikembalikan utuh.
          await cache.put(url, response.clone());
        } catch {
          // kuota penuh / cache read-only → lewati.
        }
      }

      return response;
    },

    async has(name) {
      const cache = await openCache();
      if (cache === null) return false;
      try {
        const hit = await cache.match(modelUrl(baseUrl, name));
        return hit !== undefined;
      } catch {
        return false;
      }
    },

    async list() {
      const cache = await openCache();
      if (cache === null) return [];
      try {
        const keys = await (cache as unknown as { keys?: () => Promise<{ url: string }[]> }).keys?.();
        if (keys === undefined) return [];
        // Kunci cache adalah URL **absolut** (mis.
        // `http://host:5173/studio/models/x.tflite`), sedangkan
        // `modelUrl(baseUrl,"")` relatif (`/studio/models/`). Cocokkan sebagai
        // **substring**: prefix diawali `/` jadi setiap kemunculannya sudah
        // sejajar batas segmen path. (Memakai `startsWith` biasa → daftar
        // selalu kosong karena URL absolut tidak pernah diawali prefix relatif.)
        const prefix = modelUrl(baseUrl, "");
        return keys
          .map((request) => request.url)
          .filter((url) => url.includes(prefix))
          .map((url) => url.slice(url.indexOf(prefix) + prefix.length));
      } catch {
        return [];
      }
    },

    async clear() {
      if (cachesApi === null) return;
      try {
        await cachesApi.delete(cacheName);
      } catch {
        // tidak ada yang bisa dilakukan; cache tetap seperti semula.
      }
    },
  };
}
