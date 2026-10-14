/**
 * Tes adapter interpolasi (RIFE + fallback pencampuran).
 *
 * Runtime ONNX dan cache model dipalsukan: yang diuji adalah **perilaku adapter**
 * — kapan ia menyerah (`null`), apakah ia benar-benar menyerahkan piksel hasil ke
 * kanvas, dan apakah kegagalan runtime/model tidak pernah menjalar ke pemanggil.
 * Matematika konversi planar↔RGBA sudah diuji di `faceEnhance.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { OrtRuntimeLike, OrtTensorLike } from "../filters/faceEnhance.ts";
import type { FilterDeps } from "../filters/applyFilters.ts";
import type { ModelCache } from "../models/modelCache.ts";
import { createFakeCanvas, createFakeSource, pixelAt, type FakeCanvas } from "../testing/fakeCanvas.ts";
import type { SourceFrame } from "./interpolation.ts";
import {
  DEFAULT_RIFE_INPUT_DIVISOR,
  alignToDivisor,
  createBlendInterpolator,
  createRifeInterpolator,
  pickInterpolator,
} from "./rife.ts";

/** Tensor palsu — tanpa parameter property (proyek memakai `erasableSyntaxOnly`). */
class FakeTensor {
  type: string;
  data: Float32Array;
  dims: readonly number[];

