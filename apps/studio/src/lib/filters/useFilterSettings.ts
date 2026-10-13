/**
 * Jembatan React ↔ pipeline filter.
 *
 * Tiga hal yang disatukan di sini, dan hanya di sini:
 *
 *   1. **Pengaturan** (rotasi, chroma key, koreksi warna, latar) — dibaca dari
 *      localStorage sekali, disimpan tiap berubah. Sama polanya dengan
 *      `useCaptureSession`, supaya operator tidak menyetel ulang tiap sesi.
 *   2. **Provider** (segmenter, latar AI, penghalus wajah) — dirakit sekali dan
 *      dibuang saat unmount. Merakitnya per foto akan memuat ulang model tiap
 *      jepretan.
 *   3. **Fungsi `process`** yang dipakai `framesToIntake`: `Blob → Blob`.
 *
 * Semua keputusan "tahap apa, urutan apa" tetap di `pipeline.ts`. Hook ini
 * tidak menambah aturan — kalau ia mulai menambah, itu tanda aturannya salah
 * tempat.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { browserFilterDeps, type FilterResult } from "./applyFilters.ts";
import { runFilters } from "./filterOffThread.ts";
import { normalizeFilterSettings, readFilterSettings, writeFilterSettings } from "./filterSettingsStore.ts";
import { createBrowserProviders } from "./providers.ts";
import type { FilterSettings } from "./types.ts";
import { deviceStorage } from "../capture/rememberedDevice.ts";
import type { ProcessedFrame } from "../upload/composedToIntake.ts";

export interface FilterSettingsHandle {
  settings: FilterSettings;
  /** Ubah sebagian pengaturan; sisanya tetap. */
  update(patch: Partial<FilterSettings>): void;
  /** Kembalikan ke default (tanpa filter). */
  reset(): void;
  /**
   * Jalankan filter pada satu blob. `null` = tidak ada yang berubah, pakai blob
   * asli. **Tidak pernah melempar.**
   */
  process(blob: Blob): Promise<ProcessedFrame | null>;
  /** Hasil terakhir — untuk panel debug. */
  lastResult: FilterResult | null;
  /** Ringkasan terakhir yang bisa dibaca operator. */
  lastSummary: string | null;
  /** Jalur terakhir: `true` = Worker, `false` = main thread. */
  lastOffThread: boolean;
}

export interface UseFilterSettingsOptions {
  /** URL gambar latar untuk mode `ai`. `null` = tidak tersedia. */
  backgroundUrl?: string | null;
}

export function useFilterSettings(options: UseFilterSettingsOptions = {}): FilterSettingsHandle {
  const [settings, setSettings] = useState<FilterSettings>(() =>
    readFilterSettings(typeof localStorage === "undefined" ? null : deviceStorage()),
  );
  const [lastResult, setLastResult] = useState<FilterResult | null>(null);
  const [lastOffThread, setLastOffThread] = useState(false);

  // Provider dirakit sekali. `dispose` dijalankan saat unmount supaya instance
  // MediaPipe/ONNX tidak menggantung.
  const bundle = useMemo(
    () => createBrowserProviders({ backgroundUrl: options.backgroundUrl ?? null }),
    [options.backgroundUrl],
  );
  useEffect(() => () => bundle.dispose(), [bundle]);

  // Simpan tiap berubah; gagal simpan bukan alasan menghentikan alur.
  useEffect(() => {
    writeFilterSettings(typeof localStorage === "undefined" ? null : deviceStorage(), settings);
  }, [settings]);

  const update = useCallback((patch: Partial<FilterSettings>): void => {
    // Lewat normalisasi supaya nilai dari UI pun dijepit — bukan hanya yang
    // datang dari penyimpanan.
    setSettings((current) => normalizeFilterSettings({ ...current, ...patch }));
  }, []);

  const reset = useCallback((): void => {
    setSettings(normalizeFilterSettings(null));
  }, []);

  const process = useCallback(
    async (blob: Blob): Promise<ProcessedFrame | null> => {
      try {
        const result = await runFilters(blob, settings, {
          deps: browserFilterDeps(),
          providers: bundle.providers,
        });
        setLastResult(result);
        setLastOffThread(result.offThread);
        return result.processed
          ? { blob: result.blob, width: result.width, height: result.height }
          : null;
      } catch {
        // `runFilters`/`applyFilters` sudah menelan kegagalan internalnya; ini
        // jaring terakhir supaya satu bug tidak menghilangkan foto dari antrian.
        return null;
      }
    },
    [settings, bundle],
  );

  const lastSummary = lastResult === null ? null : describeShort(lastResult);

  return { settings, update, reset, process, lastResult, lastSummary, lastOffThread };
}

/** Ringkasan singkat untuk panel debug — sengaja bukan impor `describeResult`. */
function describeShort(result: FilterResult): string {
  const head = result.processed ? "diproses" : "apa adanya";
  const stages = result.applied.length > 0 ? result.applied.join(" + ") : "tanpa filter";
  return result.degraded ? `${head}: ${stages} · sebagian dilewati` : `${head}: ${stages}`;
}

/** Dipakai UI untuk menampilkan jumlah tahap aktif tanpa membangun pipeline. */
export function activeStageCount(settings: FilterSettings): number {
  let count = 0;
  if (settings.rotation !== 0) count += 1;
  if (settings.chromaKey.enabled) count += 1;
  if (settings.background.mode !== "none") count += 1;
  if (
    settings.adjustments.brightness !== 0 ||
    settings.adjustments.contrast !== 0 ||
    settings.adjustments.saturation !== 0
  ) {
    count += 1;
  }
  if (settings.faceEnhance) count += 1;
  return count;
}
