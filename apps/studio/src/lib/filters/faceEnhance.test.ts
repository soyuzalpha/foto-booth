import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FACE_INPUT_SIZE,
  createFaceEnhancer,
  faceInputSizeLabel,
  pickOutputTensor,
  planarToRgba,
  rgbaToPlanar,
  toImageData,
  type OrtRuntimeLike,
  type OrtTensorLike,
} from "./faceEnhance.ts";
import type { FilterCanvas, Filter2DContext } from "./applyFilters.ts";
import type { ModelCache } from "../models/modelCache.ts";

/** Kanvas palsu murni-software dengan buffer RGBA sendiri. */
function fakeCanvas(width: number, height: number, fill = 128): FilterCanvas & { pixels: Uint8ClampedArray } {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(fill);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;

  const ctx: Filter2DContext = {
    save() {},
    restore() {},
    setTransform() {},
    drawImage() {},
    clearRect() {},
    fillRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray(pixels), width, height }),
    putImageData: (data) => {
      pixels.set(data.data);
    },
    fillStyle: "",
    filter: "none",
  };

  return {
    width,
    height,
    pixels,
    getContext: () => ctx,
  } as unknown as FilterCanvas & { pixels: Uint8ClampedArray };
}

function fakeCache(body: Uint8Array | null): ModelCache {
  return {
    cacheName: "uji",
    // `Response` segar tiap panggilan: body hanya bisa dibaca sekali, dan tes
    // dispose memang memanggil `ensure` dua kali.
    ensure: async () => (body === null ? null : new Response(body.slice())),
    has: async () => body !== null,
    list: async () => [],
    clear: async () => {},
  };
}

function fakeRuntime(options: { outputs?: Record<string, OrtTensorLike>; throwOnRun?: boolean } = {}): OrtRuntimeLike {
  return {
    InferenceSession: {
      create: async () => ({
        run: async () => {
          if (options.throwOnRun === true) throw new Error("inference gagal");
          return options.outputs ?? { out: { data: new Float32Array(2 * 2 * 3).fill(0.5), dims: [1, 3, 2, 2] } };
        },
      }),
    },
    Tensor: class {
      type: string;
      data: Float32Array;
      dims: readonly number[];
      constructor(type: string, data: Float32Array, dims: readonly number[]) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    },
  } as unknown as OrtRuntimeLike;
}

const deps = { createCanvas: (w: number, h: number) => fakeCanvas(w, h), decode: async () => ({ image: null, width: 0, height: 0 }) };

test("rgbaToPlanar ↔ planarToRgba bolak-balik mempertahankan warna", () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255]);
  const planar = rgbaToPlanar(rgba, 2, 2);
  assert.equal(planar.length, 12);
  // Kanal R di bidang pertama.
  assert.equal(Math.round((planar[0] ?? 0) * 255), 255);

  const back = planarToRgba(planar, 2, 2);
  assert.deepEqual([...back.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...back.slice(12, 16)], [10, 20, 30, 255]);
});

test("planarToRgba mendeteksi skala 0..255 dari keluaran model", () => {
  const planar = new Float32Array([200, 100, 50]);
  const rgba = planarToRgba(planar, 1, 1);
  assert.deepEqual([...rgba.slice(0, 3)], [200, 100, 50]);
});

test("planarToRgba menolak tensor terlalu pendek", () => {
  assert.equal(planarToRgba(new Float32Array(2), 2, 2).length, 0);
});

test("pickOutputTensor mengambil tensor NCHW 3-kanal", () => {
  const picked = pickOutputTensor({
    lain: { data: new Float32Array(4), dims: [1, 1] },
    out: { data: new Float32Array(12), dims: [1, 3, 2, 2] },
  });
  assert.ok(picked !== null);
  assert.equal(picked.width, 2);
  assert.equal(picked.height, 2);
});

test("pickOutputTensor → null kalau tidak ada tensor NCHW 3-kanal", () => {
  assert.equal(pickOutputTensor({ a: { data: new Float32Array(4), dims: [1, 4] } }), null);
});

test("enhance mengembalikan kanvas baru berisi keluaran model", async () => {
  const enhancer = createFaceEnhancer({
    cache: fakeCache(new Uint8Array([1, 2, 3])),
    loadRuntime: async () => fakeRuntime(),
  });
  const input = fakeCanvas(2, 2, 100);
  const out = await enhancer.enhance(input, deps);
  assert.ok(out !== null);
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.equal(enhancer.ready, true);
});

test("tanpa cache → enhance null, tidak melempar", async () => {
  const enhancer = createFaceEnhancer({ loadRuntime: async () => fakeRuntime() });
  assert.equal(await enhancer.enhance(fakeCanvas(2, 2), deps), null);
});

test("model belum ter-cache → null", async () => {
  const enhancer = createFaceEnhancer({ cache: fakeCache(null), loadRuntime: async () => fakeRuntime() });
  assert.equal(await enhancer.enhance(fakeCanvas(2, 2), deps), null);
});

