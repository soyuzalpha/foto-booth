/**
 * Aturan cetak yang dipakai bersama studio & API.
 *
 * Satu sumber kebenaran untuk: ukuran kertas, margin aman, bleed, dan ukuran
 * piksel lembar cetak. Studio memakainya untuk merender lembar print; API
 * memakainya nanti saat compose galeri versi cetak.
 *
 * SATUAN — sama seperti `template.ts`, dan ini yang paling gampang salah:
 * semua ukuran fisik di sini dalam **inci**, `dpi` menentukan piksel.
 * Jadi `2×6 in` @300 dpi = lembar **600×1800 px**.
 *
 * BLEED vs MARGIN — dua hal berbeda, jangan dicampur:
 *   · **margin** ada di DALAM area trim: batas aman supaya teks/foto tidak
 *     kena potong saat pemotongan kertas tidak presisi. Margin aman default
 *     0,12 in = 36 px @300 dpi — sama dengan `DEFAULT_STRIP_LAYOUT.margin`
 *     supaya strip yang sudah ada tidak berubah posisinya saat dicetak.
 *   · **bleed** ada di LUAR area trim: tinta lebih supaya tidak ada garis
 *     putih di tepi kalau potongannya meleset. Bleed hanya dipakai kalau
 *     memang diminta (`includeBleed`), karena menambah ukuran kanvas.
 */

import { TEMPLATE_DPI_DEFAULT } from "./template.ts";

/** Margin aman di dalam area trim, inci. 0,12 in = 36 px @300 dpi. */
export const PRINT_SAFE_MARGIN_IN = 0.12;

/** Bleed di luar area trim, inci. 0,05 in = 15 px @300 dpi. */
export const PRINT_BLEED_IN = 0.05;

/** Di bawah ini, teks jadi terlalu dekat ke tepi potong. */
export const PRINT_MIN_SAFE_MARGIN_IN = 0.08;

export interface PrintPreset {
  id: string;
  /** Label buat UI, mis. "2×6 in — strip". */
  name: string;
  /** Lebar area **trim** (hasil akhir setelah dipotong), inci. */
  width: number;
  /** Tinggi area trim, inci. */
  height: number;
  dpi: number;
  /** Margin aman di dalam trim, inci. */
  margin: number;
  /** Bleed di luar trim, inci. */
  bleed: number;
  /** Cetak tanda potong di sudut lembar? */
  cutMarks: boolean;
}

/**
 * Preset kertas yang dipakai UI. Urut dari yang paling sering dipakai di
 * foto booth. `id` sengaja sama dengan `TEMPLATE_SIZE_PRESETS` untuk 2×6 & 4×6
 * supaya template dan lembar cetak memakai kunci yang sama.
 */
export const PRINT_PRESETS: readonly PrintPreset[] = [
  {
    id: "2x6",
    name: "2×6 in — strip",
    width: 2,
    height: 6,
    dpi: TEMPLATE_DPI_DEFAULT,
    margin: PRINT_SAFE_MARGIN_IN,
    bleed: PRINT_BLEED_IN,
    cutMarks: false,
  },
  {
    id: "4x6",
    name: "4×6 in — postcard",
    width: 4,
    height: 6,
    dpi: TEMPLATE_DPI_DEFAULT,
    margin: PRINT_SAFE_MARGIN_IN,
    bleed: PRINT_BLEED_IN,
    cutMarks: false,
  },
  {
    id: "5x7",
    name: "5×7 in",
    width: 5,
    height: 7,
    dpi: TEMPLATE_DPI_DEFAULT,
    margin: PRINT_SAFE_MARGIN_IN,
    bleed: PRINT_BLEED_IN,
    cutMarks: false,
  },
  {
    id: "a4",
    name: "A4",
    width: 8.27,
    height: 11.69,
    dpi: TEMPLATE_DPI_DEFAULT,
    margin: PRINT_SAFE_MARGIN_IN,
    bleed: PRINT_BLEED_IN,
    cutMarks: true,
  },
] as const;

export interface PrintPixelSize {
  width: number;
  height: number;
}

/** Preset dari `id`, atau `null` kalau tidak dikenal. */
export function printPresetById(id: string): PrintPreset | null {
  return PRINT_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** Preset terdekat dengan ukuran (inci) yang diberikan; dipakai saat template custom. */
export function nearestPrintPreset(width: number, height: number): PrintPreset {
  let best = PRINT_PRESETS[0];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const preset of PRINT_PRESETS) {
    const score = Math.abs(preset.width - width) + Math.abs(preset.height - height);
    if (score < bestScore) {
      bestScore = score;
      best = preset;
    }
  }

  // `PRINT_PRESETS` tidak pernah kosong, jadi `best` selalu terisi.
  return best as PrintPreset;
}

/**
 * Ukuran kanvas lembar cetak = inci × dpi.
 *
 * `includeBleed` menambah bleed di keempat sisi. Dibulatkan ke piksel bulat
 * supaya pengukuran dan nama berkas tidak pernah menghasilkan pecahan.
 */
