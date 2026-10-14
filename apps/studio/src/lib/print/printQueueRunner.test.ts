/**
 * Tes runner antrean cetak (Fase 9, #44 & #46).
 *
 * Yang dibuktikan di sini bukan "fungsinya jalan", tapi janji-janji yang mahal
 * kalau salah: auto-print tanpa operator berarti cetakan yang gagal tidak
 * terlihat siapa pun. Printer & penyimpanan disuntikkan palsu supaya setiap
 * skenario bisa dipaksa terjadi, bukan ditunggu kebetulan.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PRINT_MAX_ATTEMPTS } from "@foto-booth/shared";

import { PRINT_QUEUE_KEY, createPrintQueueRunner, type PrintFn } from "./printQueueRunner.ts";
import type { KeyValueStore } from "../capture/rememberedDevice.ts";

/** Jam palsu yang bisa dimajukan supaya jeda retry bisa dilewati. */
function fakeClock(start = new Date("2026-10-14T10:00:00.000Z")) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number): void {
      current = new Date(current.getTime() + ms);
    },
  };
}

/** Penyimpanan in-memory yang bisa dipakai ulang untuk menguji persistensi. */
function fakeStore(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  const store: KeyValueStore = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
  return { store, map };
}

/** Pencetak palsu yang mencatat setiap tugas dan bisa dipaksa gagal. */
function fakePrinter(failures = 0) {
  const printed: number[] = [];
  let remainingFailures = failures;
  const print: PrintFn = async (job) => {
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error("printer offline");
    }
    printed.push(job.seq);
  };
  return { print, printed };
}

test("job berhasil → status done & lembar terhitung", async () => {
  const clock = fakeClock();
  const printer = fakePrinter();
  const runner = createPrintQueueRunner({ print: printer.print, now: clock.now });

  const job = runner.enqueue({ id: "job-1", copies: 1 });
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0);

  assert.equal(await runner.runNext(), true);
  assert.deepEqual(printer.printed, [1]);
  assert.equal(runner.summary().done, 1);
  assert.equal(runner.summary().sheetsPrinted, 1);
  assert.equal(runner.list().length, 0, "tugas selesai keluar dari urutan pengerjaan");
});

test("copies dihormati: 3 salinan → 3 lembar terhitung", async () => {
  const clock = fakeClock();
  const printer = fakePrinter();
  const runner = createPrintQueueRunner({ print: printer.print, now: clock.now });

  runner.enqueue({ id: "job-2", copies: 3 });
  await runner.runNext();

  assert.equal(runner.summary().sheetsPrinted, 3);
});

test("cetak gagal 1x lalu berhasil → tetap jalan, attempts naik", async () => {
  const clock = fakeClock();
  const printer = fakePrinter(1);
  const runner = createPrintQueueRunner({ print: printer.print, now: clock.now });

  runner.enqueue({ id: "job-3", copies: 1 });

  assert.equal(await runner.runNext(), true);
  assert.deepEqual(printer.printed, [], "percobaan pertama gagal");
  const afterFail = runner.list();
  assert.equal(afterFail.length, 1, "tugas gagal sementara tetap di antrean");
  assert.equal(afterFail[0]?.attempts, 1);
  assert.equal(afterFail[0]?.status, "queued");
  assert.equal(afterFail[0]?.lastError, "printer offline");

  // Jeda retry belum lewat → belum boleh jalan.
  assert.equal(await runner.runNext(), false);

  clock.advance(60_000);
  assert.equal(await runner.runNext(), true);
  assert.deepEqual(printer.printed, [1]);
  assert.equal(runner.summary().done, 1);
});

