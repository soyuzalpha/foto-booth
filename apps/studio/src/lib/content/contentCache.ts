/**
 * Cache konten offline (starters / frames / backgrounds / stickers).
 *
 * Kenapa tidak cukup service worker: SW hanya meng-cache **app shell** (JS/CSS/
 * HTML). Konten itu data dari API, dan URL-nya bisa berubah kapan saja tanpa
 * app shell ikut berubah — jadi SW tidak punya alasan untuk menyimpannya.
 * Fase 3 mensyaratkan: **setelah sync pertama, konten tetap tampil offline**.
 *
 * Dua lapis yang disimpan:
 *
 *   1. **Katalog** (JSON daftar item per kategori) — supaya daftar sticker/
 *      frame tetap tampil walau jaringan mati.
 *   2. **Biner aset** (blob gambar per URL) — supaya gambarnya benar-benar
 *      bisa digambar, bukan cuma namanya.
 *
 * Yang tidak ada di cache dan tidak bisa diunduh → item itu **dilewati**, bukan
 * bikin seluruh katalog gagal. Satu aset rusak tidak boleh mematikan katalog.
 */

import type { ContentItem, ContentKind } from "@foto-booth/shared";

import {
  openDatabase,
  promisify,
  STORE_CONTENT,
  STORE_CONTENT_ASSETS,
} from "../idb.ts";

/** Satu kategori katalog + kapan terakhir disinkronkan. */
export interface CachedCatalog {
  kind: ContentKind;
  items: ContentItem[];
  /** ISO timestamp — dipakai untuk menampilkan umur cache, bukan untuk TTL. */
  syncedAt: string;
}

export interface ContentCacheStore {
  putCatalog(catalog: CachedCatalog): Promise<void>;
  getCatalog(kind: ContentKind): Promise<CachedCatalog | null>;
  /** URL → blob. URL dipakai sebagai kunci karena itu identitas asetnya. */
  putAsset(url: string, blob: Blob): Promise<void>;
  getAsset(url: string): Promise<Blob | null>;
  /** Semua URL aset yang tersimpan — dipakai untuk menghitung & membersihkan. */
  assetUrls(): Promise<string[]>;
  clear(): Promise<void>;
}

export class MemoryContentCache implements ContentCacheStore {
  private readonly catalogs = new Map<ContentKind, CachedCatalog>();
  private readonly assets = new Map<string, Blob>();

  async putCatalog(catalog: CachedCatalog): Promise<void> {
    this.catalogs.set(catalog.kind, catalog);
  }

  async getCatalog(kind: ContentKind): Promise<CachedCatalog | null> {
    return this.catalogs.get(kind) ?? null;
  }

  async putAsset(url: string, blob: Blob): Promise<void> {
    this.assets.set(url, blob);
  }

  async getAsset(url: string): Promise<Blob | null> {
    return this.assets.get(url) ?? null;
  }

  async assetUrls(): Promise<string[]> {
    return [...this.assets.keys()];
  }

  async clear(): Promise<void> {
    this.catalogs.clear();
    this.assets.clear();
  }
}

export class IdbContentCache implements ContentCacheStore {
  private db: IDBDatabase | null = null;
  private readonly factory: IDBFactory;

  constructor(factory: IDBFactory) {
    this.factory = factory;
  }

  private async handle(): Promise<IDBDatabase> {
    if (this.db === null) this.db = await openDatabase(this.factory);
    return this.db;
  }

