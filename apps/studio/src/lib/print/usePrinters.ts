/**
 * Jembatan React ↔ deteksi & pemilihan printer (Fase 12, #45/#80).
 *
 * Seperti `useFilterSettings`: berkas ini hanya **menyatukan**, tidak menambah
 * aturan. Keputusan "printer mana yang dipakai" ada di `packages/shared`
 * (`choosePrinter`), keputusan "mana yang terlihat" ada di `printerRuntime.ts`.
 *
 * Yang benar-benar ditangani hook ini, dan alasannya:
 *
 *   · **Menyimpan pilihan operator.** Printer yang dipilih bertahan lewat
 *     reload — kiosk sering ke-reload, dan menyetel ulang printer setiap kali
 *     adalah cara paling cepat membuat operator berhenti memakai auto-print.
 *   · **Pilihan yang hilang.** Printer bisa dicabut. Pilihan lama yang tidak
 *     ada lagi di daftar tidak dihapus diam-diam; hook memberi tahu UI supaya
 *     operator sadar printer-nya hilang, bukan mengira cetakannya rusak.
 *   · **Tidak melempar.** Deteksi perangkat bisa gagal (izin WebUSB ditolak,
 *     Electron belum siap). Kegagalan itu jadi `problems`, bukan crash kiosk.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  parsePrinterPreference,
  serializePrinterPreference,
  PRINTER_PREF_KEY,
  choosePrinter,
  summarizePrinters,
  type PrinterInfo,
  type PrinterPreference,
  type PrinterSummary,
} from "@foto-booth/shared";

import { deviceStorage } from "../capture/rememberedDevice.ts";
import {
  collectPrinters,
  type CollectResult,
  type DesktopBridge,
  type UsbDeviceLike,
} from "./printerRuntime.ts";

/**
 * Jembatan desktop kalau ada.
 *
 * Studio berjalan di web, Electron, dan Capacitor dari bundel yang sama — jadi
 * keberadaan shell desktop harus **ditemukan**, bukan diasumsikan. Aman dipanggil
 * di Node (tes): `globalThis` selalu ada.
 */
export function desktopBridge(): DesktopBridge | null {
  const scope = globalThis as { fotoBoothDesktop?: DesktopBridge };
  return scope.fotoBoothDesktop ?? null;
}

export interface UsePrintersOptions {
  /** Jembatan desktop; default `window.fotoBoothDesktop`. `null` = paksa web. */
  bridge?: DesktopBridge | null;
  /** Pembaca perangkat WebUSB; default `navigator.usb`. Dipakai tes. */
  listUsbDevices?: () => Promise<UsbDeviceLike[]>;
  /** Apakah Capacitor terdeteksi. Dipakai tes. */
  isCapacitor?: boolean;
}

export interface PrintersHandle {
  /** Semua printer yang terlihat, sudah digabung dan diurutkan. */
  printers: PrinterInfo[];
  /** Ringkasan untuk ditampilkan (jumlah siap / bermasalah). */
  summary: PrinterSummary;
  /** Printer yang akan dipakai kalau operator menekan cetak sekarang. */
  chosen: PrinterInfo | null;
  /** Preferensi operator (printer terpilih + cetak senyap). */
  preference: PrinterPreference;
  /** Masalah yang perlu diketahui operator, sudah dalam bahasa manusia. */
  problems: string[];
  /** Transport aktif: `electron`, `browser`, atau `capacitor`. */
  transport: CollectResult["transport"];
  /** `true` saat deteksi pertama belum selesai. */
  loading: boolean;
  /**
   * `true` kalau printer yang dipilih operator tidak ada di daftar sekarang.
   * UI harus menampilkan ini — operator perlu tahu printernya hilang, bukan
   * mengira aplikasinya rusak.
   */
  chosenMissing: boolean;
  /** Deteksi ulang. */
  refresh(): Promise<void>;
  /** Pilih printer (atau `null` = ikut bawaan sistem). */
  select(printerId: string | null): void;
  /** Nyalakan/matikan cetak tanpa dialog (hanya berarti di Electron). */
  setSilent(silent: boolean): void;
}

export function usePrinters(options: UsePrintersOptions = {}): PrintersHandle {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [transport, setTransport] = useState<CollectResult["transport"]>("browser");
  const [loading, setLoading] = useState(true);
  const [preference, setPreference] = useState<PrinterPreference>(() =>
    parsePrinterPreference(
      typeof localStorage === "undefined"
        ? null
        : deviceStorage()?.getItem(PRINTER_PREF_KEY) ?? null,
    ),
  );

  const bridge = options.bridge === undefined ? desktopBridge() : options.bridge;

  const refresh = useCallback(async (): Promise<void> => {
    // `undefined` = pakai `navigator.usb`; `null` eksplisit = jangan pakai USB
    // (dipakai tes dan lingkungan yang memaksa jalur tertentu).
    const listUsb =
      options.listUsbDevices === undefined ? detectUsb() ?? undefined : options.listUsbDevices ?? undefined;

    try {
      const result = await collectPrinters({
        bridge,
        listUsbDevices: listUsb,
        isCapacitor: options.isCapacitor === true,
      });
      setPrinters(result.printers);
      setProblems(result.problems);
      setTransport(result.transport);
    } catch {
      // Deteksi yang melempar bukan alasan membuat kiosk kosong; printer
      // dianggap tidak terlihat dan masalahnya dilaporkan.
      setPrinters([]);
      setProblems(["deteksi printer gagal"]);
    } finally {
      setLoading(false);
    }
  }, [bridge, options.listUsbDevices, options.isCapacitor]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const store = typeof localStorage === "undefined" ? null : deviceStorage();
    if (store === null) return;
    store.setItem(PRINTER_PREF_KEY, serializePrinterPreference(preference));
  }, [preference]);

  const summary = useMemo(() => summarizePrinters(printers), [printers]);

  const chosen = useMemo(
    () => choosePrinter(printers, preference.printerId),
    [printers, preference.printerId],
  );

  const chosenMissing = useMemo(() => {
    if (preference.printerId === null) return false;
    return !printers.some((printer) => printer.id === preference.printerId);
  }, [printers, preference.printerId]);

  const select = useCallback((printerId: string | null): void => {
    setPreference((current) => ({ ...current, printerId }));
  }, []);

  const setSilent = useCallback((silent: boolean): void => {
    setPreference((current) => ({ ...current, silent }));
  }, []);

  return {
    printers,
    summary,
    chosen,
    preference,
    problems,
    transport,
    loading,
    chosenMissing,
    refresh,
    select,
    setSilent,
  };
}

/** Pembaca perangkat WebUSB kalau `navigator.usb` ada — jangan melempar di
 *  lingkungan tanpa WebUSB (Node, browser tanpa izin). */
function detectUsb(): (() => Promise<UsbDeviceLike[]>) | null {
  const nav = globalThis.navigator as { usb?: { getDevices(): Promise<UsbDeviceLike[]> } } | undefined;
  const usb = nav?.usb;
  if (usb === undefined || typeof usb.getDevices !== "function") return null;
  return () => usb.getDevices();
}
