/**
 * Jalankan filter di Worker kalau bisa, kalau tidak ya di main thread.
 *
 * Sama seperti `template/renderOffThread.ts`: **jangan pernah menyerahkan hasil
 * tanpa memberi tahu jalur mana yang dipakai.** Karena itu hasilnya selalu
 * membawa `offThread`, dan panel debug menampilkannya — kalau kiosk mendadak
 * tersendat, kelihatan penyebabnya (OffscreenCanvas tidak ada, atau filternya
 * memang butuh model yang cuma hidup di main thread).
 *
 * Aturan pemilihan jalur, dan alasannya:
 *
 *   · **Tidak ada kerja** (`isIdentity`) → jangan sentuh worker sama sekali;
 *     bangun Worker hanya untuk mengembalikan blob yang sama itu pemborosan.
 *   · **Butuh segmenter / face enhance / latar AI** → main thread. MediaPipe
 *     dan GFPGAN adalah instance yang hidup di main thread; menyeberangkannya
 *     ke Worker berarti memuat ulang model di sana, dan itu justru menambah
 *     beban di momen yang salah.
 *   · **Sisanya** (rotasi, chroma key, latar warna/blur, adjustments) → Worker.
 *
 * Kegagalan Worker **tidak** menghilangkan foto: jalur sinkron dijalankan
 * sebagai ganti, lalu `onFallback` dipanggil supaya tidak ada perpindahan jalur
 * yang diam-diam.
 */

import { applyFilters, type FilterDeps, type FilterProviders, type FilterResult } from "./applyFilters.ts";
import { resolveFilterPlan } from "./pipeline.ts";
import type { FilterSettings } from "./types.ts";
import type { FilterWorkerRequest, FilterWorkerResponse } from "./worker/filter.worker.ts";

export interface OffThreadFilterResult extends FilterResult {
  /** `true` = dijalankan di Worker, `false` = main thread. */
  offThread: boolean;
}

export interface RunFiltersOptions {
  /** Dependensi main thread (fallback & tahap berprovider). */
  deps: FilterDeps;
  /** Provider; kalau ada, filternya otomatis jadi jalur main thread. */
  providers?: FilterProviders;
  /** `null` = paksa jalur sinkron. Default: Worker standar bila didukung. */
  createWorker?: (() => Worker | null) | undefined;
  /** Dipanggil sekali bila Worker gagal dan jalur sinkron dipakai. */
  onFallback?: (reason: string) => void;
}

interface PendingRun {
  resolve: (result: Omit<FilterResult, "plan">) => void;
  reject: (error: Error) => void;
}

/** Bungkus Worker jadi pemanggil promise dengan id pesan. */
export class WorkerFilter {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRun>();

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const data = event.data as FilterWorkerResponse;
      const entry = this.pending.get(data.id);
      if (entry === undefined) return;
      this.pending.delete(data.id);

      if (data.ok) {
        entry.resolve({
          blob: data.blob,
          width: data.width,
          height: data.height,
          processed: data.processed,
          degraded: data.degraded,
          applied: data.applied,
        });
      } else {
        entry.reject(new Error(data.error));
      }
    });

    this.worker.addEventListener("error", (event) => {
      const error = new Error(event.message === "" ? "worker filter gagal" : event.message);
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
  }

  run(blob: Blob, settings: FilterSettings): Promise<Omit<FilterResult, "plan">> {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: FilterWorkerRequest = { id, blob, settings };
      this.worker.postMessage(request);
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const entry of this.pending.values()) entry.reject(new Error("worker filter dibuang"));
    this.pending.clear();
  }
}

/** Buat Worker filter standar lewat Vite (URL relatif ke modul ini). */
export function createFilterWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./worker/filter.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

/** true kalau browser ini sanggup memproses filter off-thread. */
export function supportsFilterOffThread(): boolean {
  return typeof OffscreenCanvas !== "undefined" && typeof Worker !== "undefined";
}

/**
 * Boleh tidak pekerjaan ini dilempar ke Worker?
 *
 * Dipisah dari `runFilters` supaya panel debug dan tes bisa bertanya tanpa
 * benar-benar menjalankan apa pun.
 */
export function canRunOffThread(settings: FilterSettings): boolean {
  const plan = resolveFilterPlan(settings);
  if (plan.isIdentity) return false;
  if (plan.needsSegmenter || plan.needsFaceEnhance) return false;
  // Latar AI butuh gambar latar yang dimuat provider di main thread.
  if (settings.background.mode === "ai") return false;
  return true;
}

/**
 * Jalankan filter sekali: Worker kalau boleh & tersedia, kalau tidak sinkron.
 *
 * Selalu mengembalikan `FilterResult` (tidak pernah melempar) — foto tidak boleh
 * hilang gara-gara filter.
 */
export async function runFilters(
  blob: Blob,
  settings: FilterSettings,
  options: RunFiltersOptions,
): Promise<OffThreadFilterResult> {
  const workerFactory = options.createWorker ?? (supportsFilterOffThread() ? createFilterWorker : undefined);

  if (workerFactory !== undefined && canRunOffThread(settings)) {
    const worker = workerFactory();
    if (worker !== null) {
      const filter = new WorkerFilter(worker);
      try {
        const result = await filter.run(blob, settings);
        // `plan` dihitung di sini dari `settings` yang sama — bukan dikirim
        // pulang-pergi lewat pesan, karena ia murni dan murah.
        return { ...result, plan: resolveFilterPlan(settings), offThread: true };
      } catch (error) {
        options.onFallback?.(error instanceof Error ? error.message : String(error));
      } finally {
        filter.dispose();
      }
    }
  }

  const result = await applyFilters(blob, settings, options.deps, options.providers ?? {});
  return { ...result, offThread: false };
}
