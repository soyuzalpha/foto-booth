/**
 * Provider penghalus wajah (GFPGAN) lewat `onnxruntime-web`.
 *
 * Model GFPGAN besar (±340 MB) tidak ikut git; ia disajikan API dari
 * `/models/*` dan **di-cache di Cache Storage** pada sinkron pertama, setelah
 * itu kiosk memakainya offline (`modelCache.ts`).
 *
 * Prinsip:
 *
 *   · **Gagal = `null`.** Runtime belum termuat, model belum ter-cache, tensor
 *     salah bentuk — semua berakhir `null`, dan pipeline melewati tahap ini.
 *     Wajah tidak diperhalus itu lebih baik daripada foto hilang.
 *   · **Runtime dimuat malas.** `onnxruntime-web` berat (±1 MB wasm); memuatnya
 *     saat studio dibuka memperlambat start. Baru dimuat ketika ada foto yang
 *     benar-benar minta face enhance.
 *   · Konversi piksel (RGBA ↔ planar CHW) ditulis sebagai fungsi murni supaya
 *     bisa diuji tanpa runtime.
 */

import type {
  FaceEnhanceProvider,
  FilterCanvas,
  FilterDeps,
  Filter2DContext,
  FilterImageData,
} from "./applyFilters.ts";
import type { ModelCache } from "../models/modelCache.ts";

/** Tensor keluaran/masukan ONNX (subset). */
export interface OrtTensorLike {
  data: Float32Array;
  dims: readonly number[];
}

export interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
}

export interface OrtRuntimeLike {
  InferenceSession: { create(buffer: ArrayBuffer, options?: unknown): Promise<OrtSessionLike> };
  Tensor: new (type: string, data: Float32Array, dims: readonly number[]) => unknown;
}

export interface FaceEnhanceOptions {
  /** Cache model (`modelCache.ts`). Tanpa ini provider selalu `null`. */
  cache?: ModelCache | null;
  /** Nama berkas model di `/models/*`. Default `gfpgan.onnx`. */
  modelName?: string;
  /** Loader runtime; default impor dinamis `onnxruntime-web`. */
  loadRuntime?: () => Promise<OrtRuntimeLike | null>;
  /** Sisi masukan model (GFPGAN: 512). Default 512. */
  inputSize?: number;
}

export const DEFAULT_FACE_MODEL = "gfpgan.onnx";
export const DEFAULT_FACE_INPUT_SIZE = 512;

/** RGBA (0..255) → planar CHW ternormalisasi 0..1 (bentuk masukan ONNX). */
export function rgbaToPlanar(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height * 3);
  const plane = width * height;
  for (let p = 0, i = 0; p < plane; p += 1, i += 4) {
    out[p] = (rgba[i] ?? 0) / 255;
    out[plane + p] = (rgba[i + 1] ?? 0) / 255;
    out[plane * 2 + p] = (rgba[i + 2] ?? 0) / 255;
  }
  return out;
}

/**
 * Planar CHW (0..1 atau 0..255) → RGBA. Nilai di luar rentang di-clamp, jadi
 * keluaran model yang sedikit meleset tidak menghasilkan piksel "wrapping".
 */
export function planarToRgba(planar: Float32Array, width: number, height: number): Uint8ClampedArray {
  const plane = width * height;
  if (planar.length < plane * 3) return new Uint8ClampedArray(0);

  // Deteksi skala: model bisa mengeluarkan 0..1 atau 0..255. Kalau ada nilai
  // > 1.5, anggap skala 0..255.
  let max = 0;
  for (let i = 0; i < plane * 3; i += 1) {
    const v = planar[i] ?? 0;
    if (v > max) max = v;
  }
  const scale = max > 1.5 ? 1 : 255;

  const out = new Uint8ClampedArray(plane * 4);
  for (let p = 0, i = 0; p < plane; p += 1, i += 4) {
    out[i] = Math.round((planar[p] ?? 0) * scale);
    out[i + 1] = Math.round((planar[plane + p] ?? 0) * scale);
    out[i + 2] = Math.round((planar[plane * 2 + p] ?? 0) * scale);
    out[i + 3] = 255;
  }
  return out;
}

