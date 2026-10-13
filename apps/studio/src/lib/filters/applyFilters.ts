/**
 * Adapter DOM: jalankan rencana filter pada foto nyata (`Blob → Blob`).
 *
 * File ini **tidak memutuskan apa pun**. Aturan "tahap apa, urutan apa" ada di
 * `pipeline.ts` (murni, teruji); di sini hanya eksekusi kanvas. Itu sebabnya
 * `createCanvas` dan `decode` disuntik lewat `FilterDeps`: pengujian memakai
 * kanvas palsu, browser memakai `document.createElement("canvas")`, dan Worker
 * bisa memakai `OffscreenCanvas` tanpa mengubah satu baris pun di sini.
 *
 * **Janji terpenting:** kalau tidak ada yang perlu dikerjakan, blob asli
 * dikembalikan **tanpa decode/encode ulang** — setiap re-encode JPEG menurunkan
 * kualitas, dan itu merugikan kalau filternya netral. Kalau ada yang gagal di
 * tengah jalan, yang dikembalikan tetap blob asli (degradasi anggun), bukan
 * error yang membuat foto hilang dari antrian.
 */

import { applyAdjustmentsToImageData, adjustmentsToCssFilter } from "./adjustments.ts";
import { blurRadiusPx } from "./blur.ts";
import { keyImageData } from "./chromaKey.ts";
import { applyMaskToImageData } from "./mask.ts";
import { describePlan, resolveFilterPlan, type FilterPlan } from "./pipeline.ts";
import { rgbToCss } from "./presets.ts";
import { rotationTransform, rotatedSize } from "./rotation.ts";
import type { FilterSettings } from "./types.ts";
import { fitToQualityPreset, qualityPresetById } from "../capture/quality.ts";

/** Ukuran buffer piksel — subset `ImageData` yang benar-benar dipakai. */
export interface FilterImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Subset `CanvasRenderingContext2D` yang dipakai pipeline filter. */
export interface Filter2DContext {
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  drawImage(image: unknown, dx: number, dy: number, dw?: number, dh?: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): FilterImageData;
  putImageData(data: FilterImageData, x: number, y: number): void;
  fillStyle: string;
  /** `ctx.filter` CSS; kosong di browser yang tidak mendukung (dideteksi di sini). */
  filter: string;
}

/** Canvas minimal yang dibutuhkan pipeline. */
export interface FilterCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): Filter2DContext | null;
  convertToBlob?(options?: { type?: string; quality?: number }): Promise<Blob>;
  toBlob?(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

/** Gambar sumber hasil decode (biasanya `ImageBitmap`). */
export interface FilterSource {
  image: unknown;
  width: number;
  height: number;
  close?(): void;
}

export interface FilterDeps {
  createCanvas(width: number, height: number): FilterCanvas;
  decode(blob: Blob): Promise<FilterSource>;
}

/** Provider mask subjek (segmenter). `null` = gagal; pipeline lanjut tanpa mask. */
export interface SegmenterProvider {
  /** Mask: `255` = subjek, `0` = latar. Panjang = lebar×tinggi gambar. */
  segment(source: FilterSource): Promise<Uint8ClampedArray | null>;
}

/** Provider latar pengganti (mode `ai`). `null` = gagal → mundur ke warna. */
export interface VirtualBackgroundProvider {
  load(): Promise<FilterSource | null>;
}

/** Provider penghalus wajah (GFPGAN). `null` = dilewati. */
export interface FaceEnhanceProvider {
  enhance(canvas: FilterCanvas, deps: FilterDeps): Promise<FilterCanvas | null>;
}

export interface FilterProviders {
  segmenter?: SegmenterProvider;
  background?: VirtualBackgroundProvider;
  faceEnhancer?: FaceEnhanceProvider;
}

export interface FilterResult {
  blob: Blob;
  width: number;
  height: number;
  /** `false` = blob asli diteruskan apa adanya (tidak ada kerja). */
  processed: boolean;
  plan: FilterPlan;
  /** `true` = ada tahap yang gagal dan dilewati; foto tetap selamat. */
  degraded: boolean;
  /** Ringkasan tahap yang benar-benar dijalankan (untuk panel debug). */
  applied: string[];
}

export const FILTER_CONTENT_TYPE = "image/jpeg" as const;

function requireContext(canvas: FilterCanvas): Filter2DContext {
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("context 2d tidak tersedia");
  return ctx;
}

/** Apakah canvas ini benar-benar menerapkan `ctx.filter`? (Safari lama: tidak.) */
function supportsCtxFilter(ctx: Filter2DContext): boolean {
  const probe = "brightness(1.01)";
  try {
    ctx.filter = probe;
    return ctx.filter === probe;
  } catch {
    return false;
  } finally {
    ctx.filter = "none";
  }
}

async function canvasToBlob(canvas: FilterCanvas, quality: number): Promise<Blob> {
  if (canvas.convertToBlob !== undefined) {
    return await canvas.convertToBlob({ type: FILTER_CONTENT_TYPE, quality });
  }
  if (canvas.toBlob !== undefined) {
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob?.(
        (blob) => (blob === null ? reject(new Error("canvas.toBlob() null")) : resolve(blob)),
        FILTER_CONTENT_TYPE,
        quality,
      );
    });
  }
  throw new Error("canvas tidak mendukung convertToBlob() maupun toBlob()");
}

