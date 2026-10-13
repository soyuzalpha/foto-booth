/**
 * Tes adapter DOM `applyFilters` — memakai kanvas palsu yang benar-benar
 * memindahkan piksel, bukan mencatat panggilan.
 *
 * Yang diuji di sini adalah **janji perilaku** adapter, bukan matematika filter
 * (itu sudah diuji di modul murninya):
 *
 *   · filternetral → blob asli dikembalikan tanpa decode/encode ulang;
 *   · chroma key benar-benar mengganti warna latar di piksel hasil;
 *   · rotasi 90 menukar dimensi keluaran;
 *   · penyedia (segmenter/latar/face) yang gagal tidak menghilangkan foto;
 *   · preset kualitas membatasi lebar tanpa memperbesar.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyFilters, type FilterDeps, type FilterProviders } from "./applyFilters.ts";
import { DEFAULT_FILTER_SETTINGS, type FilterSettings } from "./types.ts";
import {
  createFakeCanvas,
  createFakeSource,
  fakeFilterDeps,
  type FakeSource,
} from "../testing/fakeCanvas.ts";

/** Baca buffer piksel dari blob hasil (kanvas palsu menulis pixels mentah ke blob). */
async function outPixels(blob: Blob): Promise<Uint8ClampedArray> {
  return new Uint8ClampedArray(await blob.arrayBuffer());
}

/** RGBA satu piksel dari buffer hasil. */
function at(pixels: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0, pixels[i + 3] ?? 0];
}

/** Salin default lalu timpa bagian yang diuji — supaya tes tidak bergantung urutan. */
function settings(patch: Partial<FilterSettings> = {}): FilterSettings {
  return { ...structuredClone(DEFAULT_FILTER_SETTINGS), ...patch };
}

/** Sumber 2×2: kolom kiri hijau (latar), kolom kanan merah (subjek). */
function greenScreenSource(): FakeSource {
  return createFakeSource(2, 2, (x) =>
    x === 0 ? [0, 255, 0, 255] : [255, 0, 0, 255],
  );
}

/** Dependensi dengan blob dummy (isi blob tidak dipakai karena decode dipalsukan). */
function depsFor(source: FakeSource, supportsFilter = false) {
  return fakeFilterDeps(source, { supportsFilter });
}

const DUMMY_BLOB = new Blob(["asli"], { type: "image/jpeg" });

test("filter netral mengembalikan blob asli tanpa decode/encode ulang", async () => {
  const source = greenScreenSource();
  const deps = depsFor(source);

  const result = await applyFilters(DUMMY_BLOB, settings(), deps);

  assert.equal(result.processed, false);
  assert.equal(result.blob, DUMMY_BLOB, "blob harus objek yang sama, bukan hasil encode");
  assert.equal(result.degraded, false);
  assert.deepEqual(result.applied, []);
});

test("chroma key menimpa latar hijau dengan warna, subjek tetap utuh", async () => {
  const source = greenScreenSource();
  const deps = depsFor(source);

  const result = await applyFilters(
    DUMMY_BLOB,
    settings({
      chromaKey: { enabled: true, color: { r: 0, g: 255, b: 0 }, similarity: 60, smoothness: 10, spill: 0 },
      background: { mode: "color", color: { r: 30, g: 90, b: 200 }, blur: 50 },
    }),
    deps,
  );

  assert.equal(result.processed, true);
  assert.ok(result.applied.includes("chromaKey"), "tahap chromaKey harus tercatat");
  assert.ok(result.applied.some((s) => s.startsWith("background")), "latar harus dikomposit");

  const out = await outPixels(result.blob);
  // Piksel yang tadinya hijau sekarang jadi warna latar (biru), bukan hijau.
  const left = at(out, result.width, 0, 0);
  assert.deepEqual([left[0], left[1], left[2]], [30, 90, 200]);
  // Piksel subjek (merah) tidak ikut terbuang.
  const right = at(out, result.width, 1, 0);
  assert.deepEqual([right[0], right[1], right[2]], [255, 0, 0]);
});

test("rotasi 90 menukar lebar dan tinggi keluaran", async () => {
  const source = createFakeSource(4, 2, () => [255, 255, 255, 255]);
  const deps = depsFor(source);

  const result = await applyFilters(DUMMY_BLOB, settings({ rotation: 90 }), deps);

  assert.equal(result.processed, true);
  assert.equal(result.width, 2, "lebar keluaran = tinggi sumber");
  assert.equal(result.height, 4, "tinggi keluaran = lebar sumber");
});

test("preset kualitas membatasi lebar tanpa memperbesar gambar kecil", async () => {
  const big = createFakeSource(4000, 2000, () => [10, 20, 30, 255]);
  const down = await applyFilters(DUMMY_BLOB, settings({ quality: "hemat" }), depsFor(big));
  assert.equal(down.width, 1600);
  assert.equal(down.height, 800);

  const small = createFakeSource(320, 240, () => [10, 20, 30, 255]);
  const up = await applyFilters(DUMMY_BLOB, settings({ quality: "hemat" }), depsFor(small));
  // Sudah lebih kecil dari batas & tanpa filter → blob asli, tanpa pembesaran.
  assert.equal(up.processed, false);
  assert.equal(up.blob, DUMMY_BLOB);
});

