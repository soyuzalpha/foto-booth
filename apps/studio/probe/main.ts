/**
 * Entry probe produksi — di-build dengan pipeline Vite/Rollup sungguhan
 * (`vite.probe.config.ts`) lalu diuji di browser. Membuktikan jalur faceEnhance
 * nyata: runtime `onnxruntime-web/wasm` termuat dari chunk malas, wasm diambil
 * dari `/studio/models/ort/`, model di-fetch dari `/models/*` & di-cache, dan
 * inferensi ONNX benar-benar jalan.
 */
import { browserFilterDeps, type FilterCanvas } from "../src/lib/filters/applyFilters.ts";
import { createFaceEnhancer, pickOutputTensor, rgbaToPlanar } from "../src/lib/filters/faceEnhance.ts";
import { createModelCache } from "../src/lib/models/modelCache.ts";
import type { DirHandleLike, FileHandleLike } from "../src/lib/storage/directoryPicker.ts";

interface Probe {
  run(modelName: string): Promise<Record<string, unknown>>;
  diag(modelName: string): Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    __probe?: Probe;
  }
}

window.__probe = {
  async run(modelName: string) {
    const hits: string[] = [];
    const realFetch = globalThis.fetch;
    const spyFetch: typeof fetch = (input, init) => {
      hits.push(typeof input === "string" ? input : String((input as Request).url ?? input));
      return realFetch(input, init);
    };

    // baseUrl default (`""`) = path relatif `/models/<nama>`, persis yang dipakai
    // aplikasi (`useFilterSettings` → `createBrowserProviders` tanpa
    // `modelsBaseUrl`). Di produksi itu dilayani API dari `$STORAGE_DIR/models/`.
    const cache = createModelCache({ caches: window.caches, fetch: spyFetch });
    const enhancer = createFaceEnhancer({ cache, modelName });

    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 512;
    const g = c.getContext("2d");
    if (g === null) return { ok: false, reason: "no-2d" };
    // Citra uji: gradien berwarna supaya identitas bisa dibuktikan (bukan putih rata).
    const grad = g.createLinearGradient(0, 0, 512, 512);
    grad.addColorStop(0, "#102030");
    grad.addColorStop(1, "#e0d0c0");
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);

    const deps = browserFilterDeps();
    const out = await enhancer.enhance(c as unknown as FilterCanvas, deps);

    let pixels = 0;
    let distinct = 0;
    if (out !== null) {
      const octx = out.getContext("2d");
      if (octx !== null) {
        const d = octx.getImageData(0, 0, out.width, out.height).data;
        pixels = d.length / 4;
        const seen = new Set<string>();
        for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
        distinct = seen.size;
      }
    }

    return {
      ok: out !== null,
      ready: enhancer.ready,
      outW: out?.width ?? 0,
      outH: out?.height ?? 0,
      pixels,
      distinct,
      hits,
      cached: await cache.has(modelName),
      list: await cache.list(),
    };
  },

  /**
   * Replikasi langkah `enhance()` dengan error yang **dibocorkan** — dipakai
   * untuk mendiagnosis langkah mana yang gagal (provider asli menelan error →
   * null by design).
   */
  async diag(modelName: string) {
    const steps: Record<string, unknown> = {};
    try {
      const ort = (await import("onnxruntime-web/wasm")) as unknown as {
        env?: { wasm?: { wasmPaths?: unknown } };
        InferenceSession: { create(b: ArrayBuffer, o?: unknown): Promise<{ run(f: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>> }> };
        Tensor: new (t: string, d: Float32Array, dims: number[]) => unknown;
      };
      steps.loaded = true;
      const env = ort.env;
      if (env?.wasm) env.wasm.wasmPaths = `${import.meta.env.BASE_URL}models/ort/`;
      steps.wasmPaths = env?.wasm?.wasmPaths ?? null;

      const cache = createModelCache({ caches: window.caches, baseUrl: "" });
      const resp = await cache.ensure(modelName);
      steps.ensure = resp !== null;
      if (resp === null) return { steps, error: "ensure-null" };
      const buf = await resp.arrayBuffer();
      steps.modelBytes = buf.byteLength;

      const session = await ort.InferenceSession.create(buf);
      steps.session = true;

      const deps = browserFilterDeps();
      const square = deps.createCanvas(512, 512);
      steps.squareType = square.constructor?.name ?? "?";
      const sctx = square.getContext("2d");
      steps.sctx = sctx !== null;

      const c = document.createElement("canvas");
      c.width = 512;
      c.height = 512;
      const g = c.getContext("2d");
      g?.fillRect(0, 0, 512, 512);
      sctx?.drawImage(c, 0, 0, 512, 512);
      const img = sctx?.getImageData(0, 0, 512, 512);
      steps.imageData = img?.data.length ?? 0;

      const planar = rgbaToPlanar(img!.data, 512, 512);
      const input = new ort.Tensor("float32", planar, [1, 3, 512, 512]);
      const outputs = await session.run({ input });
      steps.outKeys = Object.keys(outputs);
      steps.picked = pickOutputTensor(outputs) !== null;

      // Uji putImageData: objek biasa (seperti kode provider) vs ImageData asli.
      const out = deps.createCanvas(512, 512);
      const octx = out.getContext("2d");
      const picked = pickOutputTensor(outputs)!;
      const rgba = new Uint8ClampedArray(picked.width * picked.height * 4);
      for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 10; rgba[i + 1] = 20; rgba[i + 2] = 30; rgba[i + 3] = 255; }
      try {
        octx?.putImageData({ data: rgba, width: picked.width, height: picked.height }, 0, 0);
        steps.putPlain = "ok";
      } catch (e) {
        steps.putPlain = String((e as Error)?.message ?? e);
      }
      try {
        const real = new ImageData(rgba, picked.width, picked.height);
        octx?.putImageData(real, 0, 0);
        steps.putReal = "ok";
      } catch (e) {
        steps.putReal = String((e as Error)?.message ?? e);
      }
      return { steps, error: null };
    } catch (e) {
      return { steps, error: String((e as Error)?.message ?? e) };
    }
  },
};

