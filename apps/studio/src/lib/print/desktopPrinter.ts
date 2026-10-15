/**
 * Pencetak desktop untuk antrean (Fase 12, FEATURE-MATRIX #45, #80, #88).
 *
 * Antrean cetak (`usePrintQueue`) menerima **pencetak yang disuntikkan**. Di web
 * pencetaknya iframe browser (`printImage`) yang selalu memunculkan dialog. Di
 * shell desktop ada jalur yang lebih baik: proses utama Electron bisa mencetak
 * ke printer **bernama** tanpa dialog sama sekali. Itu inti kiosk — tamu tidak
 * boleh melihat dialog cetak, apalagi harus memilih printer.
 *
 * Yang dijaga berkas ini:
 *
 *   · **Jatuh balik, bukan gagal.** Kalau jembatan desktop tidak ada, atau
 *     printer yang dipilih bukan dari jalur `electron`, pencetak ini memakai
 *     jalur browser. Kiosk tidak pernah "tidak bisa mencetak" hanya karena
 *     dipindah antar runtime.
 *   · **Gambar ditanam, bukan dirujuk.** Dokumen cetak memakai data URL supaya
 *     jendela cetak Electron tidak bergantung pada blob URL dari halaman lain.
 *   · **Error dibedakan.** Gagal cetak karena printer mati harus sampai ke
 *     operator sebagai pesan yang berarti, bukan `undefined`.
 *
 * Modul ini murni kecuali lewat dependensi yang disuntikkan, jadi bisa diuji
 * tanpa Electron.
 */

import { printSizeMm, type PrinterInfo, type PrinterTransport } from "@foto-booth/shared";

import type { PrintFn } from "./printQueueRunner.ts";
import type { DesktopBridge } from "./printerRuntime.ts";

/** Preset yang dipakai jalur desktop — sama dengan jalur browser (strip 2×6). */
export const DESKTOP_PRESET = { width: 2, height: 6, bleed: 0, dpi: 300, name: "2x6" } as const;

export interface DesktopPrinterDeps {
  /** Jembatan desktop; `null` = jalur browser. */
  bridge: DesktopBridge | null;
  /** Jalur printer yang dipilih operator; `null` = ikut bawaan sistem. */
  getTransport: () => PrinterTransport | null;
  /** Nama perangkat untuk Electron (`printer.name` dari jalur `electron`). */
  getDeviceName: () => string | null;
  /** Cetak senyap (kiosk). */
  getSilent: () => boolean;
  /** Resolver gambar per id tugas; `null` = gambar belum ditempelkan. */
  resolveImage: (jobId: string) => string | null;
  /** Jalur browser (biasanya `printImage`); dipakai saat jembatan tak ada. */
  fallback: PrintFn;
}

/** Ubah gambar (data URL) jadi HTML yang siap dicetak Electron. */
export function buildDesktopPrintHtml(imageUrl: string, title: string): string {
  const mm = printSizeMm(DESKTOP_PRESET, {});
  return `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><title>${title}</title>
<style>
  @page { size: ${mm.width}mm ${mm.height}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  img { display: block; width: 100%; height: 100%; object-fit: fill; }
</style></head>
<body><img src="${imageUrl}" alt=""></body>
</html>`;
}

/**
 * Apakah jalur desktop akan dipakai untuk konfigurasi saat ini.
 *
 * Diekspor supaya UI bisa memberi tahu operator **lewat jalur mana** cetakan
 * keluar. Operator yang mengira kiosk mencetak senyap padahal jalurnya browser
 * akan bingung saat dialog muncul di layar tamu.
 */
export function willPrintViaDesktop(input: {
  bridge: DesktopBridge | null;
  transport: PrinterTransport | null;
  deviceName: string | null;
}): boolean {
  return (
    input.bridge !== null &&
    input.bridge.printHtml !== undefined &&
    input.transport === "electron" &&
    input.deviceName !== null
  );
}

/**
 * Pencetak untuk antrean: Electron dulu, browser sebagai cadangan.
 *
 * Dipanggil sekali per tugas; salinan (`job.copies`) ditangani di dalam supaya
 * runner tetap sederhana.
 */
export function desktopPrinter(deps: DesktopPrinterDeps): PrintFn {
  return async (job) => {
    const imageUrl = deps.resolveImage(job.id);
    if (imageUrl === null) {
      throw new Error(`gambar untuk tugas ${job.id} belum ditempelkan`);
    }

    const useDesktop = willPrintViaDesktop({
      bridge: deps.bridge,
      transport: deps.getTransport(),
      deviceName: deps.getDeviceName(),
    });

    if (!useDesktop) {
      await deps.fallback(job);
      return;
    }

    // `printHtml` sudah dipastikan ada oleh `willPrintViaDesktop`, tapi TypeScript
    // tidak menyempitkan lewat fungsi; ambil ulang di sini.
    const bridge = deps.bridge;
    const printHtml = bridge?.printHtml;
    const deviceName = deps.getDeviceName();
    if (bridge === null || printHtml === undefined || deviceName === null) {
      await deps.fallback(job);
      return;
    }

    const html = buildDesktopPrintHtml(imageUrl, job.id);
    for (let copy = 0; copy < job.copies; copy += 1) {
      const result = await printHtml({ html, deviceName, silent: deps.getSilent() });
      if (!result.ok) {
        throw new Error(result.reason ?? "cetak lewat jembatan desktop gagal");
      }
    }
  };
}

/** Ringkas printer terpilih untuk ditampilkan di panel (tanpa menyentuh state). */
export function describeChosenPrinter(chosen: PrinterInfo | null): string {
  if (chosen === null) return "bawaan sistem";
  return `${chosen.name} (${chosen.transport})`;
}
