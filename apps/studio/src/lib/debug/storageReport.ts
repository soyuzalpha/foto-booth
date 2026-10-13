/**
 * Pengumpul laporan storage untuk mode debug — tipis, bisa disuntik.
 *
 * `debugMode.ts` memutuskan **apa artinya** laporan itu (baris mana, kapan
 * memperingatkan); file ini cuma mengambil angkanya dari browser. Pemisahan itu
 * disengaja: pembacaan `navigator.storage` gampang berubah antar-browser dan
 * tidak ingin ikut mengotori aturan ambang batas.
 *
 * Semua sumber bisa disuntik, jadi perilakunya diuji tanpa browser — termasuk
 * kasus yang paling sering bikin panel debug rusak: API tidak ada (`undefined`)
 * atau melempar.
 */

import type { StorageReport } from "./debugMode.ts";
import { DEFAULT_FACE_MODEL } from "../filters/faceEnhance.ts";

/** Subset `StorageManager` yang dipakai. */
export interface StorageManagerLike {
  persisted?(): Promise<boolean>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
}

export interface ReportSources {
  /** `navigator.storage`; `undefined` = API tidak ada. */
  storage?: StorageManagerLike | undefined;
  /** `caches`; `null`/`undefined` = Cache Storage tidak ada. */
  caches?: { keys?(): Promise<string[]> } | null | undefined;
  /** Service worker sedang mengendalikan halaman ini. */
  serviceWorkerActive?: boolean;
  /** Cache model; `null` = tidak dipakai (model besar tak tersedia). */
  modelCache?: { has(name: string): Promise<boolean> } | null | undefined;
  /** Nama model yang dianggap "siap offline". Default: model wajah GFPGAN. */
  modelNames?: readonly string[];
}

const DEFAULT_MODEL_NAMES: readonly string[] = [DEFAULT_FACE_MODEL];

async function safe<T>(run: () => Promise<T> | undefined, fallback: T): Promise<T> {
  try {
    const result = await run();
    return result === undefined ? fallback : result;
  } catch {
    return fallback;
  }
}

/**
 * Ambil laporan storage. **Tidak pernah melempar** — panel debug yang rusak
 * lebih buruk daripada panel debug yang bilang "tidak diketahui".
 */
export async function collectStorageReport(sources: ReportSources = {}): Promise<StorageReport> {
  const storage = sources.storage;

  const persisted =
    storage?.persisted === undefined
      ? null
      : await safe(async () => await storage.persisted!(), null);

  const estimate =
    storage?.estimate === undefined
      ? null
      : await safe(async () => await storage.estimate!(), null);

  const cacheNames =
    sources.caches?.keys === undefined
      ? []
      : await safe(async () => await sources.caches!.keys!(), []);

  const names = sources.modelNames ?? DEFAULT_MODEL_NAMES;
  const modelCache = sources.modelCache ?? null;
  let modelCacheReady = false;
  if (modelCache !== null && names.length > 0) {
    // Cukup satu model besar tersimpan → kiosk sudah bisa jalan offline untuk
    // fitur itu. `has` sendiri sudah tahan gagal (lihat `modelCache.ts`).
    for (const name of names) {
      const cached = await safe(async () => await modelCache.has(name), false);
      if (cached) {
        modelCacheReady = true;
        break;
      }
    }
  }

  return {
    persisted,
    usageBytes: estimate?.usage ?? null,
    quotaBytes: estimate?.quota ?? null,
    cacheNames: [...cacheNames].sort(),
    serviceWorkerActive: sources.serviceWorkerActive === true,
    modelCacheReady,
  };
}

/** Sumber nyata dari global browser. */
export function browserReportSources(
  modelCache: { has(name: string): Promise<boolean> } | null,
  serviceWorkerActive: boolean,
): ReportSources {
  return {
    storage: typeof navigator === "undefined" ? undefined : navigator.storage,
    caches: typeof caches === "undefined" ? null : caches,
    serviceWorkerActive,
    modelCache,
  };
}
