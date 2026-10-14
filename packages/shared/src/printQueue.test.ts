/**
 * Tes antrean cetak (Fase 9).
 *
 * Yang diuji adalah **keputusan yang mahal kalau salah**: berapa lembar yang
 * keluar, kapan tugas boleh dicoba lagi, dan kapan ia menyerah. Semuanya
 * murni — `now` disuntik, jadi tidak ada tes yang menunggu detik nyata.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRINT_COPIES_MAX,
  PRINT_MAX_ATTEMPTS,
  applyPrintResult,
  claimNextJob,
  createPrintJob,
  createReprint,
  isPrintJobStatus,
  nextJob,
  queueOrder,
  shouldAutoPrint,
  summarizeQueue,
  type PrintJob,
} from "./printQueue.ts";

const T0 = new Date("2026-10-14T10:00:00.000Z");

function job(overrides: Partial<PrintJob> = {}): PrintJob {
  return { ...createPrintJob({ id: overrides.id ?? "pj_1", now: T0.toISOString() }, overrides.seq ?? 1), ...overrides };
}

test("isPrintJobStatus menyaring nilai asing", () => {
  assert.equal(isPrintJobStatus("queued"), true);
  assert.equal(isPrintJobStatus("failed"), true);
  assert.equal(isPrintJobStatus("cancelled"), false);
});

test("salinan dijepit ke [1, PRINT_COPIES_MAX] dan dibulatkan", () => {
  assert.equal(createPrintJob({ id: "a", now: T0.toISOString() }, 1).copies, 1);
  assert.equal(createPrintJob({ id: "b", copies: 0, now: T0.toISOString() }, 2).copies, 1);
  assert.equal(createPrintJob({ id: "c", copies: 99, now: T0.toISOString() }, 3).copies, PRINT_COPIES_MAX);
  // 2.5 dibulatkan ke 3: membulatkan ke bawah berarti tamu kehilangan lembar.
  assert.equal(createPrintJob({ id: "d", copies: 2.5, now: T0.toISOString() }, 4).copies, 3);
  assert.equal(createPrintJob({ id: "e", copies: Number.NaN, now: T0.toISOString() }, 5).copies, 1);
});

test("tugas baru selalu queued dengan attempts 0", () => {
  const created = createPrintJob({ id: "pj_1", now: T0.toISOString() }, 1);
  assert.equal(created.status, "queued");
  assert.equal(created.attempts, 0);
  assert.equal(created.nextAttemptAt, null);
  assert.equal(created.reprintOf, null);
});

test("reprint mengikuti salinan asal dan menunjuk nomor asal", () => {
  const origin = job({ id: "pj_1", seq: 3, copies: 4, status: "done" });
  const reprint = createReprint(origin, "pj_9", T0.toISOString(), 4);
  assert.equal(reprint.copies, 4);
  assert.equal(reprint.reprintOf, 3);
  assert.equal(reprint.status, "queued");
  // Tugas baru, bukan menghidupkan yang lama: riwayat lembar tetap jujur.
  assert.equal(reprint.attempts, 0);
});

test("queueOrder: printing dulu, lalu queued, nomor naik; done/failed keluar", () => {
  const list = [
    job({ id: "q2", seq: 2, status: "queued" }),
    job({ id: "p1", seq: 5, status: "printing" }),
    job({ id: "q1", seq: 1, status: "queued" }),
    job({ id: "d1", seq: 3, status: "done" }),
    job({ id: "f1", seq: 4, status: "failed" }),
  ];
  assert.deepEqual(
    queueOrder(list).map((row) => row.id),
    ["p1", "q1", "q2"],
  );
});

test("nextJob melewati tugas yang jeda retry-nya belum lewat", () => {
  const waiting = job({ id: "w", seq: 1, status: "queued", nextAttemptAt: "2026-10-14T10:00:30.000Z" });
  const ready = job({ id: "r", seq: 2, status: "queued" });
  assert.equal(nextJob([waiting, ready], T0)?.id, "r");

  // Setelah jeda lewat, yang lebih dulu antre diambil.
  const later = new Date("2026-10-14T10:01:00.000Z");
  assert.equal(nextJob([waiting, ready], later)?.id, "w");
});

test("nextAttemptAt rusak diperlakukan sebagai boleh jalan", () => {
  const broken = job({ id: "b", seq: 1, status: "queued", nextAttemptAt: "bukan tanggal" });
  assert.equal(nextJob([broken], T0)?.id, "b");
});

test("nextJob: antrean kosong → null", () => {
  assert.equal(nextJob([], T0), null);
  assert.equal(nextJob([job({ status: "done" })], T0), null);
});

test("sukses → done, attempts naik sekali", () => {
  const result = applyPrintResult(job({ attempts: 1 }), { ok: true }, T0);
  assert.equal(result.status, "done");
  assert.equal(result.attempts, 2);
  assert.equal(result.nextAttemptAt, null);
  assert.equal(result.lastError, null);
});

test("gagal → kembali queued dengan jeda tumbuh kuadrat", () => {
  const first = applyPrintResult(job({ attempts: 0 }), { ok: false, error: "kertas habis" }, T0);
  assert.equal(first.status, "queued");
  assert.equal(first.attempts, 1);
  assert.equal(first.lastError, "kertas habis");
  // 1 dtk setelah T0.
  assert.equal(Date.parse(first.nextAttemptAt as string) - T0.getTime(), 1000);

  const second = applyPrintResult(job({ attempts: 1 }), { ok: false, error: "kertas habis" }, T0);
  // 4 dtk: percobaan ke-2.
  assert.equal(Date.parse(second.nextAttemptAt as string) - T0.getTime(), 4000);
});

test("setelah PRINT_MAX_ATTEMPTS gagal, tugas menyerah", () => {
  let current = job({ attempts: 0 });
  for (let i = 0; i < PRINT_MAX_ATTEMPTS; i += 1) {
    current = applyPrintResult(current, { ok: false, error: `gagal ${i + 1}` }, T0);
  }
  assert.equal(current.status, "failed");
  assert.equal(current.attempts, PRINT_MAX_ATTEMPTS);
  assert.equal(current.nextAttemptAt, null);
  assert.equal(current.lastError, `gagal ${PRINT_MAX_ATTEMPTS}`);
});

test("claimNextJob menandai printing dan mengembalikan daftar baru", () => {
  const jobs = [job({ id: "a", seq: 1, status: "queued" }), job({ id: "b", seq: 2, status: "queued" })];
  const claimed = claimNextJob(jobs, T0);

  assert.equal(claimed.job?.id, "a");
  assert.equal(claimed.job?.status, "printing");
  // Daftar asli tidak diubah (imutabilitas), dan hanya satu yang jadi printing.
  assert.equal(jobs[0]?.status, "queued");
  assert.equal(claimed.jobs.filter((row) => row.status === "printing").length, 1);
});

test("claimNextJob saat kosong tidak mengubah apa pun", () => {
  const jobs = [job({ id: "a", status: "done" })];
  const claimed = claimNextJob(jobs, T0);
  assert.equal(claimed.job, null);
  assert.deepEqual(claimed.jobs, jobs);
});

test("summarizeQueue menghitung lembar hanya dari tugas done", () => {
  const summary = summarizeQueue([
    job({ id: "a", copies: 2, status: "done" }),
    job({ id: "b", copies: 3, status: "done" }),
    job({ id: "c", copies: 5, status: "queued" }),
    job({ id: "d", copies: 1, status: "printing" }),
    job({ id: "e", copies: 4, status: "failed" }),
  ]);
  assert.deepEqual(summary, { queued: 1, printing: 1, done: 2, failed: 1, sheetsPrinted: 5 });
});

test("shouldAutoPrint butuh dua syarat", () => {
  assert.equal(shouldAutoPrint({ enabled: true, printerAvailable: true }), true);
  // Menyalakan auto-print tanpa printer = 3 percobaan sia-sia tiap sesi.
  assert.equal(shouldAutoPrint({ enabled: true, printerAvailable: false }), false);
  assert.equal(shouldAutoPrint({ enabled: false, printerAvailable: true }), false);
});
