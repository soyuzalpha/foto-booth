/**
 * Provider segmenter subjek — MediaPipe Selfie Segmentation.
 *
 * Dipakai mode latar `ai`/`blur` saat chroma key **mati**: tanpa layar hijau,
 * satu-satunya cara memisahkan subjek dari latar adalah model segmentasi. Model
 * (250 KB) di-bundle di `apps/studio/public/models/`, jadi tersedia **tanpa
 * jaringan** sejak awal.
 *
 * Prinsip:
 *
 *   · **Gagal = `null`, bukan lempar.** Pipeline memperlakukan `null` sebagai
 *     "lewati efek latar" — foto tetap keluar. Model tak termuat tidak boleh
 *     membuat foto hilang dari antrian.
 *   · **Mask dikembalikan seukuran gambar sumber.** MediaPipe bekerja pada
 *     resolusi model (256×256); `resizeMaskNearest` memetakannya ke ukuran
 *     gambar supaya `applyMaskToImageData` (yang menuntut panjang = jumlah
 *     piksel) menerimanya.
 *   · Semua ketergantungan disuntik (`load`, `toInput`) → bisa diuji di Node
 *     tanpa WebGL, tanpa kamera, tanpa model.
 */

import { resizeMaskNearest } from "./mask.ts";
import type { FilterSource, SegmenterProvider } from "./applyFilters.ts";

/** Mask satu byte per piksel: `255` = subjek, `0` = latar. */
export interface Mask {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Hasil mentah segmenter (subset MediaPipe `ImageSegmenterResult`). */
export interface RawMask {
  /** Nilai probabilitas/kategori 0..1 (confidence) atau 0/1 (kategori). */
  getAsFloat32Array?(): Float32Array;
  getAsUint8Array?(): Uint8Array;
  /** Dimensi mask; kalau absen dipakai `modelSize`/`width`/`height` dari hasil. */
  width?: number;
  height?: number;
}

export interface RawSegmentResult {
  /**
   * Mask probabilitas subjek — **bentuk nyata MediaPipe**: array `MPMask`.
   * Elemen pertama dipakai (selfie segmenter hanya mengeluarkan satu).
   */
  confidenceMasks?: readonly RawMask[] | undefined;
  /** Mask kategori MediaPipe (`1` = subjek, `0` = latar). */
  categoryMask?: RawMask | undefined;
  /**
   * Bentuk lama: array datar, bukan `MPMask`. Dipertahankan supaya pemanggil
   * lama / tes tetap jalan.
   */
  confidence?: Float32Array | Uint8Array;
  category?: Uint8Array;
  /** Dimensi mask. Kalau absen, dipakai `modelSize` dari opsi. */
  width?: number;
  height?: number;
}

export interface SegmenterInstance {
  segment(input: unknown): Promise<RawSegmentResult> | RawSegmentResult;
  close?(): void;
}

export interface SegmenterFactory {
  create(): Promise<SegmenterInstance> | SegmenterInstance;
}

export interface SegmenterOptions {
  /** Loader MediaPipe. Default: `import("@mediapipe/tasks-vision")` (dinamis). */
  load?: () => Promise<SegmenterFactory | null>;
  /** Ubah gambar sumber → input segmenter (biasanya `HTMLCanvasElement`). */
  toInput?: (source: FilterSource) => unknown;
  /** Ambang probabilitas subjek, 0..1. Default 0.5. */
  threshold?: number;
  /** Sisi mask MediaPipe selfie segmenter. Default 256. */
  modelSize?: number;
  /** Folder berkas wasm MediaPipe. Default `/studio/models/mediapipe`. */
  wasmBase?: string;
  /** Path berkas model `.tflite`. Default `/studio/models/selfie_segmenter.tflite`. */
  modelPath?: string;
}

export const DEFAULT_SEGMENT_THRESHOLD = 0.5;
export const DEFAULT_SEGMENT_MODEL_SIZE = 256;
/** Aset MediaPipe yang **di-bundle** bersama studio (di bawah `base` Vite). */
export const DEFAULT_SEGMENT_WASM_BASE = "/studio/models/mediapipe";
export const DEFAULT_SEGMENT_MODEL_PATH = "/studio/models/selfie_segmenter.tflite";

/**
 * Hasil mentah → mask biner.
 *
 * `confidence` dipakai lebih dulu (memberi tepi yang lebih halus setelah
 * ambang); kalau tidak ada, jatuh ke `category`. Nilai kategori MediaPipe
 * adalah `1` untuk subjek, jadi ambang di sini adalah `>= 1`, bukan `> 0.5`.
 */
export function rawToMask(raw: RawSegmentResult, threshold: number, fallbackSize: number): Mask | null {
  // Bentuk nyata MediaPipe: `confidenceMasks` (MPMask[]) / `categoryMask`
  // (MPMask). Objek MPMask baru berisi data setelah `getAsFloat32Array()` /
  // `getAsUint8Array()` dipanggil — bukan properti `.confidence` biasa.
  const confMask = raw.confidenceMasks?.[0];
  const confidence = confMask?.getAsFloat32Array?.() ?? raw.confidence;
  const category = raw.categoryMask?.getAsUint8Array?.() ?? raw.category;

  const size = confidence?.length ?? category?.length ?? 0;
  if (size === 0) return null;

  const width = raw.width ?? confMask?.width ?? raw.categoryMask?.width ?? fallbackSize;
  const height = raw.height ?? confMask?.height ?? raw.categoryMask?.height ?? (width > 0 ? Math.round(size / width) : 0);
  if (width <= 0 || height <= 0 || width * height !== size) return null;

  const data = new Uint8ClampedArray(size);
  const thr = Math.min(1, Math.max(0, threshold));

  if (confidence !== undefined) {
    for (let i = 0; i < size; i += 1) {
      data[i] = (confidence[i] ?? 0) >= thr ? 255 : 0;
    }
  } else {
    const cat = category ?? new Uint8Array(0);
    for (let i = 0; i < size; i += 1) {
      data[i] = (cat[i] ?? 0) >= 1 ? 255 : 0;
    }
  }

  return { data, width, height };
}

async function loadMediapipe(options: {
  wasmBase: string;
  modelPath: string;
}): Promise<SegmenterFactory | null> {
  try {
    // Impor **literal**: `@mediapipe/tasks-vision` adalah dependensi nyata
    // (`package.json`), jadi Vite harus mem-bundle-nya jadi chunk malas.
    // Sebelumnya specifier lewat variabel + `@vite-ignore` membuat Vite
    // melewatkannya, dan di browser bare specifier itu gagal di-resolve —
    // segmenter selalu `null`, semua mode latar AI mati diam-diam.
    // Chunk tetap dimuat malas: impor ini baru dievaluasi saat `load()` dipanggil.
    const mod = (await import("@mediapipe/tasks-vision")) as unknown as {
      FilesetResolver?: { forVisionTasks(base: string): Promise<unknown> };
      ImageSegmenter?: { createFromOptions(fileset: unknown, options: unknown): Promise<SegmenterInstance> };
    };
    if (mod.ImageSegmenter === undefined || mod.FilesetResolver === undefined) return null;

    const fileset = await mod.FilesetResolver.forVisionTasks(options.wasmBase);
    const instance = await mod.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: options.modelPath, delegate: "GPU" },
      runningMode: "IMAGE",
      outputConfidenceMasks: true,
      outputCategoryMask: true,
    });
    return { create: () => instance };
  } catch {
    return null;
  }
}

