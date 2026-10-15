/**
 * Kemampuan printer & pemilihannya (Fase 12, FEATURE-MATRIX #45 & #80).
 *
 * Masalah yang diselesaikan berkas ini bukan "mencetak" — itu sudah ada di
 * `printBrowser.ts`. Yang belum ada: **printer mana** yang dipakai, dan
 * **apakah perangkat ini punya printer sama sekali**.
 *
 * Kenapa logikanya diletakkan di `shared` dan bukan di studio: jawaban atas
 * pertanyaan itu berbeda-beda tergantung di mana aplikasi berjalan —
 *
 *   · **browser biasa** — tidak ada API daftar printer. Yang bisa dipakai hanya
 *     dialog cetak sistem (`window.print()`), dan tamu/operator memilih sendiri.
 *   · **Electron (desktop)** — `webContents.getPrintersAsync()` memberi daftar
 *     nama printer + status, dan cetak bisa langsung diarahkan ke salah satunya
 *     tanpa dialog.
 *   · **WebUSB** — printer USB bisa dikenali dari descriptor-nya (kelas 7 =
 *     printer) **walau OS belum punya drivernya**. Ini yang bikin kiosk bisa
 *     memberi tahu operator "printer terpasang, tapi belum siap" alih-alih
 *     mencetak ke tempat yang salah.
 *   · **Capacitor (Android/iOS)** — tidak ada printer USB langsung; jalurnya
 *     lewat plugin OS atau cetak via cloud.
 *
 * Semua lapisan itu melaporkan hal yang sama: `PrinterInfo[]`. Satu bentuk data
 * berarti panel studio tidak perlu tahu perangkatnya apa — ia hanya menampilkan
 * apa yang dilaporkan dan menyimpannya sebagai pilihan.
 *
 * Modul murni: tidak menyentuh `window`, DOM, `navigator`, atau jam sistem.
 */

/** Dari mana daftar printer ini datang. */
export const PRINTER_TRANSPORTS = [
  "electron",
  "webusb",
  "browser",
  "capacitor",
  "none",
] as const;
export type PrinterTransport = (typeof PRINTER_TRANSPORTS)[number];

export function isPrinterTransport(value: string): value is PrinterTransport {
  return (PRINTER_TRANSPORTS as readonly string[]).includes(value);
}

/**
 * Status kesiapan printer sebagaimana dilaporkan sistem.
 *
 * `unknown` bukan `offline`: OS sering tidak melaporkan status sama sekali
 * (khususnya di Linux/Electron), dan menganggap "tidak dilaporkan" sebagai
 * "mati" akan mematikan auto-print di kiosk yang sebenarnya sehat.
 */
export const PRINTER_STATUSES = ["ready", "offline", "unknown"] as const;
export type PrinterStatus = (typeof PRINTER_STATUSES)[number];

export function isPrinterStatus(value: string): value is PrinterStatus {
  return (PRINTER_STATUSES as readonly string[]).includes(value);
}

/** Kelas USB untuk printer (USB-IF base class 7). */
export const USB_PRINTER_CLASS = 7;

/** Kelas USB untuk vendor-specific — banyak printer murah memakai ini. */
export const USB_VENDOR_CLASS = 0xff;

export interface PrinterInfo {
  /** Identitas stabil dari sumbernya (nama sistem, atau path USB). */
  id: string;
  /** Nama yang ditampilkan ke operator. */
  name: string;
  transport: PrinterTransport;
  /** Apakah OS/desktop menandainya sebagai printer bawaan. */
  isDefault: boolean;
  status: PrinterStatus;
  /** Keterangan tambahan bebas (mis. "USB 04b8:0005"). */
  detail: string | null;
}

/**
 * Pilih printer yang dipakai, dengan aturan yang bisa diprediksi.
 *
 * Urutannya sengaja begini: **pilihan operator dulu**, karena itu satu-satunya
 * yang tahu niat manusia. Baru kemudian printer bawaan sistem, lalu printer
 * `ready` pertama. Kalau tidak ada satu pun yang `ready`, fungsi mengembalikan
 * `null` — bukan printer `offline`. Mencetak ke printer yang dilaporkan mati
 * hanya akan membuat tugas menggantung di antrean, dan operator tidak akan tahu
 * kenapa lembar tidak keluar.
 */
export function choosePrinter(
  printers: readonly PrinterInfo[],
  preferredId?: string | null,
): PrinterInfo | null {
  if (preferredId !== undefined && preferredId !== null && preferredId !== "") {
    const preferred = printers.find((p) => p.id === preferredId);
    if (preferred !== undefined) return preferred;
  }

  const ready = printers.filter((p) => p.status === "ready");
  const pool = ready.length > 0 ? ready : printers;

  return pool.find((p) => p.isDefault) ?? pool[0] ?? null;
}

/** Apakah printer ini aman dipakai mencetak tanpa operator melihat hasilnya. */
export function printerIsUsable(printer: PrinterInfo | null): boolean {
  return printer !== null && printer.status !== "offline";
}

/**
 * Ringkasan daftar printer untuk ditampilkan di satu baris.
 *
 * Kiosk menampilkan ini di panel status: operator perlu tahu dalam sekali lihat
 * apakah perangkatnya siap, bukan menghitung sendiri dari daftar.
 */
export interface PrinterSummary {
  total: number;
  ready: number;
  offline: number;
  /** Transport yang paling "kaya": electron > webusb > browser > capacitor > none. */
  transport: PrinterTransport;
  /** Printer yang akan dipakai `choosePrinter`. */
  chosen: PrinterInfo | null;
  /** Kalimat siap tampil untuk operator. */
  note: string;
}

