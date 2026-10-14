/**
 * Simpan teks CSV sebagai unduhan.
 *
 * Dipisah dari komponen supaya bisa diuji tanpa DOM dan supaya berkas panel
 * tetap hanya mengekspor komponen (aturan fast refresh). Dua janji:
 *
 *   · **BOM di depan.** Excel di Windows membaca CSV tanpa BOM sebagai ANSI,
 *     dan nama tamu beraksen jadi rusak. BOM tidak mengubah isi sel.
 *   · **Tanpa DOM, diam.** Lingkungan uji (Node) tidak punya `document`; di
 *     sana fungsi ini tidak melakukan apa pun alih-alih melempar.
 */

export interface DownloadDeps {
  document?: Document;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  /** Jeda sebelum URL dilepas; di-inject untuk tes. */
  setTimer?: (fn: () => void, ms: number) => unknown;
}

/** Jeda sebelum blob dilepas. Melepas langsung bisa membatalkan unduhan di Safari. */
export const REVOKE_DELAY_MS = 10_000;

export function downloadCsv(filename: string, csv: string, deps: DownloadDeps = {}): boolean {
  const doc = deps.document ?? (typeof document === "undefined" ? null : document);
  const createObjectUrl = deps.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectUrl = deps.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));

  if (doc === null) return false;

  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = createObjectUrl(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = filename;
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setTimer(() => revokeObjectUrl(url), REVOKE_DELAY_MS);
  return true;
}
