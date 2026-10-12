/**
 * Worker render — biar UI tidak nge-freeze waktu export resolusi cetak.
 *
 * Export 600×1800 px masih santai di main thread, tapi 1200×1800 @ 300 dpi
 * (6×8 in) dengan 6 foto sudah cukup berat untuk bikin animasi pratinjau
 * tersendat. Worker ini **opsional**: kalau `OffscreenCanvas` atau Worker tidak
 * ada, pemanggil jatuh ke jalur sinkron (lihat `renderOffThread.ts`).
 *
 * Pesan masuk: { id, template, images, backgroundImage, stickers, tokens }
 * Pesan keluar: { id, ok: true, blob, width, height, stats } | { id, ok: false, error }
 */

/// <reference lib="webworker" />

import { renderTemplate, type FrameImage, type RenderStats } from "../render.ts";

export interface RenderRequest {
  id: number;
  template: unknown;
  /** Bitmap per slot; dikirim sebagai `ImageBitmap` supaya bisa di-transfer. */
  frames: (ImageBitmap | null)[];
  backgroundImage?: ImageBitmap | null;
  stickers?: Record<string, ImageBitmap>;
  tokens?: Record<string, string>;
  format?: "png" | "jpeg";
  quality?: number;
  width: number;
  height: number;
}

export type RenderResponse =
  | { id: number; ok: true; blob: Blob; width: number; height: number; stats: RenderStats }
  | { id: number; ok: false; error: string };

function toFrameImage(bitmap: ImageBitmap | null | undefined): FrameImage | null {
  if (bitmap === null || bitmap === undefined) return null;
  return { image: bitmap, width: bitmap.width, height: bitmap.height };
}

async function handle(request: RenderRequest): Promise<RenderResponse> {
  try {
    const canvas = new OffscreenCanvas(request.width, request.height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("OffscreenCanvas tidak punya context 2d");

    // Template sudah divalidasi di main thread sebelum dikirim.
    const { normalizeTemplate } = await import("../model.ts");
    const template = normalizeTemplate(request.template);

    const stats = renderTemplate(context as unknown as Parameters<typeof renderTemplate>[0], template, {
      frames: request.frames.map(toFrameImage),
      backgroundImage: toFrameImage(request.backgroundImage),
      stickers: Object.fromEntries(
        Object.entries(request.stickers ?? {}).map(([id, bitmap]) => [id, toFrameImage(bitmap)]),
      ) as Record<string, FrameImage>,
      tokens: request.tokens,
    });

    const blob = await canvas.convertToBlob({
      type: request.format === "jpeg" ? "image/jpeg" : "image/png",
      quality: request.quality ?? 1,
    });

    return { id: request.id, ok: true, blob, width: stats.width, height: stats.height, stats };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Hanya pasang listener kalau benar-benar jalan sebagai worker.
if (typeof self !== "undefined" && typeof (self as unknown as Worker).postMessage === "function") {
  self.addEventListener("message", (event: MessageEvent<RenderRequest>) => {
    void handle(event.data).then((response) => {
      (self as unknown as Worker).postMessage(response);
    });
  });
}
