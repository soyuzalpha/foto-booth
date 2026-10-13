/**
 * Tes pengumpul laporan storage.
 *
 * Yang dijaga: panel debug **tidak boleh rusak** gara-gara browser yang API-nya
 * beda. Tiap sumber di sini diuji dalam tiga keadaan — ada, tidak ada, dan
 * melempar — karena itulah bedanya browser sungguhan.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { collectStorageReport, type ReportSources } from "./storageReport.ts";
import { DEFAULT_FACE_MODEL } from "../filters/faceEnhance.ts";

function sources(overrides: Partial<ReportSources> = {}): ReportSources {
  return {
    storage: {
      persisted: async () => true,
      estimate: async () => ({ usage: 1024, quota: 4096 }),
    },
    caches: { keys: async () => ["fb-models", "fb-app-shell"] },
    serviceWorkerActive: true,
    modelCache: { has: async (name) => name === DEFAULT_FACE_MODEL },
    ...overrides,
  };
}

test("laporan lengkap terbaca apa adanya", async () => {
  const report = await collectStorageReport(sources());
  assert.deepEqual(report, {
    persisted: true,
    usageBytes: 1024,
    quotaBytes: 4096,
    cacheNames: ["fb-app-shell", "fb-models"],
    serviceWorkerActive: true,
    modelCacheReady: true,
  });
});

test("tanpa API storage → null, bukan lempar", async () => {
  const report = await collectStorageReport(sources({ storage: undefined }));
  assert.equal(report.persisted, null);
  assert.equal(report.usageBytes, null);
  assert.equal(report.quotaBytes, null);
});

test("API storage yang melempar → 'tidak diketahui', bukan crash", async () => {
  const report = await collectStorageReport(
    sources({
      storage: {
        persisted: async () => {
          throw new Error("SecurityError");
        },
        estimate: async () => {
          throw new Error("SecurityError");
        },
      },
    }),
  );
  assert.equal(report.persisted, null);
  assert.equal(report.usageBytes, null);
});

test("estimate tanpa angka → null, bukan 0 (0 berarti 'penuh')", async () => {
  const report = await collectStorageReport(
    sources({ storage: { persisted: async () => false, estimate: async () => ({}) } }),
  );
  assert.equal(report.usageBytes, null);
  assert.equal(report.quotaBytes, null);
  assert.equal(report.persisted, false);
});

test("Cache Storage tidak ada → daftar kosong", async () => {
  const report = await collectStorageReport(sources({ caches: null }));
  assert.deepEqual(report.cacheNames, []);
});

test("`caches.keys` yang melempar → daftar kosong", async () => {
  const report = await collectStorageReport(
    sources({
      caches: {
        keys: async () => {
          throw new Error("gagal");
        },
      },
    }),
  );
  assert.deepEqual(report.cacheNames, []);
});

test("model wajah belum di-cache → modelCacheReady false", async () => {
  const report = await collectStorageReport(sources({ modelCache: { has: async () => false } }));
  assert.equal(report.modelCacheReady, false);
});

test("tanpa modelCache → modelCacheReady false (bukan crash)", async () => {
  const report = await collectStorageReport(sources({ modelCache: null }));
  assert.equal(report.modelCacheReady, false);
});

test("nama model kustom dipakai untuk menentukan siap-offline", async () => {
  const report = await collectStorageReport(
    sources({
      modelNames: ["lain.onnx"],
      modelCache: { has: async (name) => name === "lain.onnx" },
    }),
  );
  assert.equal(report.modelCacheReady, true);
});

test("daftar nama model kosong → tidak ada yang dianggap siap", async () => {
  const report = await collectStorageReport(
    sources({ modelNames: [], modelCache: { has: async () => true } }),
  );
  assert.equal(report.modelCacheReady, false);
});

test("laporan bisa langsung diringkas tanpa perlakuan khusus", async () => {
  const { summarizeStorageReport } = await import("./debugMode.ts");
  const report = await collectStorageReport(sources({ serviceWorkerActive: false }));
  const { warnings } = summarizeStorageReport(report);
  assert.ok(warnings.some((line) => line.includes("Service worker")));
});
