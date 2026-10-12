/**
 * Aturan template yang dipakai bersama studio & API.
 *
 * Satu sumber kebenaran untuk: satuan ukuran, resolusi export, dan token teks.
 * Studio memakainya untuk render; API memakainya saat compose galeri nanti.
 *
 * SATUAN — ini yang paling gampang salah:
 * `size.width` / `size.height` dalam **inci**, `dpi` menentukan piksel.
 * Jadi `2×6` @300 dpi = canvas **600×1800 px**. Posisi elemen (`x`,`y`) selalu
 * dalam **piksel canvas hasil**, bukan inci.
 */

export const TEMPLATE_DPI_DEFAULT = 300;

/** Di bawah ini hasil cetak mulai terlihat kasar — tolak, jangan diamkan. */
export const TEMPLATE_MIN_EXPORT_DPI = 300;

/** Batas aman: canvas di atas ini bikin browser mobile kehabisan memori. */
export const TEMPLATE_MAX_PIXELS = 40_000_000;

export interface TemplateSizePreset {
  id: string;
  /** Label buat UI, mis. "2×6 in — strip". */
  name: string;
  /** Inci. */
  width: number;
  height: number;
}

/** Preset kertas yang dipakai UI. Urut dari yang paling sering dipakai. */
export const TEMPLATE_SIZE_PRESETS: readonly TemplateSizePreset[] = [
  { id: "2x6", name: "2×6 in — strip", width: 2, height: 6 },
  { id: "4x6", name: "4×6 in — postcard", width: 4, height: 6 },
  { id: "5x7", name: "5×7 in", width: 5, height: 7 },
  { id: "6x8", name: "6×8 in", width: 6, height: 8 },
  { id: "a4", name: "A4", width: 8.27, height: 11.69 },
] as const;

export interface PixelSize {
  width: number;
  height: number;
}

/**
 * Ukuran canvas hasil = inci × dpi.
 *
 * Dibulatkan ke piksel bulat supaya nama file dan pengukuran tidak pernah
 * menghasilkan pecahan.
 */
export function templatePixelSize(size: { width: number; height: number; dpi?: number }): PixelSize {
  const dpi = size.dpi ?? TEMPLATE_DPI_DEFAULT;
  return {
    width: Math.round(size.width * dpi),
    height: Math.round(size.height * dpi),
  };
}

/** DPI efektif yang bisa dicapai ukuran ini; dipakai UI untuk memperingatkan. */
export function effectiveDpi(size: { width: number; height: number; dpi?: number }): number {
  return size.dpi ?? TEMPLATE_DPI_DEFAULT;
}

/** true kalau canvas-nya kebesaran untuk dirender. */
export function isTemplateTooLarge(size: { width: number; height: number; dpi?: number }): boolean {
  const px = templatePixelSize(size);
  return px.width * px.height > TEMPLATE_MAX_PIXELS;
}

/* ------------------------------------------------------------------ *
 * Token teks
 * ------------------------------------------------------------------ */

export const TEXT_TOKENS = ["event", "date", "time", "custom"] as const;

export type TextToken = (typeof TEXT_TOKENS)[number];

export type TokenValues = Partial<Record<TextToken, string>>;

/** `{event}` — huruf/angka/underscore, tanpa spasi. */
const TOKEN_PATTERN = /\{(\w+)\}/g;

function isTextToken(name: string): name is TextToken {
  return (TEXT_TOKENS as readonly string[]).includes(name);
}

/**
 * Ganti token yang dikenal dengan nilainya; token tak dikenal dibiarkan apa
 * adanya supaya teks bebas seperti `{nggak sengaja}` tidak hilang diam-diam.
 */
export function substituteTokens(text: string, values: TokenValues): string {
  return text.replace(TOKEN_PATTERN, (match, name: string) => {
    if (!isTextToken(name)) return match;
    return values[name] ?? "";
  });
}

/** Nama token yang muncul di teks (buat pratinjau & validasi di editor). */
export function extractTokens(text: string): TextToken[] {
  const found: TextToken[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const name = match[1];
    if (name !== undefined && isTextToken(name) && !found.includes(name)) {
      found.push(name);
    }
  }
  return found;
}

/** true kalau teks mengandung minimal satu token yang dikenal. */
export function hasTokens(text: string): boolean {
  return extractTokens(text).length > 0;
}

/* ------------------------------------------------------------------ *
 * Nama file
 * ------------------------------------------------------------------ */

/** "Pesta Ulang Tahun 2026!" → "pesta-ulang-tahun-2026". */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Nama file rapi & unik: `<slug>-<tanggal>-<lebar>x<tinggi>.<ext>`.
 * Contoh: `pesta-ulang-tahun-2026-10-12-600x1800.png`
 */
export function exportFilename(
  templateName: string,
  values: TokenValues,
  pixels: PixelSize,
  extension: "png" | "jpeg",
  now: Date,
): string {
  const parts = [
    slugify(templateName) || "template",
    values.event !== undefined && values.event !== "" ? slugify(values.event) : "",
    now.toISOString().slice(0, 10),
    `${pixels.width}x${pixels.height}`,
  ].filter((part) => part !== "");
  return `${parts.join("-")}.${extension}`;
}
