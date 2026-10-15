/**
 * Cetak hasil sesi dari layar kiosk (#51) — jembatan React untuk `resultPrint`.
 *
 * Kenapa dipisah jadi hook sendiri:
 *
 *   · **Menyusun gambar itu urusan perangkat, bukan tampilan.** Layar hasil
 *     hanya perlu tahu "cetak sekarang" dan "berhasil atau tidak". Semua
 *     langkah di antaranya (template terbaru → frame sesi terakhir → strip →
 *     data URL → printer) tinggal di sini, dan komponen tetap bisa dibaca.
 *   · **Jalur cetak harus sama dengan panel operator.** Printer dipilih lewat
 *     `usePrinters` (printer bernama di Electron, bawaan sistem di web), dan
 *     keputusan "lewat desktop atau browser" tetap milik `resultPrint.ts` yang
 *     murni dan teruji. Hook ini tidak mengulang aturan itu.
 *   · **Tidak pernah melempar.** Pemanggilnya tombol tamu; error yang lolos
 *     akan mematikan layar kiosk. Setiap kegagalan jadi `{ ok: false, message }`.
 *
 * Kalau strip tidak bisa disusun (belum ada template, IndexedDB mati, decode
 * gagal), cetak **dilaporkan gagal dengan pesan yang jujur** — lebih baik tamu
 * membaca "gambar hasil sesi belum siap" daripada menunggu lembar yang tidak
 * akan pernah keluar.
 */

import { useCallback, useMemo } from "react";

import { nearestPrintPreset } from "@foto-booth/shared";

import { createFrameStore } from "../capture/frameStore.ts";
import { blobToDataUrl, printImage } from "../print/printBrowser.ts";
import { desktopBridge, usePrinters } from "../print/usePrinters.ts";
import { browserOffThreadDeps, renderStrip } from "../template/renderOffThread.ts";
import { loadLatestSessionFrames } from "../template/previewFrames.ts";
import { useTemplates } from "../useTemplates.ts";
import { printResultPhoto, type ResultPrintOutcome } from "./resultPrint.ts";

/** Berapa lama menunggu `afterprint` sebelum iframe dilepas paksa. */
const BROWSER_CLEANUP_MS = 2_000;

export interface KioskResultPrintHandle {
  /** Cetak foto hasil sesi terakhir. Selalu selesai dengan nilai. */
  print(): Promise<ResultPrintOutcome>;
  /** Susun gambar hasil tanpa mencetak (dipakai tes & pratinjau). */
  compose(): Promise<string | null>;
}

export function useKioskResultPrint(): KioskResultPrintHandle {
  const printers = usePrinters();
  const templates = useTemplates();

  /**
   * Cetak lewat iframe browser.
   *
   * Janji ini **harus** selesai: `afterprint` tidak selalu menyala, dan antrean
   * cetak yang menunggu selamanya akan membuat tombol tamu macet di
   * "Mencetak…". Jaring pengamannya sama dengan `browserPrinter`.
   */
  const printBrowser = useCallback(async (imageUrl: string): Promise<void> => {
    const preset = nearestPrintPreset(2, 6);

    await new Promise<void>((resolve, reject) => {
      const handle = printImage(preset, imageUrl, {});

      if (handle.iframe === null) {
        reject(new Error("tidak bisa membuka jendela cetak"));
        return;
      }

      const timer = globalThis.setTimeout(() => {
        handle.dispose();
        resolve();
      }, BROWSER_CLEANUP_MS);

      const originalDispose = handle.dispose;
      handle.dispose = () => {
        globalThis.clearTimeout(timer);
        originalDispose();
        resolve();
      };
    });
  }, []);

  /**
   * Gambar yang dicetak.
   *
   * Utamakan **strip dari template tersimpan terbaru**: itulah yang dilihat
   * tamu di layar dan yang diharapkan keluar dari printer. Template *terbaru*,
   * bukan yang pertama — operator menyimpan template setelah selesai
   * mengutak-atiknya, jadi yang paling baru diubah adalah yang sedang dipakai.
   *
   * Tanpa template, foto pertama sesi dicetak apa adanya. Kiosk yang tidak bisa
   * mencetak sama sekali karena operator belum sempat menyimpan template lebih
   * buruk daripada kiosk yang mencetak foto mentah — dan tamu sudah menunggu.
   */
  const compose = useCallback(async (): Promise<string | null> => {
    const newest = [...templates.templates].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )[0];

    const { store } = createFrameStore();
    const loaded = await loadLatestSessionFrames(store);

    try {
      // Satu foto rusak boleh jadi `null`; strip tetap bisa dirender selama
      // masih ada slot yang terisi.
      if (newest !== undefined && loaded.frames.some((frame) => frame !== null)) {
        const rendered = await renderStrip(newest, browserOffThreadDeps(), {
          frames: loaded.frames,
          format: "jpeg",
          quality: 0.92,
          now: new Date(),
        });

        // Data URL, bukan blob URL: dokumen cetak hidup di dalam iframe dan
        // tidak boleh bergantung pada blob URL milik halaman induk.
        return await blobToDataUrl(rendered.blob);
      }

      const fallback = loaded.blobs.find((blob): blob is Blob => blob !== null);
      return fallback === undefined ? null : await blobToDataUrl(fallback);
    } finally {
      loaded.release();
    }
  }, [templates.templates]);

  const print = useCallback(async (): Promise<ResultPrintOutcome> => {
    let imageUrl: string | null = null;
    try {
      imageUrl = await compose();
    } catch {
      // Menyusun gambar gagal (template rusak, IndexedDB mati). `null` akan
      // dilaporkan `printResultPhoto` sebagai "gambar belum siap".
      imageUrl = null;
    }

    return printResultPhoto(imageUrl, {
      bridge: desktopBridge(),
      transport: printers.transport,
      deviceName: printers.chosen === null ? null : printers.chosen.name,
      silent: printers.preference.silent,
      printBrowser,
    });
  }, [compose, printers.transport, printers.chosen, printers.preference.silent, printBrowser]);

  return useMemo(() => ({ print, compose }), [print, compose]);
}