  constructor(type: string, data: Float32Array, dims: readonly number[]) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

/** Deps kanvas palsu; kanvas yang dibuat dicatat supaya pikselnya bisa diperiksa. */
function deps(): FilterDeps & { canvases: FakeCanvas[] } {
  const canvases: FakeCanvas[] = [];
  return {
    canvases,
    createCanvas: (width, height) => {
      const canvas = createFakeCanvas(width, height);
      canvases.push(canvas);
      return canvas;
    },
    decode: () => Promise.reject(new Error("tidak dipakai di tes ini")),
  };
}

/** Runtime palsu: bisa disuruh melempar saat `create` atau `run`. */
function runtime(
  output: OrtTensorLike | null,
  options: { failCreate?: boolean; failRun?: boolean; feeds?: Record<string, unknown>[] } = {},
): OrtRuntimeLike {
  return {
    InferenceSession: {
      async create() {
        if (options.failCreate === true) throw new Error("wasm tidak termuat");
        return {
          async run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>> {
            options.feeds?.push(feeds);
            if (options.failRun === true) throw new Error("tensor ditolak");
            return output === null ? {} : { out0: output };
          },
        };
      },
    },
    Tensor: FakeTensor as unknown as OrtRuntimeLike["Tensor"],
  };
}

/** Cache model palsu: `ensure` mengembalikan Response kecil atau null. */
function cache(available = true): ModelCache {
  return {
    cacheName: "fb-models",
    ensure: async () => (available ? new Response(new Uint8Array([1, 2, 3, 4])) : null),
    has: async () => available,
    list: async () => [],
    clear: async () => undefined,
  };
}

/** Keluaran RIFE planar CHW: semua kanal 0,5 → 128 setelah konversi. */
function flatOutput(size = 32): OrtTensorLike {
  return { data: new Float32Array(size * size * 3).fill(0.5), dims: [1, 3, size, size] };
}

function frame(image: unknown, index: number): SourceFrame {
  return { index, image, width: 2, height: 2 };
}

test("alignToDivisor membulatkan ke atas ke kelipatan 32", () => {
  assert.equal(DEFAULT_RIFE_INPUT_DIVISOR, 32);
  assert.equal(alignToDivisor(1), 32);
  assert.equal(alignToDivisor(32), 32);
  assert.equal(alignToDivisor(33), 64);
  assert.equal(alignToDivisor(1280), 1280);
  assert.equal(alignToDivisor(0), 32, "ukuran nol tidak menghasilkan 0");
});

test("alignToDivisor menghormati pembagi lain & nilai aneh", () => {
  assert.equal(alignToDivisor(10, 8), 16);
  assert.equal(alignToDivisor(8, 8), 8);
  assert.equal(alignToDivisor(10, 0), 10, "pembagi 0 dijepit ke 1");
  assert.equal(alignToDivisor(Number.NaN, 32), 32);
});

test("RIFE: sebelum dipakai belum siap, sesudah berhasil jadi siap", async () => {
  const interpolator = createRifeInterpolator({
    cache: cache(),
    loadRuntime: async () => runtime(flatOutput()),
    deps: deps(),
  });

  assert.equal(interpolator.kind, "rife");
  assert.equal(interpolator.ready(), false, "sesi belum dibuat sebelum interpolasi pertama");

  const out = await interpolator.interpolate(frame(createFakeSource(2, 2), 0), frame(createFakeSource(2, 2), 1), 0.5);
  assert.ok(out !== null, "interpolasi pertama harus berhasil");
  assert.equal(interpolator.ready(), true);
});

test("RIFE: hasil model benar-benar sampai ke kanvas keluaran", async () => {
  const d = deps();
  const interpolator = createRifeInterpolator({
    cache: cache(),
    loadRuntime: async () => runtime(flatOutput(32)),
    deps: d,
  });

  const out = await interpolator.interpolate(frame(createFakeSource(2, 2), 0), frame(createFakeSource(2, 2), 1), 0.5);
  const canvas = out as FakeCanvas;
  assert.ok(canvas !== null);

  assert.equal(canvas.width, 32);
  assert.equal(canvas.height, 32);
  assert.deepEqual(pixelAt(canvas, 0, 0), [128, 128, 128, 255], "0,5 planar → 128 dengan alpha penuh");
  assert.equal(d.canvases.length, 3, "dua kanvas masukan + satu kanvas keluaran");
});

test("RIFE: dimensi kanvas masukan dibulatkan ke kelipatan 32", async () => {
  const d = deps();
  const seen: Record<string, unknown>[] = [];
  const interpolator = createRifeInterpolator({
    cache: cache(),
    loadRuntime: async () => runtime(flatOutput(32), { feeds: seen }),
    deps: d,
  });

  const wide: SourceFrame = { index: 0, image: createFakeSource(2, 2), width: 100, height: 50 };
  const tall: SourceFrame = { index: 1, image: createFakeSource(2, 2), width: 40, height: 90 };
  await interpolator.interpolate(wide, tall, 0.5);

  const inputCanvas = d.canvases[0];
  assert.ok(inputCanvas !== undefined);
  assert.equal(inputCanvas.width, 128, "100 → 128");
  assert.equal(inputCanvas.height, 96, "90 → 96");

  const feed = seen[0];
  assert.ok(feed !== undefined);
  const tensor = feed.img0 as FakeTensor;
  assert.deepEqual(tensor.dims, [1, 3, 96, 128]);
  assert.equal(tensor.type, "float32");
});

test("RIFE: tanpa cache model → null (bukan lemparan)", async () => {
  const interpolator = createRifeInterpolator({
    cache: null,
    loadRuntime: async () => runtime(flatOutput()),
    deps: deps(),
  });

  const out = await interpolator.interpolate(frame(createFakeSource(2, 2), 0), frame(createFakeSource(2, 2), 1), 0.5);
  assert.equal(out, null);
  assert.equal(interpolator.ready(), false);
});

test("RIFE: runtime gagal dimuat → null", async () => {
  const interpolator = createRifeInterpolator({
    cache: cache(),
    loadRuntime: async () => null,
    deps: deps(),
  });

  assert.equal(await interpolator.interpolate(frame(createFakeSource(2, 2), 0), frame(createFakeSource(2, 2), 1), 0.5), null);
});

test("RIFE: model tidak ada di cache → null", async () => {
  const interpolator = createRifeInterpolator({
    cache: cache(false),
    loadRuntime: async () => runtime(flatOutput()),
    deps: deps(),
  });

  assert.equal(await interpolator.interpolate(frame(createFakeSource(2, 2), 0), frame(createFakeSource(2, 2), 1), 0.5), null);
});

test("RIFE: sesi yang gagal dibuat tidak dicoba berulang tiap frame", async () => {
  let creates = 0;
  const failing: OrtRuntimeLike = {
    InferenceSession: {
      async create() {
        creates += 1;
        throw new Error("model rusak");
      },
    },
    Tensor: FakeTensor as unknown as OrtRuntimeLike["Tensor"],
  };

  const interpolator = createRifeInterpolator({
    cache: cache(),
    loadRuntime: async () => failing,
    deps: deps(),
  });

  const a = frame(createFakeSource(2, 2), 0);
  const b = frame(createFakeSource(2, 2), 1);
  await interpolator.interpolate(a, b, 0.5);
  await interpolator.interpolate(a, b, 0.5);

  assert.equal(creates, 1, "pembuatan sesi hanya dicoba sekali");
});

test("RIFE: model yang melempar saat run → null", async () => {
  const interpolator = createRifeInterpolator({
    cache: cache(),
    loadRuntime: async () => runtime(flatOutput(), { failRun: true }),
    deps: deps(),
  });

  assert.equal(await interpolator.interpolate(frame(createFakeSource(2, 2), 0), frame(createFakeSource(2, 2), 1), 0.5), null);
});

test("RIFE: keluaran tanpa tensor / dimensi salah → null", async () => {
  const empty = createRifeInterpolator({
    cache: cache(),
    loadRuntime: async () => runtime(null),
    deps: deps(),
  });
  assert.equal(await empty.interpolate(frame(createFakeSource(2, 2), 0), frame(createFakeSource(2, 2), 1), 0.5), null);

  const wrongDims = createRifeInterpolator({
    cache: cache(),
    loadRuntime: async () => runtime({ data: new Float32Array(12), dims: [1, 3] }),
    deps: deps(),
  });
  assert.equal(await wrongDims.interpolate(frame(createFakeSource(2, 2), 0), frame(createFakeSource(2, 2), 1), 0.5), null);
});

test("RIFE: bobot waktu dijepit ke 0..1", async () => {
  const seen: Record<string, unknown>[] = [];
  const interpolator = createRifeInterpolator({
    cache: cache(),
    loadRuntime: async () => runtime(flatOutput(32), { feeds: seen }),
    deps: deps(),
  });

  await interpolator.interpolate(frame(createFakeSource(2, 2), 0), frame(createFakeSource(2, 2), 1), 4.2);
  const feed = seen[0];
  assert.ok(feed !== undefined);
  const timestep = feed.timestep as FakeTensor;
  assert.equal(timestep.data[0], 1);
});

test("RIFE: dispose mengembalikan ke keadaan belum siap", async () => {
  const interpolator = createRifeInterpolator({
    cache: cache(),
    loadRuntime: async () => runtime(flatOutput()),
    deps: deps(),
  });

  await interpolator.interpolate(frame(createFakeSource(2, 2), 0), frame(createFakeSource(2, 2), 1), 0.5);
  assert.equal(interpolator.ready(), true);

  interpolator.dispose();
  assert.equal(interpolator.ready(), false);
});

test("pencampuran: selalu siap & mencampur dua frame sesuai bobot", async () => {
  const d = deps();
  const blend = createBlendInterpolator(d);
  assert.equal(blend.kind, "blend");
  assert.equal(blend.ready(), true);

  const red = frame(createFakeSource(2, 2, () => [255, 0, 0, 255]), 0);
  const blue = frame(createFakeSource(2, 2, () => [0, 0, 255, 255]), 1);

  const out = (await blend.interpolate(red, blue, 0.5)) as FakeCanvas;
  assert.ok(out !== null);

  const [r, g, b] = pixelAt(out, 0, 0);
  assert.ok(r >= 126 && r <= 129, `merah harus tersisa separuh, dapat ${r}`);
  assert.ok(b >= 126 && b <= 129, `biru harus masuk separuh, dapat ${b}`);
  assert.equal(g, 0);
  assert.equal(out.context.globalAlpha, 1, "globalAlpha dipulihkan setelah dipakai");
});

test("pencampuran: bobot 0 = frame pertama apa adanya", async () => {
  const blend = createBlendInterpolator(deps());
  const red = frame(createFakeSource(2, 2, () => [255, 0, 0, 255]), 0);
  const blue = frame(createFakeSource(2, 2, () => [0, 0, 255, 255]), 1);

  const out = (await blend.interpolate(red, blue, 0)) as FakeCanvas;
  assert.deepEqual(pixelAt(out, 0, 0), [255, 0, 0, 255]);
});

test("pencampuran: kanvas yang tidak bisa dibuat → null", async () => {
  const broken = createBlendInterpolator({
    createCanvas: () => {
      throw new Error("kanvas tidak tersedia");
    },
    decode: () => Promise.reject(new Error("tidak dipakai")),
  });

  const out = await broken.interpolate(frame(createFakeSource(2, 2), 0), frame(createFakeSource(2, 2), 1), 0.5);
  assert.equal(out, null);
});

test("pickInterpolator memakai RIFE kalau siap, kalau tidak pencampuran", () => {
  const blend = createBlendInterpolator(deps());
  const rifeReady = createRifeInterpolator({ cache: cache(), loadRuntime: async () => runtime(flatOutput()), deps: deps() });

  assert.equal(pickInterpolator(rifeReady, blend), blend, "RIFE belum siap → pakai pencampuran");
  assert.equal(blend.ready(), true, "pencampuran selalu jadi jaring pengaman");
});

test("pickInterpolator memilih RIFE begitu sesinya siap", async () => {
  const blend = createBlendInterpolator(deps());
  const rife = createRifeInterpolator({ cache: cache(), loadRuntime: async () => runtime(flatOutput()), deps: deps() });

  await rife.interpolate(frame(createFakeSource(2, 2), 0), frame(createFakeSource(2, 2), 1), 0.5);
  assert.equal(pickInterpolator(rife, blend), rife);
});