export function printPixelSize(
  preset: Pick<PrintPreset, "width" | "height" | "dpi" | "bleed">,
  options: { includeBleed?: boolean } = {},
): PrintPixelSize {
  const dpi = preset.dpi;
  const bleed = options.includeBleed === true ? preset.bleed : 0;
  return {
    width: Math.round((preset.width + bleed * 2) * dpi),
    height: Math.round((preset.height + bleed * 2) * dpi),
  };
}

/** Kotak dalam piksel. */
export interface PrintBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Area aman di dalam lembar (sudah memperhitungkan bleed).
 *
 * Ini batas yang tidak boleh dilewati elemen penting (teks, wajah). Kalau
 * `includeBleed` aktif, area aman bergeser sejauh bleed.
 */
export function printSafeBox(
  preset: Pick<PrintPreset, "width" | "height" | "dpi" | "margin" | "bleed">,
  options: { includeBleed?: boolean } = {},
): PrintBox {
  const dpi = preset.dpi;
  const bleedPx = options.includeBleed === true ? Math.round(preset.bleed * dpi) : 0;
  const marginPx = Math.round(preset.margin * dpi);
  const sheet = printPixelSize(preset, options);

  return {
    x: bleedPx + marginPx,
    y: bleedPx + marginPx,
    width: sheet.width - (bleedPx + marginPx) * 2,
    height: sheet.height - (bleedPx + marginPx) * 2,
  };
}

/** Area trim (hasil akhir setelah dipotong), dalam koordinat kanvas lembar. */
export function printTrimBox(
  preset: Pick<PrintPreset, "width" | "height" | "dpi" | "bleed">,
  options: { includeBleed?: boolean } = {},
): PrintBox {
  const dpi = preset.dpi;
  const bleedPx = options.includeBleed === true ? Math.round(preset.bleed * dpi) : 0;

  return {
    x: bleedPx,
    y: bleedPx,
    width: Math.round(preset.width * dpi),
    height: Math.round(preset.height * dpi),
  };
}

/** Ukuran lembar dalam milimeter — dipakai untuk `@page { size: … }`. */
export function printSizeMm(
  preset: Pick<PrintPreset, "width" | "height" | "bleed">,
  options: { includeBleed?: boolean } = {},
): { width: number; height: number } {
  const bleed = options.includeBleed === true ? preset.bleed : 0;
  return {
    width: round2((preset.width + bleed * 2) * 25.4),
    height: round2((preset.height + bleed * 2) * 25.4),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Muat template ke area aman lembar, jaga rasio aspek.
 *
 * Template tidak pernah diperbesar melebihi area aman — hasil cetak yang
 * "melebar" karena dipaksa memenuhi kertas selalu terlihat salah. Kalau
 * rasionya beda, yang terjadi adalah letterbox (sisa kertas jadi margin),
 * bukan distorsi.
 */
export function fitBox(
  content: { width: number; height: number },
  area: PrintBox,
): PrintBox {
  if (content.width <= 0 || content.height <= 0) {
    return { x: area.x, y: area.y, width: 0, height: 0 };
  }

  const scale = Math.min(area.width / content.width, area.height / content.height);
  const width = content.width * scale;
  const height = content.height * scale;

  return {
    x: area.x + (area.width - width) / 2,
    y: area.y + (area.height - height) / 2,
    width,
    height,
  };
}

/** Satu garis tanda potong: dari titik A ke titik B, dalam piksel lembar. */
export interface CutMarkLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Tanda potong di keempat sudut area trim, digambar di area bleed.
 *
 * Panjangnya dibatasi bleed supaya tidak pernah masuk ke area cetak.
 */
export function cutMarkLines(
  preset: Pick<PrintPreset, "width" | "height" | "dpi" | "bleed" | "cutMarks">,
  options: { includeBleed?: boolean; length?: number } = {},
): CutMarkLine[] {
  if (!preset.cutMarks || options.includeBleed !== true) return [];

  const dpi = preset.dpi;
  const trim = printTrimBox(preset, options);
  const bleedPx = Math.round(preset.bleed * dpi);
  const length = Math.min(options.length ?? bleedPx, bleedPx);
  if (length <= 0) return [];

  const left = trim.x;
  const right = trim.x + trim.width;
  const top = trim.y;
  const bottom = trim.y + trim.height;

  return [
    { x1: left - length, y1: top, x2: left, y2: top },
    { x1: left, y1: top - length, x2: left, y2: top },
    { x1: right, y1: top, x2: right + length, y2: top },
    { x1: right, y1: top - length, x2: right, y2: top },
    { x1: left - length, y1: bottom, x2: left, y2: bottom },
    { x1: left, y1: bottom, x2: left, y2: bottom + length },
    { x1: right, y1: bottom, x2: right, y2: bottom },
    { x1: right, y1: bottom, x2: right, y2: bottom + length },
  ];
}
