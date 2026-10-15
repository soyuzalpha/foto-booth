/**
 * Cetak satu foto hasil sesi dari layar kiosk (Fase 12 — titipan #51).
 *
 * Kenapa tidak memakai antrean cetak: antrean itu **milik operator**. Ia punya
 * daftar tugas, tombol ulangi, dan status per tugas yang ditampilkan di panel.
 * Tamu tidak boleh menyentuh barang itu — yang ia butuhkan cuma satu lembar
 * keluar dari printer sekarang. Jadi tombol cetak di layar hasil memakai jalur
 * langsung, bukan menumpuk tugas di antrean operator.
 *
 * Aturan yang dijaga di sini:
 *
 *   · **Rute dipilih, bukan ditebak.** Kalau jembatan desktop ada, printer
 *     bernama sudah dipilih, dan transportnya `electron`, cetak langsung tanpa
 *     dialog. Selain itu jalur browser dipakai (satu-satunya yang ada di web).
 *   · **Tidak melempar.** Pemanggilnya komponen React; error yang dilempar dari
 *     tombol cetak akan mematikan layar tamu. Hasilnya selalu nilai.
 *   · **Alasan kegagalan dibedakan** supaya tamu melihat pesan yang berarti
 *     ("belum ada printer dipilih") bukan `undefined`.
 *
 * Semua dependensi perangkat disuntik, jadi berkas ini bisa diuji tanpa
 * Electron maupun browser.
 */

import type { PrinterTransport } from "@foto-booth/shared";

import { buildDesktopPrintHtml, willPrintViaDesktop } from "../print/desktopPrinter.ts";
import type { DesktopBridge } from "../print/printerRuntime.ts";

/** Dari mana lembar itu keluar. Ditampilkan supaya operator bisa memastikan. */
export type ResultPrintRoute = "desktop" | "browser";

export type ResultPrintOutcome =
  | { ok: true; route: ResultPrintRoute }
  | { ok: false; message: string };

export interface ResultPrintDeps {
  /** Jembatan desktop; `null` = web/Capacitor. */
  bridge: DesktopBridge | null;
  /** Transport printer yang dipilih operator. */
  transport: PrinterTransport | null;
  /** Nama perangkat untuk Electron; `null` = belum dipilih. */
  deviceName: string | null;
  /** Cetak tanpa dialog (kiosk). */
  silent: boolean;
  /**
   * Jalur browser (biasanya `printImage`). `null` = tidak ada jalur browser di
   * lingkungan ini, dan cetak akan dilaporkan gagal alih-alih diam-diam tidak
   * terjadi.
   */
  printBrowser?: ((imageUrl: string) => Promise<void>) | null;
}

/** Judul dokumen cetak — muncul di spooler, jadi harus bisa dikenali. */
export const RESULT_PRINT_TITLE = "foto-booth-hasil";

/**
 * Cetak satu gambar (data/object URL) dan laporkan hasilnya.
 *
 * Gambar kosong dianggap belum siap, bukan kegagalan printer: tombol bisa
 * ditekan sebelum foto selesai disimpan, dan pesannya harus jujur.
 */
export async function printResultPhoto(
  imageUrl: string | null,
  deps: ResultPrintDeps,
): Promise<ResultPrintOutcome> {
  if (imageUrl === null || imageUrl === "") {
    return { ok: false, message: "gambar hasil sesi belum siap" };
  }

  const useDesktop = willPrintViaDesktop({
    bridge: deps.bridge,
    transport: deps.transport,
    deviceName: deps.deviceName,
  });

  if (useDesktop) {
    const printHtml = deps.bridge?.printHtml;
    const deviceName = deps.deviceName;
    if (printHtml !== undefined && deviceName !== null) {
      const html = buildDesktopPrintHtml(imageUrl, RESULT_PRINT_TITLE);
      try {
        const result = await printHtml({ html, deviceName, silent: deps.silent });
        if (result.ok) return { ok: true, route: "desktop" };
        return { ok: false, message: result.reason ?? "cetak lewat desktop gagal" };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    }
    // Jembatan desktop ada tapi jalurnya tidak lengkap (mis. printer dicabut di
    // tengah sesi). Jatuh ke browser lebih baik daripada tamu tidak dapat foto.
  }

  const printBrowser = deps.printBrowser ?? null;
  if (printBrowser === null) {
    return { ok: false, message: "tidak ada jalur cetak di lingkungan ini" };
  }

  try {
    await printBrowser(imageUrl);
    return { ok: true, route: "browser" };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "cetak gagal";
}
