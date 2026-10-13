/**
 * Pemilihan jalur filter (Worker vs main thread).
 *
 * Yang dijaga di sini bukan "apakah Worker jalan" — itu urusan browser — tapi
 * **kapan foto boleh dilempar ke Worker dan kapan tidak**. Salah pilih di sini
 * berbahaya dua arah: mengirim pekerjaan berprovider ke Worker berarti model AI
 * dimuat ulang di thread lain (lambat, boros memori), sedangkan menahan
 * pekerjaan berat di main thread bikin kiosk nge-freeze di depan tamu.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { canRunOffThread, runFilters, WorkerFilter, type OffThreadFilterResult } from "./filterOffThread.ts";
import { normalizeFilterSettings } from "./filterSettingsStore.ts";
import type { FilterDeps } from "./applyFilters.ts";
import { createFakeSource, fakeFilterDeps } from "../testing/fakeCanvas.ts";

/** `FilterSettings` lengkap dari partial — lewat normalisasi, jadi nilainya valid. */
function settings(patch: unknown = {}): ReturnType<typeof normalizeFilterSettings> {
  return normalizeFilterSettings(patch);
}

const deps: FilterDeps = fakeFilterDeps(createFakeSource(4, 4));

/** Worker palsu: langsung membalas satu hasil sukses. */
function fakeWorker(
  reply: (id: number) => unknown,
): Worker & { posted: unknown[]; terminated: boolean } {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const posted: unknown[] = [];
  const worker = {
    posted,
    terminated: false,
    postMessage(message: unknown) {
      posted.push(message);
      const id = (message as { id: number }).id;
      // Balas asinkron, seperti Worker sungguhan.
      queueMicrotask(() => {
        for (const listener of listeners["message"] ?? []) listener({ data: reply(id) });
      });
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      (listeners[type] ??= []).push(listener);
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return worker as unknown as Worker & { posted: unknown[]; terminated: boolean };
}

test("canRunOffThread: tanpa tahap apa pun → tidak perlu Worker", () => {
  assert.equal(canRunOffThread(settings()), false);
});

test("canRunOffThread: rotasi/chroma key/adjustments → boleh off-thread", () => {
  assert.equal(canRunOffThread(settings({ rotation: 90 })), true);
  assert.equal(canRunOffThread(settings({ chromaKey: { enabled: true } })), true);
  assert.equal(canRunOffThread(settings({ adjustments: { brightness: 20 } })), true);
});

test("canRunOffThread: butuh model (segmenter/face enhance) → main thread", () => {
  // Latar diganti tanpa chroma key → butuh segmenter MediaPipe.
  assert.equal(canRunOffThread(settings({ background: { mode: "blur" } })), false);
  assert.equal(canRunOffThread(settings({ background: { mode: "color" } })), false);
  assert.equal(canRunOffThread(settings({ faceEnhance: true })), false);
  // Latar AI selalu main thread (gambar latar dimuat provider di sana).
  assert.equal(canRunOffThread(settings({ background: { mode: "ai" } })), false);
});

test("canRunOffThread: latar diwarnai pakai chroma key → tetap boleh off-thread", () => {
  // Chroma key menyediakan mask sendiri, jadi segmenter tidak dibutuhkan.
  assert.equal(canRunOffThread(settings({ chromaKey: { enabled: true }, background: { mode: "color" } })), true);
});

test("runFilters memakai Worker untuk pekerjaan tanpa provider", async () => {
  const worker = fakeWorker((id) => ({
    id,
    ok: true,
    blob: new Blob(["hasil"]),
    width: 4,
    height: 6,
    processed: true,
    degraded: false,
    applied: ["rotation"],
  }));

  const result = await runFilters(new Blob(["asli"]), settings({ rotation: 90 }), {
    deps,
    createWorker: () => worker,
  });

  assert.equal(result.offThread, true);
  assert.equal(result.processed, true);
  assert.deepEqual(result.applied, ["rotation"]);
  assert.equal(result.width, 4);
  assert.equal(worker.posted.length, 1);
  assert.equal(worker.terminated, true, "Worker sekali pakai harus dibuang");
});

test("runFilters tidak membangun Worker kalau tidak ada kerja", async () => {
  let built = 0;
  const result = await runFilters(new Blob(["asli"]), settings(), {
    deps,
    createWorker: () => {
      built += 1;
      return fakeWorker((id) => ({ id, ok: true, blob: new Blob([]), width: 0, height: 0, processed: false, degraded: false, applied: [] }));
    },
  });

  assert.equal(built, 0, "tanpa filter, Worker tidak perlu dibangun");
  assert.equal(result.offThread, false);
  assert.equal(result.processed, false);
});

test("runFilters menahan pekerjaan berprovider di main thread", async () => {
  let built = 0;
  const result = await runFilters(new Blob(["asli"]), settings({ faceEnhance: true }), {
    deps,
    createWorker: () => {
      built += 1;
      return fakeWorker((id) => ({ id, ok: true, blob: new Blob([]), width: 0, height: 0, processed: false, degraded: false, applied: [] }));
    },
  });

  assert.equal(built, 0, "face enhance hidup di main thread");
  assert.equal(result.offThread, false);
});

test("Worker gagal → jatuh ke main thread, lapor lewat onFallback, foto tetap keluar", async () => {
  const fallback: string[] = [];
  const worker = fakeWorker((id) => ({ id, ok: false, error: "OffscreenCanvas tidak ada" }));

  const result = await runFilters(new Blob(["asli"]), settings({ rotation: 180 }), {
    deps,
    createWorker: () => worker,
    onFallback: (reason) => fallback.push(reason),
  });

  assert.equal(result.offThread, false);
  assert.deepEqual(fallback, ["OffscreenCanvas tidak ada"]);
  // Jalur sinkron dijalankan — bukan hasil kosong.
  assert.equal(result.blob instanceof Blob, true);
});

test("WorkerFilter menolak semua permintaan yang menggantung saat dibuang", async () => {
  const worker = fakeWorker(() => ({ id: 0, ok: true, blob: new Blob([]), width: 0, height: 0, processed: false, degraded: false, applied: [] }));
  const filter = new WorkerFilter(worker);

  const pending = filter.run(new Blob(["x"]), settings({ rotation: 90 }));
  filter.dispose();

  await assert.rejects(pending, /dibuang/);
});

test("runFilters selalu mengembalikan hasil bertipe hasil, tidak pernah melempar", async () => {
  const result: OffThreadFilterResult = await runFilters(new Blob(["asli"]), settings({ rotation: 90 }), {
    deps,
    createWorker: () => null,
  });
  assert.equal(result.offThread, false);
  assert.equal(typeof result.processed, "boolean");
});
