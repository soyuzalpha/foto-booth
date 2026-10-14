/**
 * Adapter DOM: interpolasi frame untuk slow-mo (RIFE + fallback pencampuran).
 *
 * Dua implementasi memenuhi kontrak `FrameInterpolator` yang sama
 * (`interpolation.ts`), jadi pemanggil tidak perlu tahu mana yang aktif:
 *
 *   · **RIFE** — model ONNX dari `/models/*`, di-cache di Cache Storage
 *     (`modelCache.ts`), sama persis pola GFPGAN di Fase 6. Menyintesis frame
 *     baru yang tajam; butuh runtime ±14 MB + model ratusan MB.
 *   · **Blend** — campur dua frame tetangga di kanvas. Selalu ada, murah,
 *     agak kabur di bagian bergerak. Ini yang dipakai kalau RIFE belum siap,
 *     supaya slow-mo **tetap jadi** — video patah lebih baik daripada tidak ada.
 *
 * **Gagal = `null`.** Runtime belum termuat, model belum ter-cache, tensor
 * salah bentuk — semuanya berakhir `null`, dan `interpolateFrames` memakai
 * frame asal apa adanya. Interpolasi tidak pernah membatalkan video.
 *
 * Konversi piksel (RGBA ↔ planar CHW) diimpor dari `faceEnhance.ts`: itu fungsi
 * murni yang sama, dan menyalinnya ke sini hanya akan membuat dua tempat yang
 * harus diperbaiki bersamaan.
 */

import { planarToRgba, rgbaToPlanar, toImageData, type OrtRuntimeLike, type OrtTensorLike } from "../filters/faceEnhance.ts";
import type { Filter2DContext, FilterCanvas, FilterDeps } from "../filters/applyFilters.ts";
import type { ModelCache } from "../models/modelCache.ts";
import type { FrameInterpolator, SourceFrame } from "./interpolation.ts";

export const DEFAULT_RIFE_MODEL = "rife.onnx";
/** RIFE v4 memakai dua frame + satu kanal waktu; ukuran masukan bebas. */
export const DEFAULT_RIFE_INPUT_DIVISOR = 32;

export interface RifeOptions {
  cache?: ModelCache | null;
  modelName?: string;
  loadRuntime?: () => Promise<OrtRuntimeLike | null>;
  /** Dependensi kanvas (browser: `document.createElement`). */
  deps: FilterDeps;
}