/** Ambil tensor NCHW pertama dari keluaran model. `null` kalau bentuknya tak dikenal. */
export function pickOutputTensor(
  outputs: Record<string, OrtTensorLike>,
): { data: Float32Array; width: number; height: number } | null {
  for (const tensor of Object.values(outputs)) {
    const dims = tensor.dims;
    if (dims.length === 4) {
      const channels = dims[1] ?? 0;
      const height = dims[2] ?? 0;
      const width = dims[3] ?? 0;
      if (channels === 3 && width > 0 && height > 0) return { data: tensor.data, width, height };
    }
  }
  return null;
}

/**
 * Pemuat default: impor dinamis paket `onnxruntime-web` (dependensi nyata).
 *
 * Impor **literal** — bukan lewat variabel + `@vite-ignore`. Specifier variabel
 * membuat Vite melewatkannya saat build, dan di browser bare specifier
 * `"onnxruntime-web"` gagal di-resolve: runtime tidak pernah termuat dan face
 * enhance mati diam-diam di produksi (bug yang sama pernah melumpuhkan
 * segmenter MediaPipe).
 *
 * Subpath `/wasm` (bukan entri utama): entri utama menarik varian **jsep**
 * (WebGPU, wasm ±28 MB), sedangkan face enhance cukup backend wasm (±14 MB).
 * Vite mem-bundle-nya jadi chunk malas — baru diunduh saat face enhance dipakai.
 */
async function defaultLoadRuntime(): Promise<OrtRuntimeLike | null> {
  try {
    const mod = (await import("onnxruntime-web/wasm")) as unknown as Partial<OrtRuntimeLike>;
    if (mod.InferenceSession === undefined || mod.Tensor === undefined) return null;
    return mod as OrtRuntimeLike;
  } catch {
    return null;
  }
}

/**
 * Arahkan ORT ke wasm yang kita host sendiri (`<base>models/ort/`, di-emit Vite
 * dari `node_modules`). Tanpa ini, ORT mencari `.wasm` relatif terhadap bundle
 * dan gagal di path produksi — face enhance mati.
 *
 * `import.meta.env.BASE_URL` **harus** ditulis literal: Vite menggantinya secara
 * statis saat build. Akses dinamis (mis. `import.meta.env["BASE_URL"]` atau lewat
 * variabel perantara) tidak tergantikan dan bernilai `undefined` di browser →
 * wasm dicari di path salah (404). Nilainya `/studio/` (lihat `vite.config.ts`).
 */
function configureWasmPaths(runtime: OrtRuntimeLike): void {
  const env = (runtime as { env?: { wasm?: { wasmPaths?: unknown } } }).env;
  if (env?.wasm === undefined || env.wasm.wasmPaths !== undefined) return;
  const base = import.meta.env.BASE_URL || "/studio/";
  env.wasm.wasmPaths = `${base}models/ort/`;
}

/**
 * Bungkus piksel RGBA jadi `ImageData` yang **sah**.
 *
 * `CanvasRenderingContext2D.putImageData` di browser menolak objek biasa
 * ("parameter 1 is not of type 'ImageData'") — kalau itu terjadi, `enhance()`
 * menangkapnya dan mengembalikan `null`, jadi face enhance diam-diam tak pernah
 * jalan. Kanvas palsu di tes menerima objek biasa, sehingga bug ini lolos dari
 * unit test; karena itu objek `ImageData` asli dibuat lebih dulu, dan bentuk
 * biasa hanya dipakai sebagai mundur di lingkungan tanpa `ImageData` (Node).
 */
export function toImageData(data: Uint8ClampedArray, width: number, height: number): FilterImageData {
  const Ctor = (globalThis as { ImageData?: new (d: Uint8ClampedArray, w: number, h: number) => ImageData })
    .ImageData;
  if (Ctor !== undefined) {
    try {
      return new Ctor(data, width, height);
    } catch {
      /* jatuh ke bentuk biasa */
    }
  }
  return { data, width, height };
}

