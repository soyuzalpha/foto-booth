/**
 * Diagnostik perangkat & laporan siap kirim (Fase 12, FEATURE-MATRIX #81).
 *
 * Ini bagian yang biasanya dilupakan sampai acara pertama gagal: operator
 * menelepon dan berkata "tidak bisa cetak", dan tidak ada satu pun informasi
 * yang cukup untuk menjawabnya dari jauh. Yang dibutuhkan bukan data banyak —
 * hanya data **yang tepat**, dan yang pasti tidak berisi rahasia.
 *
 * Aturan yang dipegang berkas ini:
 *
 *   · **Tidak ada rahasia di laporan.** Tidak ada `JWT_SECRET`, token sesi,
 *     password SMTP, kredensial S3, atau nama tamu. Yang dikirim adalah versi,
 *     kapabilitas, dan status perangkat.
 *   · **Tidak ada tebakan yang ditulis sebagai fakta.** Kalau `navigator`
 *     tidak melaporkan sesuatu, nilainya `null` — bukan ditebak.
 *   · **Satu laporan, dua bentuk.** JSON untuk lampiran, teks untuk disalin ke
 *     WhatsApp/email. Keduanya dibangun dari objek yang sama, jadi tidak
 *     mungkin berbeda isi.
 *
 * Modul murni: menerima input yang sudah dikumpulkan pemanggil, tidak menyentuh
 * `navigator`/`window` sendiri. Itu yang membuatnya bisa diuji tanpa browser.
 */

import type { PrinterInfo, PrinterSummary } from "./printer.ts";

/** Bentuk laporan; `null` berarti "runtime tidak melaporkan", bukan "tidak ada". */
export interface DiagnosticReport {
  /** Versi aplikasi (dari `APP_VERSION`). */
  appVersion: string;
  /** Waktu laporan dibuat, ISO. */
  generatedAt: string;
  runtime: string;
  runtimeVersion: string | null;
  platform: string | null;
  userAgent: string | null;
  /** Apakah halaman berjalan di secure context (wajib untuk kamera/USB). */
  secureContext: boolean;
  /** Apakah perangkat melaporkan sedang offline. */
  online: boolean;
  capabilities: DiagnosticCapabilities;
  printers: PrinterInfo[];
  printersSummary: string;
  /** Catatan tambahan yang diisi pemanggil (mis. hasil pemeriksaan kamera). */
  notes: string[];
}

export interface DiagnosticCapabilities {
  camera: boolean;
  webusb: boolean;
  webcodecs: boolean;
  webgl: boolean;
  serviceWorker: boolean;
  storage: boolean;
  fullscreen: boolean;
  wakeLock: boolean;
}

export const EMPTY_CAPABILITIES: DiagnosticCapabilities = {
  camera: false,
  webusb: false,
  webcodecs: false,
  webgl: false,
  serviceWorker: false,
  storage: false,
  fullscreen: false,
  wakeLock: false,
};

/**
 * Label manusia untuk setiap kemampuan.
 *
 * Diekspor supaya panel studio dan laporan teks memakai istilah yang sama —
 * kalau operator membaca "WebUSB: tidak ada" di panel, laporan yang dikirim ke
 * pengembang harus menyebut hal yang sama, bukan kode internal.
 */
export const CAPABILITY_LABELS: Record<keyof DiagnosticCapabilities, string> = {
  camera: "Kamera (getUserMedia)",
  webusb: "Akses USB (WebUSB)",
  webcodecs: "Video (WebCodecs)",
  webgl: "Percepatan grafis (WebGL)",
  serviceWorker: "Mode offline (service worker)",
  storage: "Penyimpanan lokal",
  fullscreen: "Layar penuh",
  wakeLock: "Layar tetap menyala (wake lock)",
};

/** Kemampuan yang hilang — yang perlu diberitahukan ke operator lebih dulu. */
export function missingCapabilities(caps: DiagnosticCapabilities): (keyof DiagnosticCapabilities)[] {
  return (Object.keys(CAPABILITY_LABELS) as (keyof DiagnosticCapabilities)[]).filter(
    (key) => !caps[key],
  );
}

/**
 * Skor kesiapan 0–100, untuk indikator satu angka di panel.
 *
 * Bobotnya tidak rata dengan sengaja: kiosk yang tidak bisa memakai kamera
 * sama sekali tidak berguna, sedangkan wake lock hanya kenyamanan. Memberi
 * bobot yang sama akan menampilkan "80% siap" untuk perangkat yang sebenarnya
 * tidak bisa memotret.
 */