function requireContext(canvas: FilterCanvas): Filter2DContext | null {
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

/**
 * Skala dimensi ke kelipatan `divisor` terdekat (ke atas).
 *
 * Model konvolusi seperti RIFE membutuhkan dimensi yang habis dibagi faktor
 * tertentu; memberi ukuran ganjil membuat runtime menolak tensor.
 */
export function alignToDivisor(value: number, divisor: number = DEFAULT_RIFE_INPUT_DIVISOR): number {
  const d = Math.max(1, Math.round(divisor));
  // Nilai non-finit (NaN/Infinity) diperlakukan sebagai satu blok: lebih baik
  // model menerima kanvas kecil yang sah daripada dimensi NaN yang membuat
  // tensor ditolak di tengah rekaman.
  if (!Number.isFinite(value)) return d;
  return Math.max(d, Math.ceil(Math.max(1, Math.round(value)) / d) * d);
}

/** Pemuat default: impor dinamis `onnxruntime-web/wasm` (sama seperti face enhance). */
async function defaultLoadRuntime(): Promise<OrtRuntimeLike | null> {
  try {
    const mod = (await import("onnxruntime-web/wasm")) as unknown as Partial<OrtRuntimeLike>;
    if (mod.InferenceSession === undefined || mod.Tensor === undefined) return null;
    return mod as OrtRuntimeLike;
  } catch {
    return null;
  }
}

export interface RifeInterpolator extends FrameInterpolator {
  dispose(): void;
}

/**
 * Interpolator berbasis RIFE.
 *
 * Alur `interpolate(a, b, mix)`:
 *   1. pastikan sesi ONNX siap (runtime + model ter-cache) — sekali saja;
 *   2. gambar `a` dan `b` ke kanvas berukuran kelipatan 32;
 *   3. jalankan model dengan dua masukan + satu skalar `mix`;
 *   4. tulis keluaran ke kanvas baru dan kembalikan.
 */
export function createRifeInterpolator(options: RifeOptions): RifeInterpolator {
  const cache = options.cache ?? null;
  const modelName = options.modelName ?? DEFAULT_RIFE_MODEL;
  const loadRuntime = options.loadRuntime ?? defaultLoadRuntime;
  const deps = options.deps;

  let runtime: OrtRuntimeLike | null = null;
  let session: { run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>> } | null = null;
  let tried = false;

  async function ensureSession(): Promise<typeof session> {
    if (session !== null) return session;
    if (tried) return null;
    tried = true;
    try {
      if (cache === null) return null;
      // Model diperiksa **sebelum** runtime dimuat. Runtime ONNX ±14 MB dan
      // hanya berguna kalau modelnya ada; tanpa urutan ini, kiosk yang belum
      // pernah menyinkron model tetap mengunduh runtime — lalu tidak memakainya.
      const response = await cache.ensure(modelName);
      if (response === null) return null;
      runtime = runtime ?? (await loadRuntime());
      if (runtime === null) return null;
      const buffer = await response.arrayBuffer();
      session = await runtime.InferenceSession.create(buffer);
    } catch {
      session = null;
    }
    return session;
  }

  return {
    kind: "rife",

    ready(): boolean {
      return session !== null;
    },

    async interpolate(a: SourceFrame, b: SourceFrame, mix: number): Promise<unknown | null> {
      try {
        const ort = await ensureSession();
        if (ort === null || runtime === null) return null;

        const width = alignToDivisor(Math.max(a.width, b.width));
        const height = alignToDivisor(Math.max(a.height, b.height));

        const canvasA = deps.createCanvas(width, height);
        const ctxA = requireContext(canvasA);
        if (ctxA === null) return null;
        ctxA.drawImage(a.image, 0, 0, width, height);
        const dataA = ctxA.getImageData(0, 0, width, height);

        const canvasB = deps.createCanvas(width, height);
        const ctxB = requireContext(canvasB);
        if (ctxB === null) return null;
        ctxB.drawImage(b.image, 0, 0, width, height);
        const dataB = ctxB.getImageData(0, 0, width, height);

        const plane = width * height;
        const inputA = new runtime.Tensor("float32", rgbaToPlanar(dataA.data, width, height), [1, 3, height, width]);
        const inputB = new runtime.Tensor("float32", rgbaToPlanar(dataB.data, width, height), [1, 3, height, width]);
        const timestep = new runtime.Tensor("float32", new Float32Array([Math.min(1, Math.max(0, mix))]), [1]);

        const outputs = await ort.run({ img0: inputA, img1: inputB, timestep });
        const tensor = Object.values(outputs)[0];
        if (tensor === undefined || tensor.dims.length !== 4) return null;

        const outHeight = tensor.dims[2] ?? 0;
        const outWidth = tensor.dims[3] ?? 0;
        if (outWidth <= 0 || outHeight <= 0) return null;

        const rgba = planarToRgba(tensor.data, outWidth, outHeight);
        if (rgba.length === 0) return null;

        const out = deps.createCanvas(outWidth, outHeight);
        const octx = requireContext(out);
        if (octx === null) return null;
        octx.putImageData(toImageData(rgba, outWidth, outHeight), 0, 0);
        void plane;
        return out;
      } catch {
        return null;
      }
    },

    dispose() {
      session = null;
      runtime = null;
      tried = false;
    },
  };
}

/**
 * Interpolator pencampuran — fallback yang selalu ada.
 *
 * Menumpuk dua frame dengan alpha `mix`. Tidak memperbaiki gerakan (tidak ada
 * aliran optik), tapi menghilangkan kedipan "frame ditahan" yang membuat
 * slow-mo terasa tersendat.
 */
export function createBlendInterpolator(deps: FilterDeps): FrameInterpolator {
  return {
    kind: "blend",

    ready(): boolean {
      return true;
    },

    async interpolate(a: SourceFrame, b: SourceFrame, mix: number): Promise<unknown | null> {
      try {
        const width = Math.max(a.width, b.width);
        const height = Math.max(a.height, b.height);
        if (width <= 0 || height <= 0) return null;

        const canvas = deps.createCanvas(width, height);
        const ctx = requireContext(canvas);
        if (ctx === null) return null;

        ctx.drawImage(a.image, 0, 0, width, height);
        const weight = Math.min(1, Math.max(0, mix));
        const previousAlpha = (ctx as unknown as { globalAlpha?: number }).globalAlpha;
        if ("globalAlpha" in ctx) {
          (ctx as unknown as { globalAlpha: number }).globalAlpha = weight;
          ctx.drawImage(b.image, 0, 0, width, height);
          (ctx as unknown as { globalAlpha: number }).globalAlpha = previousAlpha ?? 1;
        } else {
          ctx.drawImage(b.image, 0, 0, width, height);
        }
        return canvas;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Pilih interpolator terbaik yang tersedia.
 *
 * RIFE kalau modelnya siap, kalau tidak pencampuran. **Selalu** mengembalikan
 * sesuatu yang bisa dipakai — slow-mo tidak pernah batal karena model absen.
 */
export function pickInterpolator(rife: FrameInterpolator, blend: FrameInterpolator): FrameInterpolator {
  return rife.ready() ? rife : blend;
}
