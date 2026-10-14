/**
 * Antrean cetak (Fase 9, FEATURE-MATRIX #44 & #46).
 *
 * Auto-print berarti kiosk mencetak **tanpa operator menyentuh apa pun**. Itu
 * mengubah arti sebuah kegagalan: kalau cetakan gagal dan tidak ada yang
 * melihat, tamu berdiri menunggu lembar yang tidak pernah keluar. Karena itu
 * mesin antrean ini bukan sekadar daftar tugas — ia punya tiga sifat:
 *
 *   · **Salinan dihitung sekali, saat masuk antrean.** Operator memilih
 *     "cetak 2 lembar"; kalau penghitungannya dilakukan saat mencetak, tombol
 *     auto-print yang terpanggil dua kali (kiosk, event ganda) akan
 *     menghasilkan 4 lembar.
 *   · **Gagal itu normal, bukan akhir.** Setiap tugas punya `attempts`;
 *     percobaan berikutnya punya jeda yang tumbuh, dan setelah batas habis
 *     tugas berhenti sebagai `failed` — tetap terlihat operator, tidak hilang
 *     diam-diam.
 *   · **Reprint selalu mungkin.** Operator bisa memasukkan kembali tugas yang
 *     sudah `done` (mis. printer kehabisan kertas setelah lembar pertama).
 *     Ini **menambah** tugas baru, bukan menghidupkan yang lama — supaya
 *     riwayat tetap jujur soal berapa lembar yang benar-benar keluar.
 *
 * Modul murni: tidak menyentuh DOM, tidak menyentuh waktu nyata (`now`
 * di-inject), jadi bisa diuji tanpa browser maupun printer.
 */

export const PRINT_JOB_STATUSES = ["queued", "printing", "done", "failed"] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

export function isPrintJobStatus(value: string): value is PrintJobStatus {
  return (PRINT_JOB_STATUSES as readonly string[]).includes(value);
}

/** Batas salinan sekali tugas — di atas ini hampir pasti salah ketik. */
export const PRINT_COPIES_MAX = 10;

/** Batas percobaan sebelum tugas dinyatakan gagal. */
export const PRINT_MAX_ATTEMPTS = 3;

/** Jeda sebelum percobaan ke-n (ms): 1 dtk, 4 dtk, 9 dtk — tumbuh kuadrat. */
export const PRINT_RETRY_BASE_MS = 1000;

