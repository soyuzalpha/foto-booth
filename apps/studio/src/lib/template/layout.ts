/**
 * Geometri template — murni angka, tanpa DOM.
 *
 * Semua fungsi di sini bisa diuji di Node tanpa canvas. Yang butuh DOM
 * (`drawImage`, `fillText`) ada di `render.ts`.
 */

import type { PixelSize } from "@foto-booth/shared";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StripLayoutOptions {
  /** Jarak tepi canvas, px. */
  margin: number;
  /** Jarak antar frame, px. */
  gap: number;
  /** Tinggi area footer buat teks, px. 0 = tidak ada footer. */
  footerHeight: number;
}

export const DEFAULT_STRIP_LAYOUT: StripLayoutOptions = {
  margin: 36,
  gap: 18,
  footerHeight: 150,
};

/**
 * Susun `count` frame jadi satu kolom (strip vertikal).
 *
 * Tinggi tiap frame dihitung dari sisa ruang lalu dibulatkan ke bawah, dan
 * frame terakhir menyerap sisa piksel — supaya tidak ada celah aneh di dasar
 * strip kalau tingginya tidak habis dibagi.
 */
export function stripLayout(
  pixels: PixelSize,
  count: number,
  options: Partial<StripLayoutOptions> = {},
): Box[] {
  const { margin, gap, footerHeight } = { ...DEFAULT_STRIP_LAYOUT, ...options };

  if (count <= 0) return [];

  const width = pixels.width - margin * 2;
  const available = pixels.height - margin * 2 - footerHeight - gap * (count - 1);
  const height = Math.floor(available / count);

  if (width <= 0 || height <= 0) return [];

  const boxes: Box[] = [];
  for (let index = 0; index < count; index += 1) {
    const isLast = index === count - 1;
    boxes.push({
      x: margin,
      y: margin + index * (height + gap),
      width,
      // Frame terakhir menyerap sisa pembulatan.
      height: isLast ? available - height * (count - 1) : height,
    });
  }

  return boxes;
}

/** Area footer di bawah frame terakhir. */
export function footerBox(
  pixels: PixelSize,
  count: number,
  options: Partial<StripLayoutOptions> = {},
): Box {
  const { margin, gap } = { ...DEFAULT_STRIP_LAYOUT, ...options };
  const frames = stripLayout(pixels, count, options);
  const last = frames.at(-1);
  const top = last === undefined ? margin : last.y + last.height + gap;

  return {
    x: margin,
    y: top,
    width: pixels.width - margin * 2,
    height: Math.max(0, pixels.height - margin - top),
  };
}

/* ------------------------------------------------------------------ *
 * Pencocokan gambar ke kotak
 * ------------------------------------------------------------------ */

/** "4:5" → 0.8. Kosong / tidak valid → null (berarti: ikut kotak). */
export function parseRatio(ratio: string | undefined): number | null {
  if (ratio === undefined || ratio.trim() === "") return null;
  const parts = ratio.split(":");
  if (parts.length !== 2) return null;
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
}

export interface CoverCrop {
  /** Kotak sumber di gambar asli. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Hitung crop "cover": gambar mengisi seluruh kotak tanpa distorsi, sisa
 * dipotong di tengah. Ini yang dipakai foto booth — tidak ada bar hitam.
 */
export function coverCrop(
  imageWidth: number,
  imageHeight: number,
  box: Box,
  ratio: string | undefined,
): CoverCrop {
  const target = parseRatio(ratio) ?? box.width / box.height;
  const imageRatio = imageWidth / imageHeight;

  let sw = imageWidth;
  let sh = imageHeight;

  if (imageRatio > target) {
    // Gambar lebih lebar → potong kiri-kanan.
    sw = imageHeight * target;
  } else if (imageRatio < target) {
    // Gambar lebih tinggi → potong atas-bawah.
    sh = imageWidth / target;
  }

  return {
    sx: (imageWidth - sw) / 2,
    sy: (imageHeight - sh) / 2,
    sw,
    sh,
  };
}

/** true kalau kotak muat di dalam canvas. */
export function boxFits(box: Box, pixels: PixelSize): boolean {
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= pixels.width && box.y + box.height <= pixels.height;
}

/**
 * Geser elemen supaya tetap di dalam canvas — dipakai editor saat drag, dan
 * saat menormalkan template yang dibuat untuk ukuran lain.
 */
export function clampBox(box: Box, pixels: PixelSize): Box {
  return {
    ...box,
    x: Math.min(Math.max(0, box.x), Math.max(0, pixels.width - box.width)),
    y: Math.min(Math.max(0, box.y), Math.max(0, pixels.height - box.height)),
  };
}
