/**
 * Model template — bikin, validasi, dan bikin template bawaan.
 *
 * Aturan: **tidak ada Template yang beredar di aplikasi tanpa lewat
 * `validateTemplate`/`normalizeTemplate`.** Semua yang masuk dari IndexedDB,
 * dari file impor, atau dari editor diperiksa Zod dulu. Kalau tidak valid,
 * pemanggilnya dapat daftar pesan yang bisa ditampilkan — bukan exception
 * mentah.
 */

import {
  TEMPLATE_DPI_DEFAULT,
  TEMPLATE_SIZE_PRESETS,
  TemplateSchema,
  templatePixelSize,
  type Template,
  type TemplateFrame,
  type TemplateSize,
  type TemplateSticker,
  type TemplateText,
} from "@foto-booth/shared";

import { footerBox, stripLayout } from "./layout.ts";

export const DEFAULT_FONT_FAMILY = "Inter, system-ui, -apple-system, sans-serif";
export const DEFAULT_TEXT_COLOR = "#0a0a0a";
export const DEFAULT_BACKGROUND = "#ffffff";

/** ID acak yang aman di browser maupun Node. */
export function newId(prefix: string): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

export class TemplateValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Template tidak valid:\n- ${issues.join("\n- ")}`);
    this.name = "TemplateValidationError";
    this.issues = issues;
  }
}

function formatIssues(error: { issues: { path: (string | number)[]; message: string }[] }): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `${path}: ${issue.message}`;
  });
}

export type ValidationResult =
  | { ok: true; template: Template }
  | { ok: false; errors: string[] };

/**
 * Periksa tanpa melempar — dipakai UI supaya kesalahan tampil sebagai pesan,
 * bukan layar putih.
 */
export function validateTemplate(input: unknown): ValidationResult {
  const parsed = TemplateSchema.safeParse(input);
  if (parsed.success) return { ok: true, template: parsed.data };
  return { ok: false, errors: formatIssues(parsed.error) };
}

/** Versi yang melempar — dipakai kode internal yang memang harus berhenti. */
export function normalizeTemplate(input: unknown): Template {
  const result = validateTemplate(input);
  if (!result.ok) throw new TemplateValidationError(result.errors);
  return result.template;
}

export function cloneTemplate(template: Template): Template {
  return structuredClone(template);
}

/** Cap waktu perubahan; dipanggil setiap kali editor menyimpan. */
export function touchTemplate(template: Template, now: Date): Template {
  return { ...template, updatedAt: now.toISOString() };
}

export interface CreateTemplateInput {
  name: string;
  /** `dpi` opsional — default 300. */
  size: { width: number; height: number; dpi?: number; name?: string };
  frames?: TemplateFrame[];
  textElements?: TemplateText[];
  stickers?: TemplateSticker[];
  background?: Template["background"];
  now?: Date;
  id?: string;
}

/** Bikin Template lengkap dengan default yang konsisten. */
export function createTemplate(input: CreateTemplateInput): Template {
  const now = input.now ?? new Date();
  const stamp = now.toISOString();
  const size: TemplateSize = {
    width: input.size.width,
    height: input.size.height,
    dpi: input.size.dpi ?? TEMPLATE_DPI_DEFAULT,
    ...(input.size.name !== undefined ? { name: input.size.name } : {}),
  };

  return normalizeTemplate({
    id: input.id ?? newId("tpl"),
    name: input.name,
    size,
    background: input.background ?? { type: "color", value: DEFAULT_BACKGROUND, hasVignette: false },
    frames: input.frames ?? [],
    textElements: input.textElements ?? [],
    stickers: input.stickers ?? [],
    createdAt: stamp,
    updatedAt: stamp,
  });
}

export function presetById(id: string): { width: number; height: number; name: string } | null {
  const preset = TEMPLATE_SIZE_PRESETS.find((item) => item.id === id);
  if (preset === undefined) return null;
  return { width: preset.width, height: preset.height, name: preset.name };
}

/**
 * Template strip siap pakai: satu kolom frame + footer teks bertoken.
 *
 * Ini yang muncul pertama kali waktu user membuka editor, jadi harus langsung
 * "kelihatan benar" — bukan kanvas kosong.
 */
export function defaultStripTemplate(options: {
  name?: string;
  count?: number;
  presetId?: string;
  now?: Date;
} = {}): Template {
  const count = options.count ?? 6;
  const preset = presetById(options.presetId ?? "2x6") ?? { width: 2, height: 6, name: "2×6 in — strip" };
  const size: TemplateSize = {
    width: preset.width,
    height: preset.height,
    dpi: TEMPLATE_DPI_DEFAULT,
    name: preset.name,
  };
  const pixels = templatePixelSize(size);

  const frames: TemplateFrame[] = stripLayout(pixels, count).map((box, index) => ({
    id: newId("frame"),
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    rotation: 0,
    slot: index,
    borderThickness: 6,
    borderColor: "#0a0a0a",
    hasShadow: false,
  }));

  const footer = footerBox(pixels, count);
  const textElements: TemplateText[] = [
    {
      id: newId("text"),
      text: "{event}",
      x: footer.x,
      y: footer.y + 8,
      width: footer.width,
      height: 72,
      fontSize: 46,
      fontFamily: DEFAULT_FONT_FAMILY,
      color: DEFAULT_TEXT_COLOR,
      strokeWidth: 0,
      align: "center",
      rotation: 0,
    },
    {
      id: newId("text"),
      text: "{date} · {time}",
      x: footer.x,
      y: footer.y + 82,
      width: footer.width,
      height: 48,
      fontSize: 26,
      fontFamily: DEFAULT_FONT_FAMILY,
      color: "#55524a",
      strokeWidth: 0,
      align: "center",
      rotation: 0,
    },
  ];

  return createTemplate({
    name: options.name ?? "Strip 2×6",
    size,
    frames,
    textElements,
    stickers: [],
    now: options.now,
  });
}

/**
 * Ganti ukuran template, lalu **susun ulang** frame-nya.
 *
 * Kenapa disusun ulang: posisi frame di strip bukan sekadar diperbesar — jumlah
 * kolom, margin, dan footer semuanya ikut berubah saat inci berubah. Mengalikan
 * `x`/`y` lama dengan rasio akan menghasilkan margin yang aneh dan frame yang
 * keluar kanvas. Teks ikut diskalakan proporsional karena posisinya absolut.
 */
export function resizeTemplate(
  template: Template,
  size: { width: number; height: number; name?: string; dpi?: number },
): Template {
  const next: TemplateSize = {
    width: size.width,
    height: size.height,
    dpi: size.dpi ?? template.size.dpi ?? TEMPLATE_DPI_DEFAULT,
    ...(size.name !== undefined ? { name: size.name } : {}),
  };

  const pixels = templatePixelSize(next);
  const ratio = pixels.width / templatePixelSize(template.size).width;

  const boxes = stripLayout(pixels, template.frames.length);
  const frames = [...template.frames]
    .sort((a, b) => a.slot - b.slot)
    .map((frame, index) => {
      const box = boxes[index];
      if (box === undefined) return frame;
      return { ...frame, x: box.x, y: box.y, width: box.width, height: box.height };
    });

  const textElements = template.textElements.map((element) => ({
    ...element,
    x: element.x * ratio,
    y: element.y * ratio,
    width: element.width * ratio,
    height: element.height * ratio,
    fontSize: element.fontSize * ratio,
  }));

  return normalizeTemplate({ ...template, size: next, frames, textElements });
}

/** Slot yang belum terpakai — dipakai tombol "tambah frame". */
export function nextSlot(template: Template): number {
  const used = new Set(template.frames.map((frame) => frame.slot));
  let slot = 0;
  while (used.has(slot)) slot += 1;
  return slot;
}

/** Frame diurutkan per slot; slot yang bolong jadi `undefined`. */
export function framesBySlot(template: Template): (TemplateFrame | undefined)[] {
  const max = template.frames.reduce((acc, frame) => Math.max(acc, frame.slot), -1);
  const result: (TemplateFrame | undefined)[] = new Array(max + 1).fill(undefined);
  for (const frame of template.frames) result[frame.slot] = frame;
  return result;
}