test("gagal terus → failed setelah PRINT_MAX_ATTEMPTS, tidak hilang", async () => {
  const clock = fakeClock();
  const printer = fakePrinter(99);
  const runner = createPrintQueueRunner({ print: printer.print, now: clock.now });

  runner.enqueue({ id: "job-4", copies: 1 });

  for (let attempt = 1; attempt <= PRINT_MAX_ATTEMPTS; attempt += 1) {
    clock.advance(600_000);
    assert.equal(await runner.runNext(), true, `percobaan ke-${attempt} dijalankan`);
  }

  assert.equal(await runner.runNext(), false, "setelah batas, tidak ada yang dicoba lagi");
  const summary = runner.summary();
  assert.equal(summary.failed, 1);
  assert.equal(summary.sheetsPrinted, 0);
  assert.equal(summary.queued, 0);
  assert.deepEqual(printer.printed, []);
});

test("satu pekerjaan pada satu waktu: runNext saat sibuk tidak menyerobot", async () => {
  const clock = fakeClock();
  const printed: number[] = [];
  const gate: { release: (() => void) | null } = { release: null };
  const print: PrintFn = async (job) => {
    await new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    printed.push(job.seq);
  };
  const runner = createPrintQueueRunner({ print, now: clock.now });

  runner.enqueue({ id: "job-5a" });
  runner.enqueue({ id: "job-5b" });

  const first = runner.runNext();
  assert.equal(await runner.runNext(), false, "yang kedua ditolak selama yang pertama jalan");

  gate.release?.();
  assert.equal(await first, true);
  assert.deepEqual(printed, [1]);
  assert.equal(runner.summary().printing, 0);
});

test("reprint membuat tugas baru yang menunjuk asal, aslinya tetap", async () => {
  const clock = fakeClock();
  const printer = fakePrinter();
  const runner = createPrintQueueRunner({ print: printer.print, now: clock.now });

  runner.enqueue({ id: "job-6", copies: 2 });
  await runner.runNext();
  assert.equal(runner.summary().done, 1);

  const reprint = runner.reprint(1);
  assert.notEqual(reprint, null);
  assert.equal(reprint?.reprintOf, 1, "menunjuk nomor urut tugas asal");
  assert.equal(reprint?.copies, 2, "salinan mengikuti asal");
  assert.equal(runner.summary().done, 1, "aslinya tidak dihidupkan lagi");

  await runner.runNext();
  assert.equal(runner.summary().done, 2);
  assert.equal(runner.summary().sheetsPrinted, 4);
});

test("reprint nomor urut yang tidak ada → null, tidak ada tugas hantu", () => {
  const clock = fakeClock();
  const printer = fakePrinter();
  const runner = createPrintQueueRunner({ print: printer.print, now: clock.now });

  assert.equal(runner.reprint(99), null);
  assert.equal(runner.summary().queued, 0);
});

test("antrean bertahan lewat penyimpanan: reload tidak kehilangan tugas", async () => {
  const clock = fakeClock();
  const { store } = fakeStore();
  const printer = fakePrinter();

  const first = createPrintQueueRunner({ print: printer.print, now: clock.now, store });
  first.enqueue({ id: "job-7", copies: 1 });
  assert.notEqual(store.getItem(PRINT_QUEUE_KEY), null, "tersimpan setelah enqueue");

  // Runner baru membaca ulang dari penyimpanan yang sama.
  const second = createPrintQueueRunner({ print: printer.print, now: clock.now, store });
  assert.equal(second.summary().queued, 1, "tugas queued selamat dari reload");
  assert.equal(await second.runNext(), true);
  assert.deepEqual(printer.printed, [1]);
});

test("nomor urut lanjut setelah reload, tidak menabrak tugas lama", async () => {
  const clock = fakeClock();
  const { store } = fakeStore();
  const printer = fakePrinter();

  const first = createPrintQueueRunner({ print: printer.print, now: clock.now, store });
  first.enqueue({ id: "job-8a" });

  const second = createPrintQueueRunner({ print: printer.print, now: clock.now, store });
  const next = second.enqueue({ id: "job-8b" });

  assert.equal(next.seq, 2, "seq tidak mengulang dari 1");
});

