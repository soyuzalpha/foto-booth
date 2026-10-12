/**
 * Export template jadi berkas gambar.
 *
 * Dua hal yang dijaga di sini:
 *   · **Resolusi cetak.** Canvas selalu dirender pada ukuran piksel penuh
 *     (inci × dpi), bukan ukuran pratinjau — kalau tidak, hasil cetak pecah.
 *   · **Nama berkas rapi** dan tidak menimpa (kalau ada bentrok, ditambah
 *     urutan). Nama dibuat di `@foto-booth/shared` supaya API memakai aturan
 *     yang sama.
 *
 * Canvas-nya disuntik lewat `createCanvas` supaya fungsi ini bisa diuji di
 * Node dengan canvas palsu — tidak ada `document` di sini.
 */

import {
  exportFilename,
  isTemplateTooLarge,
  templatePixelSize,
  type Template,
  type TokenValues,
} from "@foto-booth/shared";

import type { FrameImage, RenderOptions } from "./render.ts";
import { renderTemplate } from "./render.ts";

export type ExportFormat = "png" | "jpeg";

export interface ExportOptions extends RenderOptions {
  format?: ExportFormat;
  /** 0–1; hanya dipakai untuk JPEG. */
  quality?: number;
  /** Nilai token buat nama berkas & teks. */
  tokens?: TokenValues;
  /** Jam export — disuntik supaya nama berkas bisa diprediksi di tes. */
  now?: Date;
}

export interface ExportedImage {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
  format: ExportFormat;
  /** Ukuran berkas, byte. */
  bytes: number;
}

/** Canvas minimal yang dibutuhkan proses export. */
export interface ExportCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): unknown;
  convertToBlob?(options?: { type?: string; quality?: number }): Promise<Blob>;
  toBlob?(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

export interface ExportDeps {
  createCanvas(width: number, height: number): ExportCanvas;
  /** Dipakai untuk memastikan berkas tidak menimpa yang sudah ada. */
  exists?(filename: string): Promise<boolean> | boolean;
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

function mimeOf(format: ExportFormat): string {
  return format === "png" ? "image/png" : "image/jpeg";
}

/** Ubah canvas jadi Blob; mendukung `convertToBlob` (Offscreen) & `toBlob`. */
async function canvasToBlob(
  canvas: ExportCanvas,
  format: ExportFormat,
  quality: number,
): Promise<Blob> {
  const type = mimeOf(format);

  const convertToBlob: ((options?: { type?: string; quality?: number }) => Promise<Blob>) | undefined =
    canvas.convertToBlob;
  if (convertToBlob !== undefined) {
    return await convertToBlob.call(canvas, { type, quality });
  }

  const toBlob: ((callback: (blob: Blob | null) => void, type?: string, quality?: number) => void) | undefined =
    canvas.toBlob;
  if (toBlob !== undefined) {
    return new Promise((resolve, reject) => {
      toBlob.call(
        canvas,
        (blob) => (blob === null ? reject(new ExportError("canvas.toBlob menghasilkan null")) : resolve(blob)),
        type,
        quality,
      );
    });
  }

  throw new ExportError("canvas tidak mendukung convertToBlob() maupun toBlob()");
}

/** `name.png` → `name-2.png` kalau sudah ada. */
async function uniqueFilename(
  filename: string,
  exists: ExportDeps["exists"],
): Promise<string> {
  if (exists === undefined) return filename;

  const dot = filename.lastIndexOf(".");
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const extension = dot === -1 ? "" : filename.slice(dot);

  let candidate = filename;
  let counter = 2;
  while (await exists(candidate)) {
    candidate = `${stem}-${counter}${extension}`;
    counter += 1;
    if (counter > 999) throw new ExportError(`tidak bisa mencari nama unik untuk ${filename}`);
  }
  return candidate;
}

/**
 * Render template pada resolusi penuh lalu jadikan Blob siap unduh.
 *
 * `renderTemplate` dipanggil dengan canvas ukuran cetak — jadi apa pun yang
 * terlihat di pratinjau editor, hasilnya identik secara tata letak.
 */
export async function exportTemplate(
  template: Template,
  deps: ExportDeps,
  options: ExportOptions = {},
): Promise<ExportedImage> {
  if (isTemplateTooLarge(template.size)) {
    throw new ExportError(
      `Template terlalu besar untuk dirender (${template.size.width}×${template.size.height} in @ ${template.size.dpi} dpi).`,
    );
  }

  const pixels = templatePixelSize(template.size);
  const format = options.format ?? "png";
  const quality = options.quality ?? (format === "jpeg" ? 0.92 : 1);

  const canvas = deps.createCanvas(pixels.width, pixels.height);
  canvas.width = pixels.width;
  canvas.height = pixels.height;

  const context = canvas.getContext("2d");
  if (context === null || context === undefined) {
    throw new ExportError("tidak bisa mengambil context 2d dari canvas export");
  }

  const frames: readonly (FrameImage | null | undefined)[] = options.frames ?? [];
  const stats = renderTemplate(
    context as Parameters<typeof renderTemplate>[0],
    template,
    { ...options, frames },
  );

  const blob = await canvasToBlob(canvas, format, quality);

  const baseName = exportFilename(
    template.name,
    options.tokens ?? {},
    pixels,
    format,
    options.now ?? new Date(),
  );
  const filename = await uniqueFilename(baseName, deps.exists);

  return {
    blob,
    filename,
    width: stats.width,
    height: stats.height,
    format,
    bytes: blob.size,
  };
}

/** Versi browser: pakai `document.createElement("canvas")`. */
export function browserExportDeps(
  doc: Document = document,
  exists?: ExportDeps["exists"],
): ExportDeps {
  return {
    createCanvas(width, height) {
      const canvas = doc.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    ...(exists !== undefined ? { exists } : {}),
  };
}

/** Picu unduhan berkas di browser. */
export function downloadBlob(blob: Blob, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Cabut URL setelah unduhan mulai, biar tidak bocor memori.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
