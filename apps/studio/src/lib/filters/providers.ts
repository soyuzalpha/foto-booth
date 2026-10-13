/**
 * Perakitan provider filter untuk browser — tipis, tanpa aturan.
 *
 * `applyFilters.ts` hanya tahu **antarmuka** provider (segmenter, latar AI,
 * penghalus wajah); file ini yang menyambungkannya ke implementasi nyata:
 * MediaPipe untuk mask subjek, gambar untuk latar pengganti, GFPGAN untuk
 * wajah. Aturan *kapan* provider dipakai tetap di `pipeline.ts` — di sini tidak
 * ada keputusan, cuma pemasangan.
 *
 * Semua provider sengaja **opsional dan tahan gagal**: kalau model tidak ada,
 * browser tidak mendukung, atau cache kosong, yang terjadi hanyalah efek itu
 * dilewati (foto tetap keluar). Itu sebabnya perakitan ini tidak pernah
 * melempar.
 */

import { createFaceEnhancer, type FaceEnhancerHandle } from "./faceEnhance.ts";
import { createSegmenterProvider, type SegmenterHandle } from "./segmenter.ts";
import type { FilterSource, FilterProviders, VirtualBackgroundProvider } from "./applyFilters.ts";
import { createModelCache, type ModelCache, type CacheStorageLike } from "../models/modelCache.ts";

export interface BrowserProviderOptions {
  /** Sumber gambar latar (mode `ai`). `null` = mode AI tidak tersedia. */
  backgroundUrl?: string | null;
  /** `caches` global; `null` = model AI besar tidak bisa di-cache. */
  caches?: CacheStorageLike | null;
  /** Awalan URL model; default kosong (`/models/...`). */
  modelsBaseUrl?: string;
  /** `fetch` yang dipakai cache; bisa disuntik di tes. */
  fetch?: typeof fetch;
  /** Decoder gambar latar; default `createImageBitmap`. */
  decodeImage?: (blob: Blob) => Promise<FilterSource>;
}

export interface BrowserProviders {
  providers: FilterProviders;
  /** Buang sumber daya (instance model, sesi ONNX). Aman berkali-kali. */
  dispose(): void;
  /** Model besar sudah tersedia offline (dipakai panel debug). */
  modelCache: ModelCache;
}

/** Latar AI dari satu URL gambar. Gagal = `null`; pipeline mundur ke warna. */
function createImageBackgroundProvider(
  url: string,
  decode: (blob: Blob) => Promise<FilterSource>,
  doFetch: typeof fetch,
): VirtualBackgroundProvider {
  let cached: FilterSource | null = null;

  return {
    async load(): Promise<FilterSource | null> {
      if (cached !== null) return cached;
      try {
        const response = await doFetch(url);
        if (!response.ok) return null;
        const blob = await response.blob();
        cached = await decode(blob);
        return cached;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Rakit provider browser.
 *
 * `backgroundUrl` sengaja eksplisit: tanpa gambar latar, mode `ai` tidak punya
 * apa pun untuk digambar, dan lebih baik pipeline mundur ke warna daripada
 * menampilkan latar hitam tak sengaja.
 */
export function createBrowserProviders(options: BrowserProviderOptions = {}): BrowserProviders {
  const cachesApi = options.caches ?? null;
  const doFetch = options.fetch ?? globalThis.fetch;
  const decodeImage =
    options.decodeImage ??
    (async (blob: Blob): Promise<FilterSource> => {
      const bitmap = await createImageBitmap(blob);
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    });

  const modelCache = createModelCache({
    ...(options.modelsBaseUrl === undefined ? {} : { baseUrl: options.modelsBaseUrl }),
    caches: cachesApi,
    ...(options.fetch === undefined ? {} : { fetch: doFetch }),
  });

  const segmenter: SegmenterHandle = createSegmenterProvider();
  const faceEnhancer: FaceEnhancerHandle = createFaceEnhancer({ cache: modelCache });

  const providers: FilterProviders = { segmenter, faceEnhancer };

  const url = options.backgroundUrl ?? null;
  if (url !== null && url !== "") {
    providers.background = createImageBackgroundProvider(url, decodeImage, doFetch);
  }

  return {
    providers,
    modelCache,
    dispose() {
      segmenter.dispose();
      faceEnhancer.dispose();
    },
  };
}