/** Urutan kekayaan transport — makin kiri makin banyak yang bisa dilakukan. */
const TRANSPORT_RANK: Record<PrinterTransport, number> = {
  electron: 0,
  webusb: 1,
  browser: 2,
  capacitor: 3,
  none: 4,
};

export function summarizePrinters(
  printers: readonly PrinterInfo[],
  preferredId?: string | null,
): PrinterSummary {
  const chosen = choosePrinter(printers, preferredId);
  const ready = printers.filter((p) => p.status === "ready").length;
  const offline = printers.filter((p) => p.status === "offline").length;

  let transport: PrinterTransport = "none";
  for (const printer of printers) {
    if (TRANSPORT_RANK[printer.transport] < TRANSPORT_RANK[transport]) {
      transport = printer.transport;
    }
  }

  return {
    total: printers.length,
    ready,
    offline,
    transport,
    chosen,
    note: printerSummaryNote(printers.length, ready, chosen),
  };
}

function printerSummaryNote(
  total: number,
  ready: number,
  chosen: PrinterInfo | null,
): string {
  if (total === 0) return "Tidak ada printer terdeteksi.";
  if (chosen === null) return `${total} printer terdaftar, tidak ada yang bisa dipakai.`;
  if (ready === 0) return `${total} printer terdaftar, statusnya tidak dilaporkan sistem.`;
  return `${ready} dari ${total} printer siap — memakai "${chosen.name}".`;
}

/**
 * Apakah sebuah perangkat USB ini printer.
 *
 * Dipakai WebUSB: descriptor `deviceClass` 7 adalah printer menurut USB-IF.
 * Banyak printer murah (dan sebagian printer thermal) melaporkan kelas `0xff`
 * (vendor-specific) atau `0` di level device, dan kelas sebenarnya baru muncul
 * di **interface**. Karena itu fungsi menerima keduanya, dan menandai mana yang
 * hanya dugaan lewat `confident`.
 *
 * Nama produk ikut dilihat karena itu satu-satunya petunjuk yang tersedia untuk
 * perangkat dengan descriptor kosong — dan itu memang sering terjadi.
 */
export interface UsbDescriptor {
  /** Kelas di level device (0 = kelas ada di interface). */
  classCode: number;
  /** Kelas di level interface, kalau ada. */
  interfaceClass?: number | null;
  productName?: string | null;
}

export interface UsbPrinterGuess {
  isPrinter: boolean;
  /** `true` kalau kelasnya jelas printer; `false` kalau hanya cocok nama. */
  confident: boolean;
  reason: string;
}

/** Kata kunci nama produk yang biasanya menandakan printer. */
const PRINTER_NAME_HINTS: readonly string[] = [
  "printer",
  "pos-",
  "thermal",
  "receipt",
  "dymo",
  "brother",
  "epson",
  "canon",
  "hp ",
  "hewlett",
  "xprinter",
  "zebra",
  "citizen",
  "bixolon",
  "godex",
  "tsc ",
  "selphy",
  "pictbridge",
];

export function classifyUsbPrinter(descriptor: UsbDescriptor): UsbPrinterGuess {
  const deviceClass = descriptor.classCode;
  const interfaceClass = descriptor.interfaceClass ?? null;

  if (deviceClass === USB_PRINTER_CLASS) {
    return { isPrinter: true, confident: true, reason: "kelas USB 7 (printer)" };
  }

  if (interfaceClass === USB_PRINTER_CLASS) {
    return { isPrinter: true, confident: true, reason: "interface kelas USB 7 (printer)" };
  }

  const name = (descriptor.productName ?? "").toLowerCase();
  if (name !== "") {
    const hint = PRINTER_NAME_HINTS.find((h) => name.includes(h));
    if (hint !== undefined) {
      return {
        isPrinter: true,
        confident: false,
        reason: `nama produk mengandung "${hint.trim()}" (descriptor tidak menyebut kelas)`,
      };
    }
  }

  if (deviceClass === USB_VENDOR_CLASS) {
    return {
      isPrinter: false,
      confident: false,
      reason: "kelas vendor-specific (0xff) tanpa petunjuk nama — tidak bisa dipastikan",
    };
  }

  if (deviceClass === 0 || interfaceClass === 0) {
    return { isPrinter: false, confident: false, reason: "kelas USB tidak dilaporkan" };
  }

  return { isPrinter: false, confident: false, reason: `bukan kelas printer (${deviceClass})` };
}

/* ================================================================== *
 * Pilihan printer yang bertahan antar-restart
 * ================================================================== */

export const PRINTER_PREF_KEY = "foto-booth:printer";

export interface PrinterPreference {
  /** `id` printer yang dipilih operator; `null` = ikut bawaan sistem. */
  printerId: string | null;
  /** Cetak tanpa dialog kalau runtime mendukung (Electron). */
  silent: boolean;
}

export const PRINTER_DEFAULT_PREF: PrinterPreference = {
  printerId: null,
  silent: false,
};

/**
 * Baca preferensi dari string JSON.
 *
 * Toleran dengan sengaja: nilai rusak tidak melempar, hanya jatuh ke default.
 * Preferensi printer tidak boleh membuat studio gagal dibuka — kiosk di acara
 * harus tetap jalan walau localStorage-nya korup.
 */
export function parsePrinterPreference(raw: string | null): PrinterPreference {
  if (raw === null) return PRINTER_DEFAULT_PREF;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return PRINTER_DEFAULT_PREF;

    const record = parsed as Record<string, unknown>;
    const printerId =
      typeof record.printerId === "string" && record.printerId !== ""
        ? record.printerId
        : null;

    return { printerId, silent: record.silent === true };
  } catch {
    return PRINTER_DEFAULT_PREF;
  }
}

export function serializePrinterPreference(pref: PrinterPreference): string {
  return JSON.stringify({ printerId: pref.printerId, silent: pref.silent });
}
