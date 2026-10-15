/**
 * Deteksi printer per runtime (Fase 12, FEATURE-MATRIX #45, #80, #88).
 *
 * Studio bisa berjalan di tiga tempat, dan **cara melihat printer berbeda di
 * masing-masing**. Berkas ini menyembunyikan perbedaan itu di balik satu
 * jawaban: `PrinterInfo[]`.
 *
 *   1. **Electron** — jembatan `window.fotoBoothDesktop` (dipasang di preload)
 *      meneruskan `getPrintersAsync()` dari proses utama. Ini satu-satunya jalur
 *      yang memberi **nama** printer, sehingga operator bisa memilih, dan cetak
 *      bisa diarahkan tanpa dialog (`silent`).
 *   2. **WebUSB** — printer bisa dilihat **sebelum OS punya drivernya**, asal
 *      pengguna sudah memberi izin perangkat lewat `requestDevice`. Ini yang
 *      membuat kiosk bisa bilang "printer terpasang" saat OS belum tahu.
 *   3. **Browser biasa** — tidak ada API daftar printer. Yang tersedia hanya
 *      dialog cetak. Dilaporkan sebagai satu printer virtual supaya panel tidak
 *      menampilkan "tidak ada printer" yang menyesatkan.
 *   4. **Capacitor** — sama seperti browser: jalur cetaknya lewat plugin OS.
 *
 * **Kenapa WebUSB tidak dipanggil sendiri di sini.** `requestDevice` wajib
 * dipicu gestur pengguna; memanggilnya saat pemuatan halaman akan ditolak
 * browser. Jadi berkas ini hanya **membaca** perangkat yang sudah diberi izin
 * (`getDevices()`), dan pemanggilnya yang memutuskan kapan meminta izin baru.
 *
 * Fungsi murni `normalize*` dipisah dari kode yang menyentuh `window` supaya
 * bisa diuji tanpa browser.
 */

import {
  classifyUsbPrinter,
  type PrinterInfo,
  type PrinterTransport,
} from "@foto-booth/shared";

/* ================================================================== *
 * Bentuk data dari jembatan
 * ================================================================== */

/** Satu printer seperti dilaporkan Electron. */
export interface BridgePrinter {
  name: string;
  displayName?: string | null;
  status?: number | string | null;
  isDefault?: boolean | null;
  options?: Record<string, string> | null;
}

/** Jembatan yang dipasang preload Electron. Tidak ada di browser biasa. */
export interface DesktopBridge {
  getPrinters: () => Promise<BridgePrinter[]>;
  /** Cetak HTML ke printer tertentu; `silent` = tanpa dialog. */
  printHtml?: (input: {
    html: string;
    deviceName?: string | null;
    silent?: boolean;
  }) => Promise<{ ok: boolean; reason?: string }>;
  /** Buka dialog simpan berkas (dipakai laporan diagnostik). */
  saveFile?: (input: { name: string; data: string }) => Promise<{ ok: boolean; path?: string }>;
  /** Versi runtime — hanya ada di shell Electron; dipakai laporan diagnostik. */
  versions?: { electron?: string; chrome?: string; node?: string };
}

/** Perangkat WebUSB seperlunya — bukan tipe DOM supaya tes tidak butuh lib DOM. */
export interface UsbDeviceLike {
  vendorId: number;
  productId: number;
  productName?: string | null;
  deviceClass?: number | null;
  deviceVersionMajor?: number | null;
}

declare global {
  interface Window {
    fotoBoothDesktop?: DesktopBridge;
  }
}

/* ================================================================== *
 * Normalisasi — murni, bisa diuji
 * ================================================================== */

/**
 * Status Electron → status kita.
 *
 * Electron mengirim angka: 0 = tidak diketahui, 1 = idle, 2 = sibuk,
 * 3–5 = keadaan bermasalah. **2 (sibuk) tetap dianggap `ready`** — printer
 * sedang mencetak bukan alasan untuk menolak mengantrekan pekerjaan berikutnya;
 * kalau diperlakukan sebagai mati, auto-print kiosk akan mati setiap kali ada
 * satu lembar sedang keluar.
 */