test("baris rusak di penyimpanan dibuang, sisanya tetap dipakai", () => {
  const clock = fakeClock();
  const printer = fakePrinter();
  const good = {
    id: "job-9",
    seq: 1,
    status: "queued",
    copies: 1,
    attempts: 0,
    reprintOf: null,
    nextAttemptAt: null,
    lastError: null,
    createdAt: "2026-10-14T09:00:00.000Z",
    updatedAt: "2026-10-14T09:00:00.000Z",
  };
  const { store } = fakeStore({
    [PRINT_QUEUE_KEY]: JSON.stringify([good, { id: "rusak" }, "bukan objek"]),
  });

  const runner = createPrintQueueRunner({ print: printer.print, now: clock.now, store });
  assert.equal(runner.summary().queued, 1, "hanya baris valid yang bertahan");
});

test("penyimpanan berisi JSON rusak tidak menjatuhkan runner", () => {
  const clock = fakeClock();
  const printer = fakePrinter();
  const { store } = fakeStore({ [PRINT_QUEUE_KEY]: "{bukan json" });

  const runner = createPrintQueueRunner({ print: printer.print, now: clock.now, store });
  assert.equal(runner.summary().queued, 0);
  assert.equal(runner.enqueue({ id: "job-10" }).seq, 1);
});

test("auto-print nonaktif → tidak ada yang tercetak otomatis", async () => {
  const clock = fakeClock();
  const printer = fakePrinter();
  const runner = createPrintQueueRunner({ print: printer.print, now: clock.now });

  assert.equal(await runner.autoPrint({ enabled: false, id: "job-11" }), false);
  assert.deepEqual(printer.printed, []);
  assert.equal(runner.summary().queued, 0, "tidak ada tugas yang dibuat");
});

test("auto-print menyala tapi printer tidak ada → tugas tetap queued, tidak hilang", async () => {
  const clock = fakeClock();
  const printer = fakePrinter();
  const runner = createPrintQueueRunner({
    print: printer.print,
    now: clock.now,
    printerAvailable: () => false,
  });

  assert.equal(await runner.autoPrint({ enabled: true, id: "job-12" }), false);
  assert.deepEqual(printer.printed, [], "tidak menghabiskan percobaan untuk printer yang mati");
  assert.equal(runner.summary().queued, 0, "belum diantrekan karena printernya tidak ada");
});

test("auto-print menyala & printer ada → tercetak tanpa langkah operator", async () => {
  const clock = fakeClock();
  const printer = fakePrinter();
  const runner = createPrintQueueRunner({
    print: printer.print,
    now: clock.now,
    printerAvailable: () => true,
  });

  assert.equal(await runner.autoPrint({ enabled: true, copies: 2, id: "job-13" }), true);
  assert.deepEqual(printer.printed, [1]);
  assert.equal(runner.summary().sheetsPrinted, 2);
});

test("clearFinished membuang done/failed, menyisakan yang belum beres", async () => {
  const clock = fakeClock();
  const printer = fakePrinter();
  const runner = createPrintQueueRunner({ print: printer.print, now: clock.now });

  runner.enqueue({ id: "job-14a" });
  await runner.runNext();
  runner.enqueue({ id: "job-14b" });

  runner.clearFinished();
  assert.equal(runner.summary().done, 0);
  assert.equal(runner.summary().queued, 1);
});

test("enqueue tanpa penyimpanan tetap bekerja (memori saja)", async () => {
  const clock = fakeClock();
  const printer = fakePrinter();
  const runner = createPrintQueueRunner({ print: printer.print, now: clock.now, store: null });

  runner.enqueue({ id: "job-15" });
  assert.equal(await runner.runNext(), true);
  assert.equal(runner.summary().done, 1);
});

test("copies di luar rentang dijepit, bukan ditolak", () => {
  const clock = fakeClock();
  const printer = fakePrinter();
  const runner = createPrintQueueRunner({ print: printer.print, now: clock.now });

  assert.equal(runner.enqueue({ id: "job-16a", copies: 99 }).copies, 10);
  assert.equal(runner.enqueue({ id: "job-16b", copies: 0 }).copies, 1);
  assert.equal(runner.enqueue({ id: "job-16c", copies: 2.5 }).copies, 3, "dibulatkan ke atas, tamu tidak kehilangan lembar");
});
