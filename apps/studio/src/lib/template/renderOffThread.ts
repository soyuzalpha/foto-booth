/**
 * Render strip di luar main thread kalau bisa, kalau tidak ya sinkron.
 *
 * Aturannya: **jangan pernah menyerahkan hasil ke pemanggil tanpa tahu jalur
 * mana yang dipakai.** Jadi fungsi ini selalu mengembalikan `offThread`, dan
 * UI menampilkan jalur itu di panel diagnostik — biar kalau kiosk tiba-tiba
 * lambat, kelihatan penyebabnya (OffscreenCanvas tidak tersedia, misalnya di
 * WebView lama).
 *
 * Worker dibuat sekali dan dipakai ulang; membuat Worker per export bikin
 * jank justru di saat yang paling tidak diinginkan.
 */

import { exportFilename, templatePixelSize, type Template } from "@foto-booth/shared";

import {
  browserExportDeps,
  exportTemplate,
  type ExportCanvas,
  type ExportDeps,
  type ExportedImage,
  type ExportFormat,
} from "./exportPng.ts";
import type { FrameImage, RenderOptions } from "./render.ts";
import { renderTemplate } from "./render.ts";

export interface OffThreadDeps extends ExportDeps {
  /** `null` = paksa jalur sinkron. */
  createWorker?: (() => Worker | null) | undefined;
  createOffscreen?: ((width: number, height: number) => ExportCanvas) | undefined;
}

export interface RenderResult extends ExportedImage {
  /** `true` = dirender di Worker, `false` = main thread. */
  offThread: boolean;
}

interface PendingRequest {
  resolve: (response: { blob: Blob; width: number; height: number }) => void;
  reject: (error: Error) => void;
}

/** Bungkus Worker jadi pemanggil promise dengan id pesan. */
export class WorkerRenderer {
  private worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const data = event.data as
        | { id: number; ok: true; blob: Blob; width: number; height: number }
        | { id: number; ok: false; error: string };
      const entry = this.pending.get(data.id);
      if (entry === undefined) return;
      this.pending.delete(data.id);

      if (data.ok) {
        entry.resolve({ blob: data.blob, width: data.width, height: data.height });
      } else {
        entry.reject(new Error(data.error));
      }
    });

    this.worker.addEventListener("error", (event) => {
      const error = new Error(event.message === "" ? "worker render gagal" : event.message);
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
  }

  render(request: {
    template: Template;
    frames: (ImageBitmap | null)[];
    backgroundImage?: ImageBitmap | null;
    stickers?: Record<string, ImageBitmap>;
    tokens?: Record<string, string>;
    format: ExportFormat;
    quality: number;
    width: number;
    height: number;
  }): Promise<{ blob: Blob; width: number; height: number }> {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const transfer: Transferable[] = [
        ...request.frames.filter((bitmap): bitmap is ImageBitmap => bitmap !== null),
        ...(request.backgroundImage != null ? [request.backgroundImage] : []),
        ...Object.values(request.stickers ?? {}),
      ];
      this.worker.postMessage({ ...request, id }, transfer);
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const entry of this.pending.values()) entry.reject(new Error("renderer dibuang"));
    this.pending.clear();
  }
}

/** Buat Worker render standar lewat Vite (URL relatif ke modul ini). */
export function createRenderWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./worker/render.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

/** true kalau browser ini sanggup render off-thread. */
export function supportsOffThread(): boolean {
  return typeof OffscreenCanvas !== "undefined" && typeof Worker !== "undefined";
}

/**
 * Versi browser lengkap: jalur worker **dan** jalur sinkron.
 *
 * `browserExportDeps()` saja tidak cukup — tanpa `createOffscreen`, render
 * selalu jatuh ke main thread dan kiosk berhenti sekejap di momen paling
 * ramai. Di sini keduanya disediakan, jadi yang dipakai memang jalur tercepat
 * yang tersedia.
 */
export function browserOffThreadDeps(doc: Document = document): OffThreadDeps {
  return {
    ...browserExportDeps(doc),
    createOffscreen:
      typeof OffscreenCanvas !== "undefined"
        ? (width: number, height: number) => new OffscreenCanvas(width, height) as unknown as ExportCanvas
        : undefined,
  };
}

/**
 * Jalur sinkron: pakai `exportTemplate` yang sudah ada. Dipakai sebagai
 * fallback dan sebagai pembanding di tes — hasilnya harus sama.
 */
async function renderSync(
  template: Template,
  deps: ExportDeps,
  options: RenderOptions & { format: ExportFormat; quality: number; tokens?: Record<string, string> },
): Promise<ExportedImage> {
  return exportTemplate(template, deps, options);
}

/**
 * Render template, utamakan off-thread.
 *
 * Kalau Worker gagal (bukan cuma tidak ada), kita **tidak** diam-diam pindah
 * jalur tanpa jejak: error worker dilaporkan lewat `onFallback`, lalu render
 * diulang di main thread supaya tamu tidak pernah lihat layar kosong.
 */
export async function renderStrip(
  template: Template,
  deps: OffThreadDeps,
  options: RenderOptions & {
    format?: ExportFormat;
    quality?: number;
    tokens?: Record<string, string>;
    now?: Date;
    onFallback?: (reason: string) => void;
  } = {},
): Promise<RenderResult> {
  const format = options.format ?? "png";
  const quality = options.quality ?? (format === "jpeg" ? 0.92 : 1);

  const offscreen = deps.createOffscreen;
  const workerFactory = deps.createWorker ?? (supportsOffThread() ? createRenderWorker : undefined);

  if (offscreen !== undefined && workerFactory !== undefined) {
    const worker = workerFactory();
    if (worker !== null) {
      const renderer = new WorkerRenderer(worker);
      try {
        const pixels = templatePixelSize(template.size);
        const result = await renderer.render({
          template,
          frames: options.frames?.map((frame) => frame?.image as ImageBitmap | null) ?? [],
          backgroundImage: (options.backgroundImage?.image as ImageBitmap | undefined) ?? null,
          stickers: Object.fromEntries(
            Object.entries(options.stickers ?? {}).map(([id, frame]) => [id, frame.image as ImageBitmap]),
          ),
          tokens: options.tokens,
          format,
          quality,
          width: pixels.width,
          height: pixels.height,
        });

        return {
          blob: result.blob,
          filename: exportFilename(
            template.name,
            options.tokens ?? {},
            { width: result.width, height: result.height },
            format,
            options.now ?? new Date(),
          ),
          width: result.width,
          height: result.height,
          format,
          bytes: result.blob.size,
          offThread: true,
        };
      } catch (error) {
        options.onFallback?.(error instanceof Error ? error.message : String(error));
      } finally {
        renderer.dispose();
      }
    }
  }

  const result = await renderSync(template, deps, {
    ...options,
    format,
    quality,
    tokens: options.tokens,
  });

  return { ...result, offThread: false };
}

/**
 * Render ke canvas yang sudah ada (dipakai pratinjau & tes bitmap).
 * Ini jalur yang sama dengan export, cuma tanpa langkah `toBlob`.
 */
export function renderToCanvas(
  context: Parameters<typeof renderTemplate>[0],
  template: Template,
  options: RenderOptions = {},
): ReturnType<typeof renderTemplate> {
  return renderTemplate(context, template, options);
}

export type { ExportCanvas, FrameImage };