function requireContext(canvas: FilterCanvas): Filter2DContext | null {
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

export interface FaceEnhancerHandle extends FaceEnhanceProvider {
  /** Buang sesi & runtime (bebaskan memori). */
  dispose(): void;
  readonly ready: boolean;
}

/**
 * Buat provider penghalus wajah.
 *
 * Alur `enhance(canvas)`:
 *   1. pastikan sesi ONNX siap (runtime + model ter-cache) — sekali saja;
 *   2. baca piksel kanvas, ubah ke tensor NCHW;
 *   3. jalankan model;
 *   4. tulis keluaran ke kanvas baru dan kembalikan.
 *
 * Semua langkah dibungkus `try/catch` → `null` bila ada yang gagal.
 */
export function createFaceEnhancer(options: FaceEnhanceOptions = {}): FaceEnhancerHandle {
  const cache = options.cache ?? null;
  const modelName = options.modelName ?? DEFAULT_FACE_MODEL;
  const loadRuntime = options.loadRuntime ?? defaultLoadRuntime;
  const inputSize = options.inputSize ?? DEFAULT_FACE_INPUT_SIZE;

  let runtime: OrtRuntimeLike | null = null;
  let session: OrtSessionLike | null = null;
  let tried = false;

  async function ensureSession(): Promise<OrtSessionLike | null> {
    if (session !== null) return session;
    if (tried) return null;
    tried = true;
    try {
      if (cache === null) return null;
      runtime = runtime ?? (await loadRuntime());
      if (runtime === null) return null;
      configureWasmPaths(runtime);

      const response = await cache.ensure(modelName);
      if (response === null) return null;
      const buffer = await response.arrayBuffer();
      session = await runtime.InferenceSession.create(buffer);
    } catch {
      session = null;
    }
    return session;
  }

  return {
    get ready() {
      return session !== null;
    },

    async enhance(canvas: FilterCanvas, deps: FilterDeps): Promise<FilterCanvas | null> {
      try {
        const ort = await ensureSession();
        if (ort === null || runtime === null) return null;

        const ctx = requireContext(canvas);
        if (ctx === null) return null;

        // Model GFPGAN punya sisi masukan tetap (`inputSize`); memberi tensor
        // dengan ukuran kanvas apa adanya akan gagal di runtime. Jadi gambar
        // asli diperkecil ke `inputSize × inputSize` dulu, model dijalankan,
        // lalu hasilnya dikembalikan ke ukuran kanvas asli.
        const square = deps.createCanvas(inputSize, inputSize);
        const sctx = requireContext(square);
        if (sctx === null) return null;
        sctx.drawImage(canvas, 0, 0, inputSize, inputSize);

        const image = sctx.getImageData(0, 0, inputSize, inputSize);
        const planar = rgbaToPlanar(image.data, inputSize, inputSize);
        const input = new runtime.Tensor("float32", planar, [1, 3, inputSize, inputSize]);

        const outputs = await ort.run({ input });
        const picked = pickOutputTensor(outputs);
        if (picked === null) return null;

        const rgba = planarToRgba(picked.data, picked.width, picked.height);
        if (rgba.length === 0) return null;

        const enhanced = deps.createCanvas(picked.width, picked.height);
        const ectx = requireContext(enhanced);
        if (ectx === null) return null;
        ectx.putImageData(toImageData(rgba, picked.width, picked.height), 0, 0);

        // Kembalikan ke ukuran asli supaya tahap berikutnya tidak perlu tahu
        // ukuran internal model.
        const out = deps.createCanvas(canvas.width, canvas.height);
        const octx = requireContext(out);
        if (octx === null) return null;
        octx.drawImage(enhanced, 0, 0, canvas.width, canvas.height);
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

/** Sisi masukan default (dipakai UI untuk memberi tahu operator ukuran model). */
export function faceInputSizeLabel(size: number = DEFAULT_FACE_INPUT_SIZE): string {
  return `${size}×${size}`;
}
