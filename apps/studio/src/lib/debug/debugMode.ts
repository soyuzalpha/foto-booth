/**
 * Mode debug — murni.
 *
 * Operator perlu bisa melihat apa yang sebenarnya terjadi di kiosk (kuota
 * storage, service worker, cache model) tanpa membuka DevTools — sering tidak
 * ada keyboard di meja foto booth. Mode debug dinyalakan lewat `?debug=1` atau
 * disimpan di `localStorage`, dan menampilkan panel laporan.
 *
 * Logika pembacaan flag & peringkasan laporan dipisah dari DOM supaya bisa
 * diuji: parsing query string dan ambang batas kuota adalah hal yang gampang
 * salah, dan tidak ingin itu ikut rusak saat UI diubah.
 */

export interface StorageReport {
  /** `navigator.storage.persisted()`; `null` = API tidak ada. */
  persisted: boolean | null;
  /** Byte terpakai; `null` = tidak diketahui. */
  usageBytes: number | null;
  /** Kuota byte; `null` = tidak diketahui. */
  quotaBytes: number | null;
  /** Nama Cache Storage yang ada (mis. `fb-models`). */
  cacheNames: readonly string[];
  /** Service worker sedang mengendalikan halaman ini. */
  serviceWorkerActive: boolean;
  /** Model AI sudah tersimpan di cache (siap offline). */
  modelCacheReady: boolean;
}

const TRUTHY = new Set(["1", "true", "on", "yes", "ya"]);
const FALSY = new Set(["0", "false", "off", "no", "tidak"]);

/** Kunci `localStorage` yang menyimpan pilihan mode debug operator. */
export const DEBUG_STORAGE_KEY = "fb-debug";

/**
 * Apakah mode debug aktif.
 *
 * Query string **menang** atas `localStorage`: operator yang menempelkan
 * `?debug=0` di URL ingin mematikannya untuk kunjungan itu saja, bukan
 * mengubah setelan permanen.
 */
export function parseDebugFlag(search: string, storedValue: string | null): boolean {
  const value = readQueryParam(search, "debug");
  if (value !== null) {
    const normalized = value.trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
  }
  if (storedValue === null) return false;
  return TRUTHY.has(storedValue.trim().toLowerCase());
}

function readQueryParam(search: string, name: string): string | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw.length === 0) return null;

  for (const part of raw.split("&")) {
    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    if (decodeURIComponent(key) !== name) continue;
    return eq === -1 ? "" : decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

/** Byte → teks yang enak dibaca ("1,5 GB"), pakai koma desimal Indonesia. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "tidak diketahui";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  const text = value.toFixed(digits).replace(".", ",");
  return `${text} ${units[unitIndex]}`;
}

/** Kuota di bawah ini dianggap berisiko untuk sesi panjang tanpa internet. */
export const LOW_QUOTA_BYTES = 512 * 1024 * 1024;

export interface StorageSummary {
  lines: string[];
  warnings: string[];
}

/**
 * Ringkas laporan storage jadi baris-baris yang bisa ditampilkan apa adanya.
 *
 * Peringatan sengaja deskriptif ("storage belum persisten — browser bisa
 * menghapus arsip"), bukan kode, karena yang membacanya operator, bukan
 * programmer.
 */
export function summarizeStorageReport(report: StorageReport): StorageSummary {
  const lines: string[] = [
    `Storage persisten: ${describePersisted(report.persisted)}`,
    `Terpakai: ${formatBytes(report.usageBytes)}`,
    `Kuota: ${formatBytes(report.quotaBytes)}`,
    `Cache: ${report.cacheNames.length === 0 ? "belum ada" : report.cacheNames.join(", ")}`,
    `Service worker: ${report.serviceWorkerActive ? "aktif" : "tidak aktif"}`,
    `Model AI: ${report.modelCacheReady ? "siap offline" : "belum di-cache"}`,
  ];

  const warnings: string[] = [];
  if (report.persisted === false) {
    warnings.push("Storage belum persisten — browser bisa menghapus arsip saat ruang menipis.");
  }
  if (report.quotaBytes !== null && report.quotaBytes < LOW_QUOTA_BYTES) {
    warnings.push(`Kuota storage rendah (${formatBytes(report.quotaBytes)}) — sesi panjang bisa kehabisan ruang.`);
  }
  if (!report.serviceWorkerActive) {
    warnings.push("Service worker tidak aktif — aplikasi belum tentu jalan offline.");
  }

  return { lines, warnings };
}

function describePersisted(persisted: boolean | null): string {
  if (persisted === null) return "tidak didukung browser";
  return persisted ? "ya" : "belum";
}
