/**
 * Antrean cetak untuk React.
 *
 * Runner-nya murni (`printQueueRunner.ts`); berkas ini hanya mengikatnya ke
 * state React dan menyediakan pencetak bawaan untuk browser.
 *
 * **Kenapa pencetak bisa disuntikkan.** Tes dan panel debug tidak boleh benar-
 * benar membuka dialog cetak. `print` opsional: kalau tidak diberikan, hook
 * memakai pencetak browser (`printImage`) dan mengambil gambar dari registry
 * yang diisi pemanggil lewat `registerImage`.
 *
 * **Kenapa registry gambar dipisah dari tugas.** `PrintJob` di `packages/shared`
 * sengaja tidak membawa gambar: tugas cetak harus bisa disimpan, dibandingkan,
 * dan diuji tanpa blob besar di dalamnya. Gambar ditempelkan di sisi studio,
 * di memori, dengan `id` tugas sebagai kunci.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { nearestPrintPreset, type PrintJob, type PrintQueueSummary } from "@foto-booth/shared";

import type { KeyValueStore } from "../capture/rememberedDevice.ts";
import { printImage } from "./printBrowser.ts";
import { createPrintQueueRunner, type PrintFn, type PrintQueueRunner } from "./printQueueRunner.ts";

export interface UsePrintQueueOptions {
  /** Pencetak pengganti; default: cetak ke printer browser. */
  print?: PrintFn;
  /** Penyimpanan; default `localStorage`. `null` = memori saja. */
  store?: KeyValueStore | null;
  now?: () => Date;
}

export interface PrintQueueState {
  jobs: PrintJob[];
  summary: PrintQueueSummary;
  busy: boolean;
  error: string | null;
}

export interface PrintQueueActions {
  /** Cetak tugas berikutnya; `false` kalau tidak ada yang siap. */
  runNext: () => Promise<boolean>;
  /** Cetak otomatis kalau auto-print menyala & printer ada. */
  autoPrint: (input: { enabled: boolean; copies?: number; id?: string }) => Promise<boolean>;
  /** Antrekan ulang tugas yang sudah selesai/gagal. */
  reprint: (seq: number, options?: { copies?: number }) => void;
  /** Buang tugas yang sudah `done`/`failed`. */
  clearFinished: () => void;
  /** Tambah tugas baru (mis. tombol cetak manual). */
  enqueue: (input: { id?: string; copies?: number }) => PrintJob;
  /** Tempelkan gambar ke tugas; dipakai pencetak browser. */
  registerImage: (jobId: string, imageUrl: string) => void;
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Pencetak browser: cetak gambar yang ditempelkan ke tugas lewat `printImage`. */
function browserPrinter(resolve: (jobId: string) => string | null): PrintFn {
  return async (job) => {
    const imageUrl = resolve(job.id);
    if (imageUrl === null) {
      throw new Error(`gambar untuk tugas ${job.id} belum ditempelkan`);
    }
    // Preset default 2×6 (strip) — paling sering dipakai booth; operator bisa
    // mengganti preset dengan menyuntikkan `print` sendiri.
    const preset = nearestPrintPreset(2, 6);
    for (let copy = 0; copy < job.copies; copy += 1) {
      await new Promise<void>((resolvePrint) => {
        const handle = printImage(preset, imageUrl, {});
        // `afterprint` tidak selalu menyala; jaring pengaman memastikan janji
        // ini selesai supaya antrean tidak macet menunggu selamanya.
        const timer = globalThis.setTimeout(() => {
          handle.dispose();
          resolvePrint();
        }, 2_000);
        const originalDispose = handle.dispose;
        handle.dispose = () => {
          globalThis.clearTimeout(timer);
          originalDispose();
          resolvePrint();
        };
      });
    }
  };
}

export function usePrintQueue(options: UsePrintQueueOptions = {}): PrintQueueState & PrintQueueActions {
  const imagesRef = useRef(new Map<string, string>());
  const [state, setState] = useState<PrintQueueState>(() => ({
    jobs: [],
    summary: { queued: 0, printing: 0, done: 0, failed: 0, sheetsPrinted: 0 },
    busy: false,
    error: null,
  }));

  const runner = useMemo<PrintQueueRunner>(() => {
    const store = options.store === undefined ? defaultStore() : options.store;
    const print =
      options.print ??
      browserPrinter((jobId) => imagesRef.current.get(jobId) ?? null);
    return createPrintQueueRunner({ print, store, now: options.now });
    // Runner sengaja dibuat sekali; menggantinya berarti membuang antrean.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sync = useCallback((): void => {
    setState((prev) => ({ ...prev, jobs: runner.list(), summary: runner.summary() }));
  }, [runner]);

  useEffect(() => {
    sync();
  }, [sync]);

  const runNext = useCallback(async (): Promise<boolean> => {
    setState((prev) => ({ ...prev, busy: true, error: null }));
    try {
      const ran = await runner.runNext();
      sync();
      return ran;
    } catch (error) {
      setState((prev) => ({ ...prev, error: error instanceof Error ? error.message : String(error) }));
      return false;
    } finally {
      setState((prev) => ({ ...prev, busy: false }));
    }
  }, [runner, sync]);

  const autoPrint = useCallback(
    async (input: { enabled: boolean; copies?: number; id?: string }): Promise<boolean> => {
      setState((prev) => ({ ...prev, error: null }));
      try {
        const ran = await runner.autoPrint(input);
        sync();
        return ran;
      } catch (error) {
        setState((prev) => ({ ...prev, error: error instanceof Error ? error.message : String(error) }));
        return false;
      }
    },
    [runner, sync],
  );

  const reprint = useCallback(
    (seq: number, reprintOptions?: { copies?: number }): void => {
      runner.reprint(seq, reprintOptions);
      sync();
    },
    [runner, sync],
  );

  const clearFinished = useCallback((): void => {
    runner.clearFinished();
    sync();
  }, [runner, sync]);

  const enqueue = useCallback(
    (input: { id?: string; copies?: number }): PrintJob => {
      const job = runner.enqueue(input);
      sync();
      return job;
    },
    [runner, sync],
  );

  const registerImage = useCallback((jobId: string, imageUrl: string): void => {
    imagesRef.current.set(jobId, imageUrl);
  }, []);

  return { ...state, runNext, autoPrint, reprint, clearFinished, enqueue, registerImage };
}