  private async catalogStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.handle();
    return db.transaction(STORE_CONTENT, mode).objectStore(STORE_CONTENT);
  }

  private async assetStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.handle();
    return db.transaction(STORE_CONTENT_ASSETS, mode).objectStore(STORE_CONTENT_ASSETS);
  }

  async putCatalog(catalog: CachedCatalog): Promise<void> {
    const store = await this.catalogStore("readwrite");
    await promisify(store.put(catalog));
  }

  async getCatalog(kind: ContentKind): Promise<CachedCatalog | null> {
    const store = await this.catalogStore("readonly");
    const raw = await promisify<CachedCatalog | undefined>(store.get(kind));
    return raw ?? null;
  }

  async putAsset(url: string, blob: Blob): Promise<void> {
    const store = await this.assetStore("readwrite");
    await promisify(store.put({ url, blob }));
  }

  async getAsset(url: string): Promise<Blob | null> {
    const store = await this.assetStore("readonly");
    const raw = await promisify<{ url: string; blob: Blob } | undefined>(store.get(url));
    return raw?.blob ?? null;
  }

  async assetUrls(): Promise<string[]> {
    const store = await this.assetStore("readonly");
    const keys = await promisify<IDBValidKey[]>(store.getAllKeys());
    return keys.map((key) => String(key));
  }

  async clear(): Promise<void> {
    const catalogs = await this.catalogStore("readwrite");
    await promisify(catalogs.clear());
    const assets = await this.assetStore("readwrite");
    await promisify(assets.clear());
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export function createContentCache(
  global: { indexedDB?: IDBFactory } = globalThis as { indexedDB?: IDBFactory },
): { cache: ContentCacheStore; kind: "indexeddb" | "memory" } {
  if (global.indexedDB !== undefined) {
    return { cache: new IdbContentCache(global.indexedDB), kind: "indexeddb" };
  }
  return { cache: new MemoryContentCache(), kind: "memory" };
}

/** Cara mengambil satu kategori katalog; injectable supaya bisa diuji. */
export type CatalogFetcher = (kind: ContentKind) => Promise<ContentItem[]>;

/** Cara mengambil biner satu aset; injectable supaya bisa diuji. */
export type AssetFetcher = (url: string) => Promise<Blob | null>;

export interface SyncResult {
  kind: ContentKind;
  /** Item katalog yang tersimpan. */
  items: number;
  /** Aset yang berhasil disimpan di putaran ini. */
  assets: number;
  /** Aset yang gagal diunduh — katalog tetap tersimpan. */
  failed: number;
  syncedAt: string;
}

/**
 * Sinkronkan satu kategori: katalog dulu, baru asetnya.
 *
 * Katalog disimpan **sebelum** aset diunduh supaya kalau jaringan mati di
 * tengah jalan, daftarnya tetap ada (walaupun sebagian gambarnya belum).
 * Aset yang gagal tidak menggagalkan sinkronisasi — dicatat sebagai `failed`.
 */
export async function syncContent(
  cache: ContentCacheStore,
  kind: ContentKind,
  fetchers: { catalog: CatalogFetcher; asset: AssetFetcher },
  now: Date = new Date(),
): Promise<SyncResult> {
  const items = await fetchers.catalog(kind);
  const syncedAt = now.toISOString();

  await cache.putCatalog({ kind, items, syncedAt });

  let assets = 0;
  let failed = 0;

  for (const item of items) {
    const blob = await fetchers.asset(item.url);
    if (blob === null) {
      failed += 1;
      continue;
    }
    await cache.putAsset(item.url, blob);
    assets += 1;
  }

  return { kind, items: items.length, assets, failed, syncedAt };
}

/** Katalog dari cache; `null` kalau kategori ini belum pernah disinkronkan. */
export async function loadCachedCatalog(
  cache: ContentCacheStore,
  kind: ContentKind,
): Promise<CachedCatalog | null> {
  return cache.getCatalog(kind);
}

/**
 * Object URL untuk aset yang tersimpan, atau `null` kalau tidak ada.
 *
 * Pemanggil **wajib** memanggil `release()` kalau URL-nya tidak dipakai lagi —
 * kalau tidak, tiap render meninggalkan blob hidup.
 */
export async function resolveCachedAsset(
  cache: ContentCacheStore,
  url: string,
  createObjectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): Promise<{ url: string; release: () => void } | null> {
  const blob = await cache.getAsset(url);
  if (blob === null) return null;

  const objectUrl = createObjectUrl(blob);
  return { url: objectUrl, release: () => URL.revokeObjectURL(objectUrl) };
}
