/**
 * Runner antrean cetak (Fase 9, FEATURE-MATRIX #44 & #46).
 *
 * `packages/shared/src/printQueue.ts` memutuskan *apa* yang harus terjadi —
 * salinan, jeda retry, kapan menyerah, urutan pengerjaan. Berkas ini yang
 * menjalankannya: memegang daftar tugas, memanggil printer, menyimpan hasil.
 *
 * **Kenapa printer disuntikkan, bukan dipanggil langsung.** `printBrowser.ts`
 * butuh `window`, `document`, dan iframe. Kalau runner memanggilnya langsung,
 * setiap janji di sini ("gagal 1x lalu berhasil tetap jalan", "menyerah setelah
 * 3 percobaan") hanya bisa dibuktikan dengan browser sungguhan. Dengan
 * `print` sebagai dependensi, tesnya murni dan cepat.
 *
 * **Kenapa satu pekerjaan jalan pada satu waktu.** Kiosk melayani satu tamu
 * sekaligus; menembak dua `window.print()` berbarengan membuat dialog cetak
 * saling menimpa dan hasilnya tidak bisa dipastikan. Runner menjaga satu
 * tugas `printing` — dipanggil lagi saat sibuk, ia tidak menyerobot.
 *
 * **Kenapa antrean disimpan.** Kiosk bisa ke-reload di tengah acara. Tugas
 * yang sudah `queued` tapi belum tercetak tidak boleh hilang hanya karena
 * halaman di-refresh.
 */

import {
  PRINT_COPIES_MAX,
  applyPrintResult,
  claimNextJob,
  createPrintJob,
  createReprint,
  queueOrder,
  shouldAutoPrint,
  summarizeQueue,
  type CreatePrintJobInput,
  type PrintJob,
  type PrintQueueSummary,
} from "@foto-booth/shared";

import type { KeyValueStore } from "../capture/rememberedDevice.ts";

/** Kunci penyimpanan; diekspor supaya tes & panel debug menyebut hal yang sama. */
export const PRINT_QUEUE_KEY = "foto-booth:print-queue";

/**
 * Pencetak yang disuntikkan. Menerima tugas dan mengembalikan janji:
 * selesai = lembar keluar, `throw` = gagal (pesannya ditampilkan operator).
 */
export type PrintFn = (job: PrintJob) => Promise<void>;

export interface PrintQueueRunnerOptions {
  print: PrintFn;
  /** Penyimpanan opsional; `null` = antrean hanya hidup di memori. */
  store?: KeyValueStore | null;
  /** Jam, injectable supaya tes tidak menunggu detik nyata. */
  now?: () => Date;
  /** Pembuat id, injectable supaya tes bisa memakai id tetap. */
  nextId?: () => string;
  /** Apakah printer tersedia; default selalu `true` (printer disuntikkan). */
  printerAvailable?: () => boolean;
}

export interface PrintQueueRunner {
  /** Tambah tugas baru; mengembalikan tugasnya. */
  enqueue(input: { id?: string; copies?: number }): PrintJob;
  /** Cetak tugas berikutnya yang siap. `false` kalau tidak ada / sedang sibuk. */
  runNext(): Promise<boolean>;
  /**
   * Cetak otomatis kalau auto-print menyala **dan** printer ada.
   * `false` = tidak mencetak, dan tugas tetap `queued` (tidak hilang).
   */
  autoPrint(input: { enabled: boolean; copies?: number; id?: string }): Promise<boolean>;
  /** Antrekan ulang tugas yang sudah selesai/gagal. Tugas asli tidak diubah. */
  reprint(seq: number, options?: { copies?: number }): PrintJob | null;
  /** Buang tugas `done` & `failed` dari daftar (riwayat sudah tidak dibutuhkan). */
  clearFinished(): void;
  /** Daftar tugas, urutan pengerjaan lebih dulu. */
  list(): PrintJob[];
  /** Ringkasan satu baris untuk operator. */
  summary(): PrintQueueSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Baca antrean tersimpan.
 *
 * Setiap baris divalidasi sendiri: satu baris rusak dibuang, sisanya tetap
 * dipakai. Antrean yang tidak bisa dibaca sama sekali berarti acara kehilangan
 * tugas cetak, jadi lebih baik menyelamatkan yang bisa dibaca.
 */
function loadJobs(store: KeyValueStore | null): PrintJob[] {
  if (store === null) return [];
  try {
    const raw = store.getItem(PRINT_QUEUE_KEY);
    if (raw === null || raw === "") return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredJob).map((row) => ({ ...row, status: row.status }));
  } catch {
    return [];
  }
}