export function normalizeElectronStatus(status: number | string | null | undefined): PrinterInfo["status"] {
  if (typeof status === "string") {
    const lowered = status.toLowerCase();
    if (lowered === "idle" || lowered === "printing" || lowered === "ready") return "ready";
    if (lowered === "offline" || lowered === "stopped") return "offline";
    if (lowered === "unknown") return "unknown";
    return "unknown";
  }

  switch (status) {
    case 1:
    case 2:
      return "ready";
    case 3:
    case 4:
    case 5:
      return "offline";
    case 0:
      return "unknown";
    default:
      return "unknown";
  }
}

export function normalizeBridgePrinters(printers: readonly BridgePrinter[]): PrinterInfo[] {
  return printers
    .filter((p) => typeof p.name === "string" && p.name !== "")
    .map((p) => ({
      id: p.name,
      name: (p.displayName !== null && p.displayName !== undefined && p.displayName !== ""
        ? p.displayName
        : p.name),
      transport: "electron" as PrinterTransport,
      isDefault: p.isDefault === true,
      status: normalizeElectronStatus(p.status),
      detail: p.options?.printerLocation ?? null,
    }));
}

/**
 * Perangkat WebUSB → info printer. Hanya yang lolos klasifikasi yang masuk.
 *
 * `status` sengaja `unknown`, bukan `ready`: WebUSB membuktikan kabelnya
 * tersambung, bukan bahwa printernya siap. Mengklaim `ready` akan membuat
 * `choosePrinter` memilih printer yang mungkin kehabisan kertas.
 */
export function normalizeUsbPrinters(devices: readonly UsbDeviceLike[]): PrinterInfo[] {
  const found: PrinterInfo[] = [];

  for (const device of devices) {
    const guess = classifyUsbPrinter({
      classCode: device.deviceClass ?? 0,
      productName: device.productName ?? null,
    });
    if (!guess.isPrinter) continue;

    const hex = (value: number): string => value.toString(16).padStart(4, "0");
    const label = device.productName !== null && device.productName !== undefined && device.productName !== ""
      ? device.productName
      : `Perangkat USB ${hex(device.vendorId)}:${hex(device.productId)}`;

    found.push({
      id: `usb:${hex(device.vendorId)}:${hex(device.productId)}`,
      name: label,
      transport: "webusb",
      isDefault: false,
      status: "unknown",
      detail: `USB ${hex(device.vendorId)}:${hex(device.productId)}${guess.confident ? "" : " (dugaan)"}`,
    });
  }

  return found;
}

/**
 * Printer virtual untuk runtime yang tidak punya daftar printer.
 *
 * Bukan pura-pura: browser memang **punya** satu jalur cetak, yaitu dialog
 * sistem. Melaporkannya sebagai entri membuat panel tidak pernah menampilkan
 * "tidak ada printer" di perangkat yang sebenarnya bisa mencetak.
 */
export function virtualPrinterFor(transport: "browser" | "capacitor"): PrinterInfo {
  return {
    id: `virtual:${transport}`,
    name: transport === "browser" ? "Dialog cetak sistem" : "Cetak lewat sistem",
    transport,
    isDefault: true,
    status: "ready",
    detail: "printer dipilih di dialog sistem",
  };
}

/** Runtime yang terdeteksi dari lingkungan yang diberikan. */
export interface RuntimeProbe {
  hasDesktopBridge: boolean;
  hasUsb: boolean;
  isCapacitor: boolean;
  hasPrint: boolean;
}

export function detectRuntime(probe: RuntimeProbe): PrinterTransport {
  if (probe.hasDesktopBridge) return "electron";
  if (probe.hasUsb) return "webusb";
  if (probe.hasPrint) return "browser";
  if (probe.isCapacitor) return "capacitor";
  return "none";
}

