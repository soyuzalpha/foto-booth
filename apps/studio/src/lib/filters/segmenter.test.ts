import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SEGMENT_THRESHOLD,
  createSegmenterProvider,
  rawToMask,
  type RawSegmentResult,
  type SegmenterFactory,
} from "./segmenter.ts";
import type { FilterSource } from "./applyFilters.ts";

function source(width: number, height: number): FilterSource {
  return { image: { width, height }, width, height };
}

test("rawToMask memakai confidence dengan ambang", () => {
  const raw: RawSegmentResult = {
    confidence: new Float32Array([0.9, 0.1, 0.5, 0.49]),
    width: 2,
    height: 2,
  };
  const mask = rawToMask(raw, 0.5, 256);
  assert.ok(mask !== null);
  assert.deepEqual([...mask.data], [255, 0, 255, 0]);
  assert.equal(mask.width, 2);
  assert.equal(mask.height, 2);
});

test("rawToMask membaca bentuk NYATA MediaPipe (confidenceMasks: MPMask[])", () => {
  // MediaPipe mengembalikan objek MPMask, bukan array datar. Regresi pernah
  // terjadi: kode membaca `raw.confidence` yang tidak pernah ada → mask selalu
  // null → semua mode latar AI mati diam-diam.
  const raw: RawSegmentResult = {
    confidenceMasks: [
      {
        getAsFloat32Array: () => new Float32Array([0.9, 0.1, 0.8, 0.2]),
        width: 2,
        height: 2,
      },
    ],
  };
  const mask = rawToMask(raw, 0.5, 256);
  assert.ok(mask !== null);
  assert.deepEqual([...mask.data], [255, 0, 255, 0]);
  assert.equal(mask.width, 2);
  assert.equal(mask.height, 2);
});

test("rawToMask memakai categoryMask MPMask bila confidence tidak ada", () => {
  const raw: RawSegmentResult = {
    categoryMask: { getAsUint8Array: () => new Uint8Array([0, 1, 1, 0]), width: 2, height: 2 },
  };
  const mask = rawToMask(raw, 0.5, 256);
  assert.ok(mask !== null);
  assert.deepEqual([...mask.data], [0, 255, 255, 0]);
});

test("rawToMask jatuh ke category bila confidence absen (1 = subjek)", () => {
  const raw: RawSegmentResult = { category: new Uint8Array([0, 1, 1, 0]), width: 2, height: 2 };
  const mask = rawToMask(raw, 0.5, 256);
  assert.ok(mask !== null);
  assert.deepEqual([...mask.data], [0, 255, 255, 0]);
});

test("rawToMask menolak hasil kosong / bentuk tak konsisten", () => {
  assert.equal(rawToMask({}, 0.5, 256), null);
  assert.equal(rawToMask({ confidence: new Float32Array(3), width: 2, height: 2 }, 0.5, 256), null);
});

test("rawToMask memakai modelSize kalau dimensi tidak dilaporkan", () => {
  const mask = rawToMask({ confidence: new Float32Array(4) }, 0.5, 2);
  assert.ok(mask !== null);
  assert.equal(mask.width, 2);
  assert.equal(mask.height, 2);
});

test("segment mengembalikan mask seukuran gambar sumber (mask model di-resize)", async () => {
  const factory: SegmenterFactory = {
    create: () => ({
      segment: () => ({
        confidence: new Float32Array([1, 1, 1, 0]), // 2×2: 3 subjek, 1 latar
        width: 2,
        height: 2,
      }),
    }),
  };
  const provider = createSegmenterProvider({ load: async () => factory });

  const mask = await provider.segment(source(4, 4));
  assert.ok(mask !== null);
  assert.equal(mask.length, 16);
  // 3 dari 4 kuadran (2×2 blok) adalah subjek → 12 piksel 255.
  const subject = [...mask].filter((v) => v === 255).length;
  assert.equal(subject, 12);
});

test("gagal memuat model → segment null, tidak melempar, tidak mencoba ulang", async () => {
  let loads = 0;
  const provider = createSegmenterProvider({
    load: async () => {
      loads += 1;
      return null;
    },
  });
  assert.equal(await provider.segment(source(2, 2)), null);
  assert.equal(await provider.segment(source(2, 2)), null);
  assert.equal(loads, 1, "gagal berulang hanya memperlambat kiosk");
  assert.equal(provider.ready, false);
});

test("segmenter melempar saat segment → null (pipeline lanjut tanpa mask)", async () => {
  const provider = createSegmenterProvider({
    load: async () => ({
      create: () => ({
        segment: () => {
          throw new Error("GPU hilang");
        },
      }),
    }),
  });
  assert.equal(await provider.segment(source(2, 2)), null);
});

test("dispose menutup instance & mengizinkan pemuatan ulang", async () => {
  let closed = 0;
  let created = 0;
  const provider = createSegmenterProvider({
    load: async () => ({
      create: () => {
        created += 1;
        return {
          segment: () => ({ confidence: new Float32Array([1]), width: 1, height: 1 }),
          close: () => {
            closed += 1;
          },
        };
      },
    }),
  });
  await provider.segment(source(1, 1));
  assert.equal(created, 1);
  provider.dispose();
  assert.equal(closed, 1);
  assert.equal(provider.ready, false);
  await provider.segment(source(1, 1));
  assert.equal(created, 2);
});

test("threshold default diekspor sebagai angka", () => {
  assert.equal(typeof DEFAULT_SEGMENT_THRESHOLD, "number");
  assert.equal(DEFAULT_SEGMENT_THRESHOLD, 0.5);
});