function isStoredJob(value: unknown): value is PrintJob {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.seq === "number" &&
    typeof value.copies === "number" &&
    typeof value.attempts === "number" &&
    typeof value.createdAt === "string" &&
    (value.status === "queued" || value.status === "printing" || value.status === "done" || value.status === "failed")
  );
}

function saveJobs(store: KeyValueStore | null, jobs: readonly PrintJob[]): void {
  if (store === null) return;
  try {
    store.setItem(PRINT_QUEUE_KEY, JSON.stringify(jobs));
  } catch {
    // Penyimpanan penuh / diblokir bukan alasan menggagalkan cetak.
  }
}

export function createPrintQueueRunner(options: PrintQueueRunnerOptions): PrintQueueRunner {
  const now = options.now ?? (() => new Date());
  const store = options.store ?? null;
  const printerAvailable = options.printerAvailable ?? (() => true);

  let idCounter = 0;
  const nextId = options.nextId ?? (() => `print-${Date.now()}-${(idCounter += 1)}`);

  let jobs: PrintJob[] = loadJobs(store);
  // Nomor urut lanjut dari yang tersimpan — kalau tidak, reload membuat dua
  // tugas bernomor sama dan `reprint` menunjuk tugas yang salah.
  let seq = jobs.reduce((max, job) => Math.max(max, job.seq), 0);
  let busy = false;

  const persist = (): void => saveJobs(store, jobs);

  const replace = (next: PrintJob): void => {
    jobs = jobs.map((row) => (row.seq === next.seq ? next : row));
    persist();
  };

  const enqueue = (input: { id?: string; copies?: number }): PrintJob => {
    seq += 1;
    const job = createPrintJob(
      { id: input.id ?? nextId(), copies: input.copies, now: now().toISOString() } satisfies CreatePrintJobInput,
      seq,
    );
    jobs = [...jobs, job];
    persist();
    return job;
  };

  const runNext = async (): Promise<boolean> => {
    if (busy) return false;

    const claimed = claimNextJob(jobs, now());
    if (claimed.job === null) return false;

    jobs = claimed.jobs;
    persist();
    busy = true;

    const job = claimed.job;
    try {
      await options.print(job);
      replace(applyPrintResult(job, { ok: true }, now()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      replace(applyPrintResult(job, { ok: false, error: message }, now()));
    } finally {
      busy = false;
    }
    return true;
  };

  const autoPrint = async (input: { enabled: boolean; copies?: number; id?: string }): Promise<boolean> => {
    if (!shouldAutoPrint({ enabled: input.enabled, printerAvailable: printerAvailable() })) {
      return false;
    }
    enqueue({ id: input.id, copies: input.copies });
    return runNext();
  };

  const reprint = (targetSeq: number, reprintOptions?: { copies?: number }): PrintJob | null => {
    const origin = jobs.find((row) => row.seq === targetSeq);
    if (origin === undefined) return null;

    seq += 1;
    const base = createReprint(origin, nextId(), now().toISOString(), seq);
    const job =
      reprintOptions?.copies === undefined ? base : { ...base, copies: clampCopies(reprintOptions.copies) };

    jobs = [...jobs, job];
    persist();
    return job;
  };

  const clearFinished = (): void => {
    jobs = jobs.filter((job) => job.status === "queued" || job.status === "printing");
    persist();
  };

  return {
    enqueue,
    runNext,
    autoPrint,
    reprint,
    clearFinished,
    list: () => queueOrder(jobs),
    summary: () => summarizeQueue(jobs),
  };
}

/** Jepit salinan ke rentang yang sama dengan `createPrintJob` di shared. */
function clampCopies(requested: number): number {
  const value = Number(requested);
  if (!Number.isFinite(value)) return 1;
  return Math.min(PRINT_COPIES_MAX, Math.max(1, Math.round(value)));
}
