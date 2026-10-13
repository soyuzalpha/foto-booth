/**
 * Worker filter — biar kiosk tidak nge-freeze waktu mengolah foto besar.
 *
 * Chroma key + adjustments di foto 12 MP memakan ratusan milidetik. Kalau itu
 * jalan di main thread, animasi pratinjau dan tombol berhenti merespons tepat
 * di momen paling ramai (tamu sedang menunggu hasil). Worker ini memindahkan
 * tahap **tanpa provider** (rotasi, chroma key, latar warna/blur, adjustments)
 * ke thread lain.
 *
 * Yang **tidak** lewat sini: segmenter (MediaPipe) dan face enhance (GFPGAN).
 * Model-model itu hidup di main thread dan tidak bisa menyeberang begitu saja —
 * `filterOffThread.ts` yang memutuskan, bukan worker ini.
 *
 * Pesan masuk: { id, blob, settings }
 * Pesan keluar: { id, ok: true, blob, width, height, processed, degraded, applied }
 *               | { id, ok: false, error }
 */

/// <reference lib="webworker" />

import { applyFilters, offscreenFilterDeps } from "../applyFilters.ts";
import type { FilterSettings } from "../types.ts";

export interface FilterWorkerRequest {
  id: number;
  blob: Blob;
  settings: FilterSettings;
}

export type FilterWorkerResponse =
  | {
      id: number;
      ok: true;
      blob: Blob;
      width: number;
      height: number;
      processed: boolean;
      degraded: boolean;
      applied: string[];
    }
  | { id: number; ok: false; error: string };

async function handle(request: FilterWorkerRequest): Promise<FilterWorkerResponse> {
  try {
    const result = await applyFilters(request.blob, request.settings, offscreenFilterDeps());
    return {
      id: request.id,
      ok: true,
      blob: result.blob,
      width: result.width,
      height: result.height,
      processed: result.processed,
      degraded: result.degraded,
      applied: result.applied,
    };
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Hanya pasang listener kalau benar-benar jalan sebagai worker.
if (typeof self !== "undefined" && typeof (self as unknown as Worker).postMessage === "function") {
  self.addEventListener("message", (event: MessageEvent<FilterWorkerRequest>) => {
    void handle(event.data).then((response) => {
      (self as unknown as Worker).postMessage(response);
    });
  });
}