test("adjustments jatuh ke jalur piksel saat ctx.filter tidak didukung", async () => {
  const source = createFakeSource(2, 2, () => [100, 100, 100, 255]);
  const deps = depsFor(source, false);

  const result = await applyFilters(DUMMY_BLOB, settings({ adjustments: { brightness: 50, contrast: 0, saturation: 0 } }), deps);

  assert.ok(result.applied.includes("adjustments"));
  const out = await outPixels(result.blob);
  const px = at(out, result.width, 0, 0);
  assert.ok(px[0]! > 100, `brightness harus menaikkan nilai, dapat ${px[0]}`);
});

test("adjustments memakai ctx.filter saat didukung browser", async () => {
  const source = createFakeSource(2, 2, () => [100, 100, 100, 255]);
  const deps = depsFor(source, true);

  const result = await applyFilters(DUMMY_BLOB, settings({ adjustments: { brightness: 20, contrast: 0, saturation: 0 } }), deps);

  assert.ok(result.applied.includes("adjustments"));
  const used = deps.canvases.flatMap((canvas) => canvas.filtersUsed);
  assert.ok(
    used.some((f) => f.includes("brightness")),
    `ctx.filter harus di-set, tercatat: ${used.join(" | ")}`,
  );
});

test("blur latar men-set ctx.filter blur pada kanvas komposit", async () => {
  const source = greenScreenSource();
  const deps = depsFor(source);

  const result = await applyFilters(
    DUMMY_BLOB,
    settings({
      chromaKey: { enabled: true, color: { r: 0, g: 255, b: 0 }, similarity: 60, smoothness: 10, spill: 0 },
      background: { mode: "blur", color: { r: 0, g: 0, b: 0 }, blur: 50 },
    }),
    deps,
  );

  assert.ok(result.applied.some((s) => s.includes("blur")), `tahap: ${result.applied.join(",")}`);
});

test("segmenter memasang mask saat latar diganti tanpa chroma key", async () => {
  const source = greenScreenSource();
  const deps = depsFor(source);
  const providers: FilterProviders = {
    segmenter: {
      async segment(s) {
        // Mask: kolom kiri = latar (0), kolom kanan = subjek (255).
        const mask = new Uint8ClampedArray(s.width * s.height);
        for (let y = 0; y < s.height; y += 1) {
          for (let x = 0; x < s.width; x += 1) {
            mask[y * s.width + x] = x === 0 ? 0 : 255;
          }
        }
        return mask;
      },
    },
  };

  const result = await applyFilters(
    DUMMY_BLOB,
    settings({ background: { mode: "color", color: { r: 30, g: 90, b: 200 }, blur: 50 } }),
    deps,
    providers,
  );

  assert.ok(result.applied.includes("segmenter"), `tahap: ${result.applied.join(",")}`);
  const out = await outPixels(result.blob);
  const left = at(out, result.width, 0, 0);
  assert.deepEqual([left[0], left[1], left[2]], [30, 90, 200], "latar (mask 0) jadi warna latar");
  const right = at(out, result.width, 1, 0);
  assert.deepEqual([right[0], right[1], right[2]], [255, 0, 0], "subjek (mask 255) tetap");
});

test("segmenter gagal → foto tetap keluar, ditandai degraded", async () => {
  const source = greenScreenSource();
  const deps = depsFor(source);
  const providers: FilterProviders = {
    segmenter: { async segment() { return null; } },
  };

  const result = await applyFilters(
    DUMMY_BLOB,
    settings({ background: { mode: "color", color: { r: 30, g: 90, b: 200 }, blur: 50 } }),
    deps,
    providers,
  );

  assert.equal(result.processed, true, "foto tetap diproses");
  assert.equal(result.degraded, true, "kegagalan segmenter harus ditandai");
  assert.equal(result.blob === DUMMY_BLOB, false, "hasil tetap berupa blob baru");
});

test("face enhance yang berhasil tercatat di applied", async () => {
  const source = greenScreenSource();
  const deps = depsFor(source);
  const providers: FilterProviders = {
    faceEnhancer: {
      async enhance(canvas) {
        return canvas; // tidak mengubah apa pun, hanya membuktikan jalurnya jalan
      },
    },
  };

  const result = await applyFilters(DUMMY_BLOB, settings({ faceEnhance: true }), deps, providers);

  assert.ok(result.applied.includes("faceEnhance"));
  assert.equal(result.degraded, false);
});

test("face enhance gagal → ditandai degraded, foto tetap keluar", async () => {
  const source = greenScreenSource();
  const deps = depsFor(source);
  const providers: FilterProviders = {
    faceEnhancer: { async enhance() { return null; } },
  };

  const result = await applyFilters(DUMMY_BLOB, settings({ faceEnhance: true }), deps, providers);

  assert.equal(result.processed, true);
  assert.equal(result.degraded, true);
});

test("decode gagal → blob asli dikembalikan (degradasi anggun)", async () => {
  const deps: FilterDeps = {
    createCanvas: (w, h) => createFakeCanvas(w, h),
    decode: async () => {
      throw new Error("bitmap rusak");
    },
  };

  const result = await applyFilters(DUMMY_BLOB, settings({ rotation: 90 }), deps);

  assert.equal(result.blob, DUMMY_BLOB);
  assert.equal(result.processed, false);
  assert.equal(result.degraded, true);
});