export interface PrintJob {
  id: string;
  /** Sesuai urutan masuk; dua tugas bisa punya `createdAt` sama di kiosk cepat. */
  seq: number;
  status: PrintJobStatus;
  /** Salinan yang diminta saat tugas dibuat. */
  copies: number;
  /** Percobaan yang sudah dilakukan (0 = belum pernah dicoba). */
  attempts: number;
  /** Nomor urut tugas asal kalau ini reprint; `null` kalau asli. */
  reprintOf: number | null;
  /** Waktu (ISO) percobaan berikutnya boleh jalan. `null` = sekarang. */
  nextAttemptAt: string | null;
  /** Pesan kegagalan terakhir, untuk ditampilkan ke operator. */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePrintJobInput {
  id: string;
  copies?: number;
  now: string;
}

/**
 * Tugas baru. Salinan dijepit ke `[1, PRINT_COPIES_MAX]` dan dibulatkan —
 * `copies: 2.5` dari input HTML number harus jadi 3, bukan 2, karena
 * membulatkan ke bawah berarti tamu kehilangan satu lembar.
 */
export function createPrintJob(input: CreatePrintJobInput, seq: number): PrintJob {
  const requested = Number(input.copies ?? 1);
  const copies = Number.isFinite(requested)
    ? Math.min(PRINT_COPIES_MAX, Math.max(1, Math.round(requested)))
    : 1;

  return {
    id: input.id,
    seq,
    status: "queued",
    copies,
    attempts: 0,
    reprintOf: null,
    nextAttemptAt: null,
    lastError: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * Tugas reprint: menunjuk ke tugas asal yang sudah selesai/gagal.
 *
 * `copies` default mengikuti asal (operator biasanya ingin hasil yang sama),
 * tapi tetap bisa ditimpa.
 */
export function createReprint(origin: PrintJob, id: string, now: string, seq: number): PrintJob {
  const job = createPrintJob({ id, copies: origin.copies, now }, seq);
  return { ...job, reprintOf: origin.seq };
}

/** Urutan pengerjaan: `queued` dulu, lalu `printing`; nomor urut naik. */
export function queueOrder(jobs: readonly PrintJob[]): PrintJob[] {
  const rank = (status: PrintJobStatus): number =>
    status === "printing" ? 0 : status === "queued" ? 1 : 2;

  return jobs
    .filter((job) => job.status === "queued" || job.status === "printing")
    .slice()
    .sort((a, b) => rank(a.status) - rank(b.status) || a.seq - b.seq);
}

/** Tugas berikutnya yang boleh dikerjakan sekarang, atau `null`. */
export function nextJob(jobs: readonly PrintJob[], now: Date): PrintJob | null {
  for (const job of queueOrder(jobs)) {
    if (job.nextAttemptAt === null) return job;
    // Tanggal rusak diperlakukan sebagai "boleh jalan": menahan tugas karena
    // timestamp yang tidak terbaca lebih buruk daripada mencetak sekali lagi.
    const ready = Date.parse(job.nextAttemptAt);
    if (Number.isNaN(ready) || ready <= now.getTime()) return job;
  }
  return null;
}

/**
 * Terapkan hasil satu percobaan.
 *
 * `attempts` naik di sini, bukan di pemanggil: kalau pemanggil yang menaikkan,
 * satu jalur yang lupa berarti percobaan tak terbatas pada printer yang mati.
 */
export function applyPrintResult(
  job: PrintJob,
  result: { ok: true } | { ok: false; error: string },
  now: Date,
): PrintJob {
  const nowIso = now.toISOString();
  const attempts = job.attempts + 1;

  if (result.ok) {
    return { ...job, status: "done", attempts, nextAttemptAt: null, lastError: null, updatedAt: nowIso };
  }

  if (attempts >= PRINT_MAX_ATTEMPTS) {
    return {
      ...job,
      status: "failed",
      attempts,
      nextAttemptAt: null,
      lastError: result.error,
      updatedAt: nowIso,
    };
  }

  const delay = PRINT_RETRY_BASE_MS * attempts * attempts;
  return {
    ...job,
    status: "queued",
    attempts,
    nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
    lastError: result.error,
    updatedAt: nowIso,
  };
}

/** Ambil tugas berikutnya dan tandai `printing` (jantung worker). */
export function claimNextJob(jobs: readonly PrintJob[], now: Date): {
  job: PrintJob | null;
  jobs: PrintJob[];
} {
  const job = nextJob(jobs, now);
  if (job === null) return { job: null, jobs: jobs.slice() };

  const claimed: PrintJob = { ...job, status: "printing", updatedAt: now.toISOString() };
  return { job: claimed, jobs: jobs.map((row) => (row.seq === job.seq ? claimed : row)) };
}

/** Ringkasan untuk operator — satu baris, bukan daftar. */
export interface PrintQueueSummary {
  queued: number;
  printing: number;
  done: number;
  failed: number;
  /** Lembar yang sudah benar-benar keluar (hanya tugas `done`). */
  sheetsPrinted: number;
}

export function summarizeQueue(jobs: readonly PrintJob[]): PrintQueueSummary {
  const summary: PrintQueueSummary = { queued: 0, printing: 0, done: 0, failed: 0, sheetsPrinted: 0 };
  for (const job of jobs) {
    summary[job.status] += 1;
    if (job.status === "done") summary.sheetsPrinted += job.copies;
  }
  return summary;
}

/**
 * Auto-print hanya berjalan kalau operator menyalakannya **dan** ada printer.
 * Dua syarat, bukan satu: menyalakan auto-print tanpa printer berarti kiosk
 * menghabiskan 3 percobaan tiap sesi untuk sesuatu yang tidak mungkin berhasil.
 */
export function shouldAutoPrint(options: { enabled: boolean; printerAvailable: boolean }): boolean {
  return options.enabled && options.printerAvailable;
}