/**
 * Probe filter Fase 6 — dibangun lewat pipeline Vite/Rollup sungguhan
 * (`vite.probe.config.ts`) lalu dipanggil dari `e2e/phase6-filters.e2e.mjs`.
 *
 * Yang dibuktikan di sini adalah klaim yang **hanya** bisa dibuktikan di
 * browser: piksel yang benar-benar berubah (chroma key menimpa latar, spill
 * turun, blur meratakan latar), dimensi yang benar-benar bertukar, jalur
 * Worker, cache model sekali-unduh, dan telemetry yang benar-benar no-op.
 * Semuanya memakai modul **hasil bundel produksi**, bukan sumber dev — kalau
 * bundling-nya salah (mis. bare specifier yang mati), probe ini gagal.
 */
interface FiltersProbe {
  chroma(): Promise<Record<string, unknown>>;
  rotation(deg: number): Promise<Record<string, unknown>>;
  spill(): Promise<Record<string, unknown>>;
  adjustments(): Promise<Record<string, unknown>>;
  blur(): Promise<Record<string, unknown>>;
  degrade(): Promise<Record<string, unknown>>;
  offThread(): Promise<Record<string, unknown>>;
  modelCache(): Promise<Record<string, unknown>>;
  sentry(): Promise<Record<string, unknown>>;
  storage(): Promise<Record<string, unknown>>;
  faceEnhance(model: string, cacheName: string): Promise<Record<string, unknown>>;
  segmenter(): Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    __filtersProbe?: FiltersProbe;
  }
}

/** Buat kanvas berisi adegan green-screen: latar hijau + subjek warna kulit. */
function greenScreenCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d");
  if (g !== null) {
    g.fillStyle = "rgb(0,255,0)";
    g.fillRect(0, 0, width, height);
    g.fillStyle = "rgb(200,150,120)";
    const size = Math.round(Math.min(width, height) * 0.5);
    g.fillRect(Math.round((width - size) / 2), Math.round((height - size) / 2), size, size);
  }
  return c;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ?? new Blob()), "image/png");
  });
}

/** Baca kembali blob jadi buffer piksel (lewat `createImageBitmap`, seperti pipeline). */
async function readPixels(
  blob: Blob,
): Promise<{ width: number; height: number; at: (x: number, y: number) => number[] }> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx?.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return {
    width: bitmap.width,
    height: bitmap.height,
    at: (x, y) => Array.from(ctx?.getImageData(x, y, 1, 1).data ?? [0, 0, 0, 0]),
  };
}

