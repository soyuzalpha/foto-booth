import test from "node:test";
import assert from "node:assert/strict";

import {
  LOW_QUOTA_BYTES,
  formatBytes,
  parseDebugFlag,
  summarizeStorageReport,
  type StorageReport,
} from "./debugMode.ts";

test("parseDebugFlag membaca ?debug=1 dan varian truthy", () => {
  for (const q of ["?debug=1", "?debug=true", "?debug=on", "?debug=YES", "?a=1&debug=1"]) {
    assert.equal(parseDebugFlag(q, null), true, q);
  }
});

test("parseDebugFlag menolak nilai falsy & flag tak dikenal", () => {
  for (const q of ["?debug=0", "?debug=false", "?debug=off", "?x=1", "", "?"]) {
    assert.equal(parseDebugFlag(q, null), false, q);
  }
});

test("query string menang atas localStorage (bisa mematikan sementara)", () => {
  assert.equal(parseDebugFlag("?debug=0", "1"), false, "?debug=0 harus mematikan walau tersimpan");
  assert.equal(parseDebugFlag("?debug=1", null), true);
});

test("tanpa query, nilai localStorage yang dipakai", () => {
  assert.equal(parseDebugFlag("", "1"), true);
  assert.equal(parseDebugFlag("", "on"), true);
  assert.equal(parseDebugFlag("", "0"), false);
  assert.equal(parseDebugFlag("", null), false);
});

test("formatBytes memakai koma desimal & satuan yang benar", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1,0 KB");
  assert.equal(formatBytes(1536), "1,5 KB");
  assert.equal(formatBytes(1024 * 1024), "1,0 MB");
  assert.equal(formatBytes(1024 * 1024 * 1024), "1,0 GB");
  assert.equal(formatBytes(null), "tidak diketahui");
});

function report(overrides: Partial<StorageReport> = {}): StorageReport {
  return {
    persisted: true,
    usageBytes: 10 * 1024 * 1024,
    quotaBytes: 2 * 1024 * 1024 * 1024,
    cacheNames: ["fb-models"],
    serviceWorkerActive: true,
    modelCacheReady: true,
    ...overrides,
  };
}

test("summarizeStorageReport: kondisi sehat tidak memberi peringatan", () => {
  const { warnings } = summarizeStorageReport(report());
  assert.deepEqual(warnings, []);
});

test("summarizeStorageReport: storage tidak persisten & kuota rendah diperingatkan", () => {
  const { warnings } = summarizeStorageReport(
    report({ persisted: false, quotaBytes: LOW_QUOTA_BYTES - 1 }),
  );
  assert.ok(warnings.some((w) => w.includes("belum persisten")), warnings.join(" | "));
  assert.ok(warnings.some((w) => w.includes("Kuota storage rendah")), warnings.join(" | "));
});

test("summarizeStorageReport: service worker mati & model belum di-cache terlihat di baris", () => {
  const { lines, warnings } = summarizeStorageReport(
    report({ serviceWorkerActive: false, modelCacheReady: false, cacheNames: [] }),
  );
  assert.ok(lines.some((l) => l.includes("Service worker: tidak aktif")));
  assert.ok(lines.some((l) => l.includes("Cache: belum ada")));
  assert.ok(lines.some((l) => l.includes("Model AI: belum di-cache")));
  assert.ok(warnings.some((w) => w.includes("offline")));
});

test("summarizeStorageReport: API storage tak ada → 'tidak didukung', bukan crash", () => {
  const { lines } = summarizeStorageReport(report({ persisted: null, usageBytes: null, quotaBytes: null }));
  assert.ok(lines.some((l) => l.includes("tidak didukung browser")));
  assert.ok(lines.some((l) => l.includes("Kuota: tidak diketahui")));
});
