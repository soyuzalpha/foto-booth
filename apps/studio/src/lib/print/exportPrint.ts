/**
 * Export lembar cetak: render lembar → Blob → unduh atau cetak.
 *
 * Kenapa terpisah dari `exportPng.ts` (yang meng-export *template*):
 *
 *   · `exportTemplate` menghasilkan **isi** (600×1800 px untuk strip 2×6).
 *   · `exportPrintSheet` menghasilkan **kertas**: ukuran preset (bisa 1200×1800
 *     untuk 4×6), template ditempelkan di dalamnya, plus bleed & tanda potong.
 *
 * Dua-duanya dipakai, dan memang harus: berkas `…-600x1800.png` enak dikirim
 * ke klien, sementara lembar 4×6 dengan tanda potong enak dicetak. Menyatukan
 * keduanya bikin salah satu selalu jadi kompromi.
 *
 * Seperti `exportPng.ts`, canvas disuntik lewat `createCanvas` supaya seluruh
 * jalur bisa diuji di Node tanpa DOM.
 */

import {
  isTemplateTooLarge,
  printPixelSize,
  slugify,
  type PrintPreset,
  type Template,
  type TokenValues,
} from "@foto-booth/shared";

import type { ExportCanvas, ExportDeps, ExportFormat } from "../template/exportPng.ts";
import { ExportError } from "../template/exportPng.ts";
import { renderPrintSheet, type PrintSheetPlan, type PrintSheetOptions } from "./printLayout.ts";

export interface PrintExportOptions extends PrintSheetOptions {
  format?: ExportFormat;
  /** 0–1; hanya dipakai untuk JPEG. */
  quality?: number;
  tokens?: TokenValues;
  /** Jam export — disuntik supaya nama berkas bisa diprediksi di tes. */
  now?: Date;
}

export interface ExportedSheet {
  blob: Blob;
  filename: string;
  /** Ukuran lembar, px @300 dpi. */
  width: number;
  height: number;
  format: ExportFormat;
  bytes: number;
  /** Rencana yang dipakai — dibawa keluar supaya bisa diverifikasi. */
  plan: PrintSheetPlan;
}

function mimeOf(format: ExportFormat): string {
  return format === "png" ? "image/png" : "image/jpeg";
}

async function sheetToBlob(
  canvas: ExportCanvas,
  format: ExportFormat,
  quality: number,
): Promise<Blob> {
  const type = mimeOf(format);

  const convertToBlob:
    | ((options?: { type?: string; quality?: number }) => Promise<Blob>)
    | undefined = canvas.convertToBlob;
  if (convertToBlob !== undefined) {
    // `.call(canvas, …)` penting: `convertToBlob` lepas dari `this` akan
    // melempar "Illegal invocation" di Chromium.
    return await convertToBlob.call(canvas, { type, quality });
  }

  const toBlob:
    | ((callback: (blob: Blob | null) => void, type?: string, quality?: number) => void)
    | undefined = canvas.toBlob;
  if (toBlob !== undefined) {
    return new Promise((resolve, reject) => {
      toBlob.call(
        canvas,
        (blob) =>
          blob === null
            ? reject(new ExportError("canvas.toBlob menghasilkan null"))
            : resolve(blob),
        type,
        quality,
      );
    });
  }

  throw new ExportError("canvas tidak mendukung convertToBlob() maupun toBlob()");
}

/**
 * Nama berkas lembar cetak.
 *
 * Ditandai `-cetak-<preset>` supaya tidak pernah tertukar dengan export
 * template: `pesta-2026-10-12-600x1800.png` (isi) vs
 * `pesta-2026-10-12-cetak-2x6-600x1800.png` (kertas).
 *
 * Tidak memakai `exportFilename` karena fungsi itu menaruh `<WxH>` di akhir;
 * di sini ukuran lembar ditulis setelah penanda cetak, supaya terlihat jelas
 * mana yang ukuran kertas dan mana yang ukuran isi.
 */
export function sheetFilename(
  template: Template,
  preset: PrintPreset,
  pixels: { width: number; height: number },
  format: ExportFormat,
  now: Date,
  options: { includeBleed?: boolean; tokens?: TokenValues } = {},
): string {
  const values = options.tokens ?? {};
  const bleed = options.includeBleed === true ? "-bleed" : "";
  const extension = format === "png" ? "png" : "jpg";

  const parts = [
    slugify(template.name) || "template",
    values.event !== undefined && values.event !== "" ? slugify(values.event) : "",
    now.toISOString().slice(0, 10),
    `cetak-${preset.id}${bleed}`,
    `${pixels.width}x${pixels.height}`,
  ].filter((part) => part !== "");

  return `${parts.join("-")}.${extension}`;
}

/**
 * Render lembar cetak pada resolusi penuh lalu jadikan Blob siap unduh/cetak.
 *
 * Selalu memakai ukuran preset (inci × dpi), bukan ukuran pratinjau — kalau
 * tidak, hasil cetaknya pecah dan tanda potongnya salah tempat.
 */
export async function exportPrintSheet(
  template: Template,
  preset: PrintPreset,
  deps: ExportDeps,
  options: PrintExportOptions = {},
): Promise<ExportedSheet> {
  if (isTemplateTooLarge(template.size)) {
    throw new ExportError(
      `Template terlalu besar untuk dirender (${template.size.width}×${template.size.height} in @ ${template.size.dpi} dpi).`,
    );
  }

  const includeBleed = options.includeBleed === true;
  const pixels = printPixelSize(preset, { includeBleed });
  const format = options.format ?? "png";
  const quality = options.quality ?? (format === "jpeg" ? 0.92 : 1);

  const canvas = deps.createCanvas(pixels.width, pixels.height);
  canvas.width = pixels.width;
  canvas.height = pixels.height;

  const context = canvas.getContext("2d");
  if (context === null || context === undefined) {
    throw new ExportError("tidak bisa mengambil context 2d dari canvas lembar cetak");
  }

  const result = renderPrintSheet(
    context as Parameters<typeof renderPrintSheet>[0],
    template,
    preset,
    {
      frames: options.frames,
      backgroundImage: options.backgroundImage,
      stickers: options.stickers,
      tokens: options.tokens,
      includeBleed,
      ...(options.paper !== undefined ? { paper: options.paper } : {}),
      ...(options.fit !== undefined ? { fit: options.fit } : {}),
    },
  );

  const blob = await sheetToBlob(canvas, format, quality);
  const filename = sheetFilename(
    template,
    preset,
    pixels,
    format,
    options.now ?? new Date(),
    { includeBleed, tokens: options.tokens ?? {} },
  );

  return {
    blob,
    filename,
    width: pixels.width,
    height: pixels.height,
    format,
    bytes: blob.size,
    plan: result,
  };
}