test("runtime tidak tersedia (paket tak terpasang) → null", async () => {
  const enhancer = createFaceEnhancer({
    cache: fakeCache(new Uint8Array([1])),
    loadRuntime: async () => null,
  });
  assert.equal(await enhancer.enhance(fakeCanvas(2, 2), deps), null);
});

test("inference melempar → null (foto tetap selamat)", async () => {
  const enhancer = createFaceEnhancer({
    cache: fakeCache(new Uint8Array([1])),
    loadRuntime: async () => fakeRuntime({ throwOnRun: true }),
  });
  assert.equal(await enhancer.enhance(fakeCanvas(2, 2), deps), null);
});

test("keluaran tanpa tensor NCHW → null", async () => {
  const enhancer = createFaceEnhancer({
    cache: fakeCache(new Uint8Array([1])),
    loadRuntime: async () => fakeRuntime({ outputs: { a: { data: new Float32Array(4), dims: [1, 4] } } }),
  });
  assert.equal(await enhancer.enhance(fakeCanvas(2, 2), deps), null);
});

test("dispose membebaskan sesi & mengizinkan pemuatan ulang", async () => {
  let created = 0;
  const runtime = fakeRuntime();
  const counting: OrtRuntimeLike = {
    ...runtime,
    InferenceSession: {
      create: async (buffer: ArrayBuffer, options?: unknown) => {
        created += 1;
        return runtime.InferenceSession.create(buffer, options);
      },
    },
  } as unknown as OrtRuntimeLike;

  const enhancer = createFaceEnhancer({
    cache: fakeCache(new Uint8Array([1])),
    loadRuntime: async () => counting,
  });
  await enhancer.enhance(fakeCanvas(2, 2), deps);
  assert.equal(created, 1);
  enhancer.dispose();
  assert.equal(enhancer.ready, false);
  await enhancer.enhance(fakeCanvas(2, 2), deps);
  assert.equal(created, 2);
});

test("label ukuran masukan & default diekspor", () => {
  assert.equal(faceInputSizeLabel(), "512×512");
  assert.equal(faceInputSizeLabel(256), "256×256");
  assert.equal(DEFAULT_FACE_INPUT_SIZE, 512);
});

test("toImageData: ImageData asli kalau ada, bentuk biasa kalau tidak", () => {
  // Regresi: `putImageData` di browser menolak objek biasa; kanvas palsu di tes
  // menerimanya, jadi bug ini lolos kalau tidak dijaga eksplisit.
  const rgba = new Uint8ClampedArray([1, 2, 3, 4]);

  const fake = class {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  const saved = (globalThis as { ImageData?: unknown }).ImageData;
  try {
    (globalThis as { ImageData?: unknown }).ImageData = fake;
    const made = toImageData(rgba, 1, 1);
    assert.ok(made instanceof fake, "harus instance ImageData saat tersedia");

    (globalThis as { ImageData?: unknown }).ImageData = undefined;
    const fallback = toImageData(rgba, 1, 1);
    assert.equal(fallback.width, 1);
    assert.equal(fallback.height, 1);
    assert.equal(fallback.data, rgba);
  } finally {
    (globalThis as { ImageData?: unknown }).ImageData = saved;
  }
});

test("model diberi tensor persis `inputSize` — bukan ukuran kanvas apa adanya", async () => {
  // GFPGAN punya sisi masukan tetap: memberi tensor berukuran kanvas asli akan
  // gagal di runtime. Tes ini menjaga agar opsi `inputSize` benar-benar dipakai,
  // bukan sekadar diterima lalu diabaikan.
  const seen: number[][] = [];
  const runtime = {
    InferenceSession: {
      create: async () => ({
        run: async (feeds: Record<string, { dims: readonly number[] }>) => {
          const input = feeds["input"];
          if (input !== undefined) seen.push([...input.dims]);
          return { out: { data: new Float32Array(64 * 64 * 3).fill(0.5), dims: [1, 3, 64, 64] } };
        },
      }),
    },
    Tensor: class {
      dims: readonly number[];
      constructor(_type: string, _data: Float32Array, dims: readonly number[]) {
        this.dims = dims;
      }
    },
  } as unknown as OrtRuntimeLike;

  const enhancer = createFaceEnhancer({
    cache: fakeCache(new Uint8Array([1])),
    loadRuntime: async () => runtime,
    inputSize: 64,
  });

  // Foto 300×200 → model harus tetap menerima 64×64, dan keluaran kembali 300×200.
  const out = await enhancer.enhance(fakeCanvas(300, 200), deps);
  assert.deepEqual(seen, [[1, 3, 64, 64]]);
  assert.ok(out !== null);
  assert.equal(out.width, 300);
  assert.equal(out.height, 200);
});
