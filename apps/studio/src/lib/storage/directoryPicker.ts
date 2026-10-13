/**
 * Folder arsip lokal — File System Access API, dengan **fallback OPFS**.
 *
 * Sesi foto yang panjang meninggalkan banyak arsip lokal (OPFS) untuk jaga-jaga
 * kalau upload tertunda. Operator sering ingin arsip itu duduk di folder yang
 * **ia kenal** (mis. folder khusus di desktop) supaya bisa disalin ke drive
 * cadangan. File System Access API memungkinkan itu; kalau tidak ada (Safari,
 * Firefox) atau izinnya ditolak, kita jatuh ke OPFS.
 *
 * Aturan yang tidak boleh dilanggar (sama seperti arsip OPFS di Fase 5):
 * **menulis arsip itu best-effort.** Apa pun yang gagal — picker ditolak,
 * folder hilang, kuota penuh — hasilnya `false`, bukan lempar. Upload foto
 * tidak pernah bergantung pada arsip lokal.
 */

import type { ArchiveDirectory } from "../upload/localArchive.ts";

export type ArchiveBackend = "fs-access" | "opfs" | "none";

/** Subset `FileSystemWritableFileStream`. */
export interface WritableLike {
  write(data: unknown): Promise<void>;
  close(): Promise<void>;
}

/** Subset `FileSystemFileHandle`. */
export interface FileHandleLike {
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
}

/** Subset `FileSystemDirectoryHandle`. */
export interface DirHandleLike {
  readonly name?: string;
  getDirectoryHandle?(name: string, options?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
  values?(): AsyncIterableIterator<{ kind: string; name: string }>;
}

/** Ketergantungan yang bisa disuntik (browser asli atau palsu di tes). */
export interface ArchiveDeps {
  /** `window.showDirectoryPicker`. */
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite"; id?: string }) => Promise<DirHandleLike>;
  /** `navigator.storage` — untuk OPFS lewat `getDirectory()`. */
  storage?: { getDirectory(): Promise<DirHandleLike> };
}

export interface ArchiveTarget {
  backend: ArchiveBackend;
  /** Label untuk UI ("Folder pilihan" / "Arsip aplikasi"). */
  label: string;
  /** Handle direktori — dipakai pemanggil yang ingin menulis lewat jalurnya sendiri. */
  handle: DirHandleLike;
  /** Simpan satu berkas. `false` = gagal; tidak pernah melempar. */
  save(name: string, data: Blob | ArrayBuffer | Uint8Array): Promise<boolean>;
  /** Nama berkas yang ada di folder ini. */
  list(): Promise<string[]>;
}

/** Backend mana yang tersedia, berurut prioritas (folder pilihan dulu). */
export function chooseArchiveBackend(deps: ArchiveDeps): ArchiveBackend {
  if (typeof deps.showDirectoryPicker === "function") return "fs-access";
  if (deps.storage !== undefined && typeof deps.storage.getDirectory === "function") return "opfs";
  return "none";
}

export function describeArchiveBackend(backend: ArchiveBackend): string {
  switch (backend) {
    case "fs-access":
      return "Folder pilihan";
    case "opfs":
      return "Arsip aplikasi (OPFS)";
    default:
      return "Tidak ada arsip lokal";
  }
}

/**
 * Nama berkas arsip yang aman.
 *
 * Sama semangatnya dengan rute `/models/*`: nama dari luar tidak boleh keluar
 * dari folder tujuan. Tolak apa pun yang punya pemisah path atau `..`.
 */
export function safeArchiveName(name: string): string | null {
  if (name.length === 0 || name.length > 200) return null;
  if (name.includes("/") || name.includes("\\")) return null;
  if (name.includes("..") || name.includes("\0")) return null;
  return name;
}

/** Apakah error ini "pengguna membatalkan" (bukan kegagalan). */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError";
}

/** Tulis satu berkas ke direktori; `false` kalau gagal, tidak pernah melempar. */
export async function writeArchiveFile(
  dir: DirHandleLike,
  name: string,
  data: Blob | ArrayBuffer | Uint8Array,
): Promise<boolean> {
  const safe = safeArchiveName(name);
  if (safe === null) return false;

  try {
    const handle = await dir.getFileHandle(safe, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(data);
    } finally {
      // `close` wajib dipanggil supaya data benar-benar ter-flush; kalau
      // `write` melempar, `close` tetap dicoba lalu error-nya ditelan di luar.
      await writable.close();
    }
    return true;
  } catch {
    return false;
  }
}

async function listDirectory(dir: DirHandleLike): Promise<string[]> {
  if (typeof dir.values !== "function") return [];
  try {
    const names: string[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind === "file") names.push(entry.name);
    }
    return names.sort();
  } catch {
    return [];
  }
}

function target(backend: ArchiveBackend, dir: DirHandleLike): ArchiveTarget {
  return {
    backend,
    label: describeArchiveBackend(backend),
    handle: dir,
    save: (name, data) => writeArchiveFile(dir, name, data),
    list: () => listDirectory(dir),
  };
}

/**
 * Minta folder arsip dari operator.
 *
 * Perilaku tiap hasil:
 *   · operator memilih folder        → target `fs-access`;
 *   · operator menutup dialog        → `null` (ia memang tidak mau; jangan
 *                                       diam-diam pakai OPFS);
 *   · izin ditolak / API error       → **fallback OPFS**;
 *   · tidak ada API sama sekali      → OPFS, atau `null` kalau itu pun tidak ada.
 */
export async function pickArchiveTarget(deps: ArchiveDeps): Promise<ArchiveTarget | null> {
  if (typeof deps.showDirectoryPicker === "function") {
    try {
      const dir = await deps.showDirectoryPicker({ mode: "readwrite", id: "fb-archive" });
      return target("fs-access", dir);
    } catch (error) {
      if (isAbortError(error)) return null;
      // Izin ditolak / error lain → lanjut ke OPFS di bawah.
    }
  }

  if (deps.storage !== undefined && typeof deps.storage.getDirectory === "function") {
    try {
      const dir = await deps.storage.getDirectory();
      return target("opfs", dir);
    } catch {
      return null;
    }
  }

  return null;
}

/** Ketergantungan nyata dari global browser (File System Access + OPFS). */
export function browserArchiveDeps(): ArchiveDeps {
  const picker =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as { showDirectoryPicker?: ArchiveDeps["showDirectoryPicker"] })
          .showDirectoryPicker;

  return {
    ...(typeof picker === "function" ? { showDirectoryPicker: picker.bind(window) } : {}),
    ...(typeof navigator === "undefined"
      ? {}
      : { storage: navigator.storage as ArchiveDeps["storage"] }),
  };
}

/**
 * Ubah handle arsip jadi penyedia direktori untuk `LocalArchive`.
 *
 * Handle File System Access nyata selalu punya `getDirectoryHandle`; kontrak
 * `DirHandleLike` sengaja lebih longgar karena tes memakai direktori palsu.
 * Konversinya dikumpulkan di sini supaya pemanggil tidak menyebar cast.
 */
export function asArchiveRoot(dir: DirHandleLike): () => Promise<ArchiveDirectory> {
  return async () => dir as unknown as ArchiveDirectory;
}