const CAPABILITY_WEIGHTS: Record<keyof DiagnosticCapabilities, number> = {
  camera: 30,
  storage: 20,
  webgl: 15,
  serviceWorker: 15,
  fullscreen: 8,
  webcodecs: 6,
  webusb: 4,
  wakeLock: 2,
};

export function readinessScore(caps: DiagnosticCapabilities): number {
  let score = 0;
  for (const key of Object.keys(CAPABILITY_WEIGHTS) as (keyof DiagnosticCapabilities)[]) {
    if (caps[key]) score += CAPABILITY_WEIGHTS[key];
  }
  return score;
}

/** Label ringkas untuk skor kesiapan. */
export function readinessLabel(score: number): string {
  if (score >= 90) return "siap";
  if (score >= 70) return "siap dengan catatan";
  if (score >= 40) return "terbatas";
  return "tidak siap";
}

export interface BuildDiagnosticInput {
  appVersion: string;
  generatedAt: string;
  runtime: string;
  runtimeVersion?: string | null;
  platform?: string | null;
  userAgent?: string | null;
  secureContext: boolean;
  online: boolean;
  capabilities: DiagnosticCapabilities;
  printers?: readonly PrinterInfo[];
  printersSummary?: PrinterSummary | null;
  notes?: readonly string[];
}

export function buildDiagnosticReport(input: BuildDiagnosticInput): DiagnosticReport {
  const printers = [...(input.printers ?? [])];
  return {
    appVersion: input.appVersion,
    generatedAt: input.generatedAt,
    runtime: input.runtime,
    runtimeVersion: input.runtimeVersion ?? null,
    platform: input.platform ?? null,
    userAgent: input.userAgent ?? null,
    secureContext: input.secureContext,
    online: input.online,
    capabilities: { ...input.capabilities },
    printers,
    printersSummary: input.printersSummary?.note ?? summarizeForReport(printers),
    notes: [...(input.notes ?? [])],
  };
}

function summarizeForReport(printers: readonly PrinterInfo[]): string {
  if (printers.length === 0) return "Tidak ada printer terdeteksi.";
  return `${printers.length} printer terdaftar.`;
}

/**
 * Laporan sebagai teks siap tempel (WhatsApp/email). Tanpa JSON — operator
 * mengirim ini ke teknisi, dan JSON mentah jarang bisa dibaca di HP.
 */
export function diagnosticReportText(report: DiagnosticReport): string {
  const lines: string[] = [
    `Laporan diagnostik ${report.appVersion}`,
    `Dibuat: ${report.generatedAt}`,
    "",
    `Runtime: ${report.runtime}${report.runtimeVersion !== null ? ` ${report.runtimeVersion}` : ""}`,
    `Platform: ${report.platform ?? "tidak dilaporkan"}`,
    `Secure context: ${report.secureContext ? "ya" : "TIDAK (kamera/USB akan gagal)"}`,
    `Jaringan: ${report.online ? "tersambung" : "terputus"}`,
    "",
    "Kemampuan:",
  ];

  for (const key of Object.keys(CAPABILITY_LABELS) as (keyof DiagnosticCapabilities)[]) {
    const status = report.capabilities[key] ? "ada" : "tidak ada";
    lines.push(`  - ${CAPABILITY_LABELS[key]}: ${status}`);
  }

  const score = readinessScore(report.capabilities);
  lines.push("", `Kesiapan: ${score}/100 (${readinessLabel(score)})`);
  lines.push("", `Printer: ${report.printersSummary}`);

  for (const printer of report.printers) {
    const flags = [printer.isDefault ? "bawaan" : null, printer.status].filter(
      (f): f is string => f !== null,
    );
    lines.push(`  - ${printer.name} [${printer.transport}; ${flags.join(", ")}]`);
  }

  if (report.notes.length > 0) {
    lines.push("", "Catatan:");
    for (const note of report.notes) lines.push(`  - ${note}`);
  }

  return lines.join("\n");
}

/** Nama berkas lampiran yang bisa diprediksi teknisi. */
export function diagnosticFileName(report: DiagnosticReport): string {
  const stamp = report.generatedAt.replaceAll(/[:.]/g, "-");
  return `diagnostik-foto-booth-${stamp}.json`;
}