window.__filtersProbe = {
  /** Chroma key + latar warna: sudut harus jadi warna latar, subjek tetap utuh. */
  async chroma() {
    const mod = await import("../src/lib/filters/applyFilters.ts");
    const types = await import("../src/lib/filters/types.ts");

    const canvas = greenScreenCanvas(200, 120);
    const settings = {
      ...types.DEFAULT_FILTER_SETTINGS,
      quality: "maks" as const,
      chromaKey: { ...types.DEFAULT_FILTER_SETTINGS.chromaKey, enabled: true },
      background: { mode: "color" as const, color: { r: 255, g: 0, b: 255 }, blur: 50 },
    };

    const result = await mod.applyFilters(await toBlob(canvas), settings, mod.browserFilterDeps());
    const px = await readPixels(result.blob);
    return {
      applied: result.applied,
      degraded: result.degraded,
      corner: px.at(5, 5),
      center: px.at(100, 60),
      width: px.width,
      height: px.height,
    };
  },

  /** Rotasi 90 derajat: dimensi keluaran harus bertukar (bukan diasumsikan). */
  async rotation(deg: number) {
    const mod = await import("../src/lib/filters/applyFilters.ts");
    const types = await import("../src/lib/filters/types.ts");
    const rot = await import("../src/lib/filters/rotation.ts");

    const width = 200;
    const height = 120;
    const canvas = greenScreenCanvas(width, height);
    const settings = { ...types.DEFAULT_FILTER_SETTINGS, quality: "maks" as const, rotation: deg as 0 | 90 | 180 | 270 };

    const result = await mod.applyFilters(await toBlob(canvas), settings, mod.browserFilterDeps());
    const expected = rot.rotatedSize(width, height, deg);
    return {
      in: [width, height],
      out: [result.width, result.height],
      expect: [expected.width, expected.height],
      applied: result.applied,
    };
  },

  /** Spill suppression: kanal hijau piksel tepi turun sampai setara kanal lain. */
  async spill() {
    const ck = await import("../src/lib/filters/chromaKey.ts");
    const types = await import("../src/lib/filters/types.ts");
    const edge = { r: 150, g: 200, b: 140 };
    const key = { ...types.DEFAULT_FILTER_SETTINGS.chromaKey, color: types.CHROMA_GREEN, spill: 100 };
    return { in: edge, out: ck.suppressSpill(edge.r, edge.g, edge.b, key) };
  },

  /** Adjustments: brightness naik → rata-rata naik; saturation -100 → abu-abu. */
  async adjustments() {
    const adj = await import("../src/lib/filters/adjustments.ts");

    const mk = (rgbs: readonly (readonly number[])[]): Uint8ClampedArray => {
      const d = new Uint8ClampedArray(rgbs.length * 4);
      rgbs.forEach((c, i) => {
        d[i * 4] = c[0] ?? 0;
        d[i * 4 + 1] = c[1] ?? 0;
        d[i * 4 + 2] = c[2] ?? 0;
        d[i * 4 + 3] = 255;
      });
      return d;
    };
    const mean = (d: Uint8ClampedArray): number => {
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0)) / 3;
      return sum / (d.length / 4);
    };

    const src = mk([
      [100, 100, 100],
      [120, 80, 60],
      [50, 150, 90],
      [200, 40, 40],
    ]);
    const bright = src.slice();
    adj.applyAdjustmentsToImageData(bright, { brightness: 60, contrast: 0, saturation: 0 });
    const gray = src.slice();
    adj.applyAdjustmentsToImageData(gray, { brightness: 0, contrast: 0, saturation: -100 });

    const grays: number[][] = [];
    for (let i = 0; i < gray.length; i += 4) grays.push([gray[i] ?? 0, gray[i + 1] ?? 0, gray[i + 2] ?? 0]);

    return { meanIn: mean(src), meanBright: mean(bright), grays };
  },

  /** Latar blur: latar ter-key jadi rata (kabur), subjek tetap ada. */
  async blur() {
    const mod = await import("../src/lib/filters/applyFilters.ts");
    const types = await import("../src/lib/filters/types.ts");
    const bl = await import("../src/lib/filters/blur.ts");

    const width = 240;
    const height = 160;
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const g = c.getContext("2d");
    if (g !== null) {
      for (let y = 0; y < height; y += 8) {
        for (let x = 0; x < width; x += 8) {
          g.fillStyle = (x + y) % 16 === 0 ? "rgb(0,120,0)" : "rgb(0,255,0)";
          g.fillRect(x, y, 8, 8);
        }
      }
      g.fillStyle = "rgb(190,150,120)";
      g.fillRect(100, 60, 40, 40);
    }

    const settings = {
      ...types.DEFAULT_FILTER_SETTINGS,
      quality: "maks" as const,
      chromaKey: { ...types.DEFAULT_FILTER_SETTINGS.chromaKey, enabled: true, color: types.CHROMA_GREEN },
      background: { mode: "blur" as const, color: { r: 0, g: 0, b: 0 }, blur: 100 },
    };

    const result = await mod.applyFilters(await toBlob(c), settings, mod.browserFilterDeps());

    const bitmap = await createImageBitmap(result.blob);
    const oc = document.createElement("canvas");
    oc.width = bitmap.width;
    oc.height = bitmap.height;
    const og = oc.getContext("2d");
    og?.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    const variance = (x: number, y: number, w: number, h: number): number => {
      const d = og?.getImageData(x, y, w, h).data;
      if (d === undefined) return 0;
      let sum = 0;
      let sum2 = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0)) / 3;
        sum += v;
        sum2 += v * v;
        n += 1;
      }
      return sum2 / n - (sum / n) ** 2;
    };
    const subjectMean = (() => {
      const d = og?.getImageData(108, 68, 24, 24).data;
      if (d === undefined) return 0;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum += ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0)) / 3;
        n += 1;
      }
      return sum / n;
    })();

    return {
      applied: result.applied,
      bgVariance: variance(10, 10, 40, 40),
      subjectMean,
      radius: bl.blurRadiusPx(100, width),
    };
  },

  /** Provider AI gagal → foto tetap keluar (degraded), ukuran tetap. */
  async degrade() {
    const mod = await import("../src/lib/filters/applyFilters.ts");
    const types = await import("../src/lib/filters/types.ts");

    const width = 100;
    const height = 80;
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    c.getContext("2d")?.fillRect(0, 0, width, height);

    const settings = {
      ...types.DEFAULT_FILTER_SETTINGS,
      quality: "maks" as const,
      chromaKey: { ...types.DEFAULT_FILTER_SETTINGS.chromaKey, enabled: false },
      background: { mode: "ai" as const, color: { r: 10, g: 20, b: 30 }, blur: 0 },
    };

    const result = await mod.applyFilters(await toBlob(c), settings, mod.browserFilterDeps(), {
      segmenter: {
        segment: async () => {
          throw new Error("model tidak ada");
        },
      },
      background: {
        load: async () => {
          throw new Error("model tidak ada");
        },
      },
    });

    return {
      processed: result.processed,
      degraded: result.degraded,
      width: result.width,
      height: result.height,
      outBytes: result.blob.size,
      applied: result.applied,
    };
  },

  /** Jalur off-thread: dukungan browser & keputusan `canRunOffThread`. */
  async offThread() {
    const off = await import("../src/lib/filters/filterOffThread.ts");
    const types = await import("../src/lib/filters/types.ts");
    const workerSettings = {
      ...types.DEFAULT_FILTER_SETTINGS,
      rotation: 90 as const,
      chromaKey: { ...types.DEFAULT_FILTER_SETTINGS.chromaKey, enabled: true },
    };
    const aiSettings = {
      ...types.DEFAULT_FILTER_SETTINGS,
      background: { mode: "ai" as const, color: { r: 0, g: 0, b: 0 }, blur: 0 },
    };
    return {
      offscreen: typeof OffscreenCanvas !== "undefined",
      worker: typeof Worker !== "undefined",
      supported: off.supportsFilterOffThread(),
      canOffThread: off.canRunOffThread(workerSettings),
      identityBlocked: off.canRunOffThread(types.DEFAULT_FILTER_SETTINGS),
      aiBlocked: off.canRunOffThread(aiSettings),
    };
  },

  /** Cache model: unduh sekali, panggilan kedua tidak menyentuh jaringan. */
  async modelCache() {
    const mod = await import("../src/lib/models/modelCache.ts");
    let networkHits = 0;
    const realFetch = globalThis.fetch;
    const spyFetch: typeof fetch = (input, init) => {
      networkHits += 1;
      return realFetch(input, init);
    };

    const cache = mod.createModelCache({ caches: window.caches, fetch: spyFetch });
    const first = await cache.ensure("test-enhance.onnx");
    const bytes = first === null ? 0 : (await first.clone().arrayBuffer()).byteLength;
    const hasAfter = await cache.has("test-enhance.onnx");
    const hitsAfterFirst = networkHits;

    const second = await cache.ensure("test-enhance.onnx");
    const secondBytes = second === null ? 0 : (await second.clone().arrayBuffer()).byteLength;

    return {
      bytes,
      hasAfter,
      secondBytes,
      hitsAfterFirst,
      hitsAfterSecond: networkHits,
      list: await cache.list(),
    };
  },

  /** Telemetry: tanpa DSN → nonaktif, SDK tidak dimuat. */
  async sentry() {
    const mod = await import("../src/lib/telemetry/sentry.ts");
    const calls: string[] = [];
    const handle = mod.initSentry({
      dsn: undefined,
      loadSdk: async () => {
        calls.push("load");
        return null;
      },
    });
    await handle.ready;
    handle.captureError(new Error("uji"));
    handle.captureMessage("uji");
    return { enabled: handle.enabled, loadCalled: calls.length };
  },

  /** Storage picker: folder pilihan (fs-access), batal, dan fallback OPFS. */
  async storage() {
    const dp = await import("../src/lib/storage/directoryPicker.ts");

    const written: string[] = [];
    const fakeFile: FileHandleLike = {
      createWritable: async () => ({
        write: async (data: unknown) => {
          written.push(String(data instanceof Blob ? data.size : data));
        },
        close: async () => {},
      }),
    };
    const fakeDir: DirHandleLike = {
      name: "arsip-foto",
      getDirectoryHandle: async () => fakeDir,
      getFileHandle: async () => fakeFile,
      removeEntry: async () => {},
    };

    const backendFs = dp.chooseArchiveBackend({ showDirectoryPicker: async () => fakeDir });
    const picked = await dp.pickArchiveTarget({ showDirectoryPicker: async () => fakeDir });
    const saved = picked === null ? false : await picked.save("001-x.jpg", new Blob(["abc"]));

    const abort = new Error("dibatalkan");
    abort.name = "AbortError";
    const cancelled = await dp.pickArchiveTarget({
      showDirectoryPicker: async () => {
        throw abort;
      },
    });

    const opfsTarget = await dp.pickArchiveTarget({
      storage: { getDirectory: async () => fakeDir },
    });

    return {
      backendFs,
      targetBackend: picked?.backend ?? null,
      label: picked?.label ?? null,
      saved,
      writtenCount: written.length,
      cancelled: cancelled === null,
      opfsBackend: opfsTarget?.backend ?? null,
      none: await dp.pickArchiveTarget({}),
      list: picked === null ? [] : await picked.list(),
    };
  },

  /** faceEnhance produksi: ORT + wasm dari host sendiri, model dari /models/*. */
  async faceEnhance(model: string, cacheName: string) {
    const mod = await import("../src/lib/filters/faceEnhance.ts");
    const applyMod = await import("../src/lib/filters/applyFilters.ts");
    const cacheMod = await import("../src/lib/models/modelCache.ts");

    const hits: string[] = [];
    const realFetch = globalThis.fetch;
    const spyFetch: typeof fetch = (input, init) => {
      hits.push(typeof input === "string" ? input : String((input as Request).url ?? input));
      return realFetch(input, init);
    };

    const cache = cacheMod.createModelCache({ cacheName, caches: window.caches, fetch: spyFetch });
    const enhancer = mod.createFaceEnhancer({ cache, modelName: model });

    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 512;
    const g = c.getContext("2d");
    if (g !== null) {
      const grad = g.createLinearGradient(0, 0, 512, 512);
      grad.addColorStop(0, "#102030");
      grad.addColorStop(1, "#e0d0c0");
      g.fillStyle = grad;
      g.fillRect(0, 0, 512, 512);
    }

    const out = await enhancer.enhance(c as unknown as FilterCanvas, applyMod.browserFilterDeps());

    let pixels = 0;
    let distinct = 0;
    if (out !== null) {
      const octx = out.getContext("2d");
      const data = octx?.getImageData(0, 0, out.width, out.height).data;
      if (data !== undefined) {
        pixels = data.length / 4;
        const seen = new Set<string>();
        for (let i = 0; i < data.length; i += 4) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
        distinct = seen.size;
      }
    }

    return {
      ok: out !== null,
      ready: enhancer.ready,
      outW: out?.width ?? 0,
      outH: out?.height ?? 0,
      pixels,
      distinct,
      hits,
      cached: await cache.has(model),
      list: await cache.list(),
    };
  },

  /** Segmenter: model bundled benar-benar termuat & menghasilkan mask seukuran gambar. */
  async segmenter() {
    const mod = await import("../src/lib/filters/segmenter.ts");
    const provider = mod.createSegmenterProvider();

    const width = 256;
    const height = 256;
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const g = c.getContext("2d");
    if (g !== null) {
      g.fillStyle = "rgb(60,90,140)";
      g.fillRect(0, 0, width, height);
      g.fillStyle = "rgb(210,170,140)";
      g.fillRect(90, 60, 76, 120);
    }
    const bitmap = await createImageBitmap(c);

    const started = performance.now();
    const mask = await provider.segment({ image: bitmap, width, height });
    const ms = Math.round(performance.now() - started);
    bitmap.close?.();

    let subject = 0;
    if (mask !== null) {
      for (let i = 0; i < mask.length; i += 1) if ((mask[i] ?? 0) > 0) subject += 1;
    }

    return {
      ready: provider.ready,
      maskNull: mask === null,
      len: mask?.length ?? 0,
      expect: width * height,
      subject,
      ms,
    };
  },
};