/**
 * Gabungkan semua sumber menjadi satu daftar, tanpa duplikat.
 *
 * Electron yang sudah mengenali printer USB akan melaporkannya juga lewat
 * WebUSB kalau perangkatnya pernah diberi izin. Dua entri untuk satu printer
 * fisik membingungkan operator — jadi yang pertama menang (Electron, karena
 * punya nama dan status sungguhan).
 */
export function mergePrinters(sources: readonly PrinterInfo[][]): PrinterInfo[] {
  const seen = new Map<string, PrinterInfo>();

  for (const source of sources) {
    for (const printer of source) {
      const name = printer.name.trim().toLowerCase().replaceAll(/\s+/g, " ");
      const existing = seen.get(name);

      // Belum ada dengan nama ini → simpan.
      if (existing === undefined) {
        seen.set(name, printer);
        continue;
      }

      // Sudah ada. Kalau transportnya sama tapi id-nya beda, itu **dua printer
      // berbeda yang kebetulan senama** (dua unit model yang sama) — simpan
      // keduanya di kunci terpisah. Kalau transportnya beda, itu satu printer
      // fisik yang dilaporkan dua jalur (Electron + WebUSB): yang pertama menang.
      if (existing.transport === printer.transport && existing.id !== printer.id) {
        seen.set(`${name}|${printer.transport}:${printer.id}`, printer);
      }
    }
  }

  return [...seen.values()];
}

/* ================================================================== *
 * Pengumpul — menyentuh lingkungan, jadi dipisah
 * ================================================================== */

export interface CollectDeps {
  /** Jembatan Electron, kalau ada. */
  bridge?: DesktopBridge | null;
  /** Pembaca perangkat WebUSB yang sudah diberi izin. */
  listUsbDevices?: () => Promise<UsbDeviceLike[]>;
  /** Apakah `window.print` tersedia. */
  hasPrint?: boolean;
  /** Apakah berjalan di Capacitor. */
  isCapacitor?: boolean;
}

export interface CollectResult {
  printers: PrinterInfo[];
  transport: PrinterTransport;
  /** Kesalahan per sumber; dikumpulkan, bukan dilempar, supaya satu sumber
   *  rusak tidak mengosongkan seluruh daftar. */
  problems: string[];
}

/**
 * Kumpulkan printer dari semua sumber yang tersedia.
 *
 * Satu sumber gagal (mis. WebUSB diblokir kebijakan) tidak boleh membuat
 * daftar kosong — printer dari sumber lain tetap dipakai. Karena itu setiap
 * kegagalan ditangkap dan dilaporkan sebagai `problems`, bukan dilempar.
 */
export async function collectPrinters(deps: CollectDeps): Promise<CollectResult> {
  const problems: string[] = [];
  const sources: PrinterInfo[][] = [];

  const hasDesktopBridge = deps.bridge !== null && deps.bridge !== undefined;

  if (hasDesktopBridge && deps.bridge !== null && deps.bridge !== undefined) {
    try {
      sources.push(normalizeBridgePrinters(await deps.bridge.getPrinters()));
    } catch (error) {
      problems.push(`Electron: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (deps.listUsbDevices !== undefined) {
    try {
      sources.push(normalizeUsbPrinters(await deps.listUsbDevices()));
    } catch (error) {
      problems.push(`WebUSB: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const printers = mergePrinters(sources);

  const transport = detectRuntime({
    hasDesktopBridge,
    hasUsb: deps.listUsbDevices !== undefined,
    isCapacitor: deps.isCapacitor === true,
    hasPrint: deps.hasPrint === true,
  });

  // Runtime tanpa daftar printer tetap dapat satu entri virtual, supaya panel
  // tidak berkata "tidak ada printer" di perangkat yang bisa mencetak.
  if (printers.length === 0 && (transport === "browser" || transport === "capacitor")) {
    printers.push(virtualPrinterFor(transport));
  }

  return { printers, transport, problems };
}