export interface SegmenterHandle extends SegmenterProvider {
  /** Buang instance (mis. saat pindah halaman). Aman dipanggil berkali-kali. */
  dispose(): void;
  /** `true` kalau instance sudah dimuat. */
  readonly ready: boolean;
}

/**
 * Buat provider segmenter.
 *
 * Instance dimuat **sekali** (memoized). Kalau pemuatan gagal, `segment`
 * mengembalikan `null` selamanya tanpa mencoba ulang tiap foto — gagal
 * berulang-ulang hanya memperlambat kiosk.
 */
export function createSegmenterProvider(options: SegmenterOptions = {}): SegmenterHandle {
  const wasmBase = options.wasmBase ?? DEFAULT_SEGMENT_WASM_BASE;
  const modelPath = options.modelPath ?? DEFAULT_SEGMENT_MODEL_PATH;
  const load = options.load ?? (() => loadMediapipe({ wasmBase, modelPath }));
  const toInput = options.toInput ?? ((source: FilterSource) => source.image);
  const threshold = options.threshold ?? DEFAULT_SEGMENT_THRESHOLD;
  const modelSize = options.modelSize ?? DEFAULT_SEGMENT_MODEL_SIZE;

  let instance: SegmenterInstance | null = null;
  let tried = false;

  async function ensure(): Promise<SegmenterInstance | null> {
    if (instance !== null) return instance;
    if (tried) return null;
    tried = true;
    try {
      const factory = await load();
      instance = factory === null ? null : await factory.create();
    } catch {
      instance = null;
    }
    return instance;
  }

  return {
    get ready() {
      return instance !== null;
    },

    async segment(source: FilterSource): Promise<Uint8ClampedArray | null> {
      try {
        const segmenter = await ensure();
        if (segmenter === null) return null;

        const raw = await segmenter.segment(toInput(source));
        const mask = rawToMask(raw, threshold, modelSize);
        if (mask === null) return null;

        const sized = resizeMaskNearest(mask.data, mask.width, mask.height, source.width, source.height);
        return sized.length === source.width * source.height ? sized : null;
      } catch {
        return null;
      }
    },

    dispose() {
      try {
        instance?.close?.();
      } catch {
        // tutup best-effort
      }
      instance = null;
      tried = false;
    },
  };
}