/**
 * Jalankan pipeline pada `blob`.
 *
 * `degraded` diisi `true` bila ada tahap opsional yang gagal (segmenter,
 * face-enhance, latar AI) — foto tetap keluar, hanya tanpa efek itu. Kalau
 * kegagalannya di luar dugaan (decode/canvas), blob asli yang dikembalikan.
 */
export async function applyFilters(
  blob: Blob,
  settings: FilterSettings,
  deps: FilterDeps,
  providers: FilterProviders = {},
): Promise<FilterResult> {
  const plan = resolveFilterPlan(settings);
  const preset = qualityPresetById(settings.quality);

  const passthrough = (degraded: boolean, applied: string[] = []): FilterResult => ({
    blob,
    width: 0,
    height: 0,
    processed: false,
    plan,
    degraded,
    applied,
  });

  let source: FilterSource;
  try {
    source = await deps.decode(blob);
  } catch {
    return passthrough(true);
  }

  try {
    const natural = rotatedSize(source.width, source.height, settings.rotation);
    const target = fitToQualityPreset(natural.width, natural.height, preset);
    if (target.width <= 0 || target.height <= 0) return passthrough(true);

    const needsResize = target.width !== natural.width || target.height !== natural.height;

    // Tanpa tahap & tanpa perubahan ukuran → serahkan blob asli. Re-encode
    // hanya menurunkan kualitas, tidak menambah apa pun.
    if (plan.isIdentity && !needsResize) {
      return { blob, width: source.width, height: source.height, processed: false, plan, degraded: false, applied: [] };
    }

    const scale = natural.width > 0 ? target.width / natural.width : 1;
    const t = rotationTransform(settings.rotation, source.width, source.height);

    const drawBase = (ctx: Filter2DContext): void => {
      ctx.setTransform(t.a * scale, t.b * scale, t.c * scale, t.d * scale, t.e * scale, t.f * scale);
      ctx.drawImage(source.image, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };

    let work = deps.createCanvas(target.width, target.height);
    const wctx = requireContext(work);
    drawBase(wctx);

    const applied: string[] = [];
    let degraded = false;

    // 1. Rotasi (geometri dulu, sudah ikut di `drawBase`) + chroma key → alpha.
    if (plan.stages.includes("rotation")) applied.push("rotation");

    if (plan.needsChromaKey) {
      const image = wctx.getImageData(0, 0, work.width, work.height);
      keyImageData(image.data, settings.chromaKey);
      wctx.putImageData(image, 0, 0);
      applied.push("chromaKey");
    }

    // 2. Latar: mask (chroma key atau segmenter) + komposit.
    if (plan.needsBackground) {
      if (plan.needsSegmenter) {
        let masked = false;
        try {
          const mask = (await providers.segmenter?.segment(source)) ?? null;
          if (mask !== null) {
            const image = wctx.getImageData(0, 0, work.width, work.height);
            masked = applyMaskToImageData(image.data, mask);
            if (masked) wctx.putImageData(image, 0, 0);
          }
        } catch {
          masked = false;
        }
        if (masked) applied.push("segmenter");
        else degraded = true;
      }

      try {
        work = await composeBackground(work, settings, deps, providers, drawBase, (name) => {
          applied.push(name);
        });
      } catch {
        degraded = true;
      }
    }

    // 3. Adjustments.
    if (plan.needsAdjust) {
      try {
        work = applyAdjustments(work, settings, deps);
        applied.push("adjustments");
      } catch {
        degraded = true;
      }
    }

    // 4. Face enhance.
    if (plan.needsFaceEnhance) {
      try {
        const enhanced = (await providers.faceEnhancer?.enhance(work, deps)) ?? null;
        if (enhanced !== null) {
          work = enhanced;
          applied.push("faceEnhance");
        } else {
          degraded = true;
        }
      } catch {
        degraded = true;
      }
    }

    const out = await canvasToBlob(work, preset.jpegQuality);
    return { blob: out, width: work.width, height: work.height, processed: true, plan, degraded, applied };
  } catch {
    return passthrough(true);
  } finally {
    source.close?.();
  }
}

/**
 * Komposit latar di belakang subjek.
 *
 * Mode `blur` menggambar ulang **gambar asli** (bukan subjek ber-alpha) lalu
 * mengaburkannya — kalau yang diblur adalah subjek ber-alpha, lubang tembusnya
 * ikut mengaburkan warna hitam dan latar jadi bernoda gelap.
 */
async function composeBackground(
  subject: FilterCanvas,
  settings: FilterSettings,
  deps: FilterDeps,
  providers: FilterProviders,
  drawBase: (ctx: Filter2DContext) => void,
  note: (name: string) => void,
): Promise<FilterCanvas> {
  const composed = deps.createCanvas(subject.width, subject.height);
  const ctx = requireContext(composed);

  const mode = settings.background.mode;

  if (mode === "blur") {
    ctx.filter = `blur(${blurRadiusPx(settings.background.blur, subject.width)}px)`;
    drawBase(ctx);
    ctx.filter = "none";
    note("background:blur");
  } else if (mode === "ai") {
    let image: FilterSource | null = null;
    try {
      image = (await providers.background?.load()) ?? null;
    } catch {
      image = null;
    }
    if (image !== null) {
      ctx.drawImage(image.image, 0, 0, composed.width, composed.height);
      image.close?.();
      note("background:ai");
    } else {
      // Mundur ke warna latar: lebih baik daripada latar hitam tak sengaja.
      ctx.fillStyle = rgbToCss(settings.background.color);
      ctx.fillRect(0, 0, composed.width, composed.height);
      note("background:ai→warna");
    }
  } else {
    ctx.fillStyle = rgbToCss(settings.background.color);
    ctx.fillRect(0, 0, composed.width, composed.height);
    note("background:color");
  }

  // Subjek di atas latar.
  ctx.drawImage(subject, 0, 0);
  return composed;
}

/** Adjustments: `ctx.filter` bila didukung, kalau tidak jalur piksel. */
function applyAdjustments(
  work: FilterCanvas,
  settings: FilterSettings,
  deps: FilterDeps,
): FilterCanvas {
  const css = adjustmentsToCssFilter(settings.adjustments);
  if (css === "none") return work;

  const ctx = requireContext(work);
  if (supportsCtxFilter(ctx)) {
    const out = deps.createCanvas(work.width, work.height);
    const octx = requireContext(out);
    octx.filter = css;
    octx.drawImage(work, 0, 0);
    octx.filter = "none";
    return out;
  }

  const image = ctx.getImageData(0, 0, work.width, work.height);
  applyAdjustmentsToImageData(image.data, settings.adjustments);
  ctx.putImageData(image, 0, 0);
  return work;
}

/** Dependensi browser: kanvas `document` + decode `createImageBitmap`. */
export function browserFilterDeps(doc: Document = document): FilterDeps {
  return {
    createCanvas(width, height) {
      const canvas = doc.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas as unknown as FilterCanvas;
    },
    async decode(blob) {
      const bitmap = await createImageBitmap(blob);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    },
  };
}

/**
 * Dependensi `OffscreenCanvas` — dipakai di dalam Worker.
 *
 * Di sini `document` tidak ada, jadi kanvas harus dibuat dari `OffscreenCanvas`.
 * `createImageBitmap` sendiri tersedia di Worker, dan itulah satu-satunya cara
 * memindahkan byte foto lintas-thread tanpa menyalin buffer.
 */
export function offscreenFilterDeps(): FilterDeps {
  return {
    createCanvas(width, height) {
      return new OffscreenCanvas(width, height) as unknown as FilterCanvas;
    },
    async decode(blob) {
      const bitmap = await createImageBitmap(blob);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    },
  };
}

/** Ringkasan untuk log/panel debug. */
export function describeResult(result: FilterResult): string {
  const head = result.processed ? "diproses" : "apa adanya";
  const stages = result.applied.length > 0 ? result.applied.join(" + ") : describePlan(result.plan);
  const warn = result.degraded ? " · sebagian dilewati" : "";
  return `${head}: ${stages}${warn}`;
}
