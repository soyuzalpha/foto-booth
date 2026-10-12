/**
 * Cetak lewat iframe tersembunyi.
 *
 * Kenapa iframe dan bukan `window.print()` di halaman utama: halaman studio itu
 * satu halaman panjang (kamera + editor + panel). Mencetak halaman itu berarti
 * mencetak seluruh UI. Yang dicetak harus **hanya lembar cetak**, dengan
 * `@page` yang ukurannya pas. Iframe terpisah memberi kita dokumen sendiri
 * tanpa menyentuh DOM aplikasi.
 *
 * Dua hal yang gampang salah dan sengaja dijaga:
 *
 *   · **`@page { size: Wmm Hmm; margin: 0 }`** — tanpa `margin: 0`, Chromium
 *     menambahkan margin default (~0,4 in) dan gambar mengecil. Tanpa `size`,
 *     dialog print memakai Letter/A4 dan 2×6 tidak akan pas.
 *   · **Iframe harus dilepas setelah `afterprint`.** Kalau tidak, tiap kali
 *     user menekan "Cetak", satu iframe + satu blob URL tertinggal hidup.
 *     `afterprint` tidak selalu menyala (user bisa menutup dialog dengan Esc di
 *     beberapa build), jadi ada timeout jaring pengaman.
 */

import {
  printSizeMm,
  type PrintPreset,
} from "@foto-booth/shared";

/** Dokumen print yang dibuat: HTML + lebar/tinggi lembar dalam mm. */
export interface PrintDocument {
  html: string;
  /** Ukuran `@page`, mm — dibulatkan 2 desimal. */
  widthMm: number;
  heightMm: number;
}

export interface BuildPrintDocumentOptions {
  /** Data URL gambar lembar (PNG/JPEG) yang akan dicetak. */
  imageUrl: string;
  /** Judul dokumen — muncul di header/footer dialog print. */
  title?: string;
  /** Ikutkan bleed di ukuran kertas. */
  includeBleed?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Bangun dokumen print untuk satu gambar lembar.
 *
 * Gambar dibentangkan **persis** seukuran kertas (`width:100%`), bukan
 * `object-fit: contain` dengan tinggi `auto`: kalau tingginya auto dan rasio
 * gambar beda sedikit dari `@page`, printer akan mengecilkan semuanya.
 */
export function buildPrintDocument(
  preset: Pick<PrintPreset, "width" | "height" | "bleed" | "name">,
  options: BuildPrintDocumentOptions,
): PrintDocument {
  const includeBleed = options.includeBleed === true;
  const mm = printSizeMm(preset, { includeBleed });
  const title = options.title ?? preset.name;

  const html = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: ${mm.width}mm ${mm.height}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  img { display: block; width: 100%; height: 100%; object-fit: fill; }
</style>
</head>
<body><img src="${escapeHtml(options.imageUrl)}" alt=""></body>
</html>`;

  return { html, widthMm: mm.width, heightMm: mm.height };
}

export interface PrintDeps {
  /** Pembuat iframe; bisa di-inject untuk tes. */
  createIframe?: () => HTMLIFrameElement;
  /** Timer, injectable supaya tes tidak menunggu detik nyata. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Batas tunggu `afterprint` sebelum iframe dipaksa dilepas. */
  cleanupMs?: number;
  /** Objek URL; bisa di-inject untuk tes. */
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  /** Jendela induk tempat iframe ditempel. */
  document?: Document;
}

const DEFAULT_CLEANUP_MS = 60_000;

export interface PrintHandle {
  /** Iframe yang dibuat; `null` kalau pembuatan gagal. */
  iframe: HTMLIFrameElement | null;
  /** URL blob dokumen; `null` kalau pembuatan gagal. */
  url: string | null;
  /** Lepas iframe + revoke URL. Aman dipanggil berkali-kali. */
  dispose(): void;
  /** Apakah `window.print()` sudah dipanggil di dalam iframe. */
  printed: boolean;
}

/**
 * Cetak gambar lewat iframe tersembunyi.
 *
 * Selalu melepas sumber daya lewat `dispose()` — dipanggil otomatis saat
 * `afterprint`, atau setelah `cleanupMs` kalau event itu tidak pernah datang.
 * Pemanggil boleh memanggil `dispose()` sendiri (mis. saat unmount).
 */
export function printImage(
  preset: Pick<PrintPreset, "width" | "height" | "bleed" | "name">,
  imageUrl: string,
  deps: PrintDeps = {},
): PrintHandle {
  const doc = deps.document ?? document;
  const createIframe = deps.createIframe ?? (() => doc.createElement("iframe"));
  const setTimer = deps.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as number));
  const cleanupMs = deps.cleanupMs ?? DEFAULT_CLEANUP_MS;
  const createObjectUrl = deps.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectUrl = deps.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));

  const built = buildPrintDocument(preset, { imageUrl });
  const blob = new Blob([built.html], { type: "text/html" });

  const iframe = createIframe();
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("data-print-frame", "1");
  // Ukuran iframe tidak penting untuk hasil cetak (yang dicetak dokumen di
  // dalamnya), tapi harus ada supaya iframe tidak memengaruhi layout.
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "1px";
  iframe.style.height = "1px";
  iframe.style.opacity = "0";
  iframe.style.pointerEvents = "none";
  iframe.style.border = "0";

  const url = createObjectUrl(blob);
  const handle: PrintHandle = {
    iframe,
    url,
    printed: false,
    dispose: () => {},
  };

  let timer: unknown = null;
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }

    iframe.removeEventListener("load", onLoad);
    iframe.contentWindow?.removeEventListener("afterprint", onAfterPrint);
    iframe.remove();
    revokeObjectUrl(url);
  };
  handle.dispose = dispose;

  const onAfterPrint = (): void => {
    // Beri jeda singkat supaya print engine sempat membaca dokumen.
    setTimer(dispose, 0);
  };

  function onLoad(): void {
    const win = iframe.contentWindow;
    if (win === null) return;

    win.addEventListener("afterprint", onAfterPrint);
    win.focus();

    try {
      win.print();
      handle.printed = true;
    } catch {
      // Browser bisa menolak print (mis. iframe belum terpasang). Jaring
      // pengaman tetap melepas iframe supaya tidak menumpuk.
    }

    timer = setTimer(dispose, cleanupMs);
  }

  iframe.addEventListener("load", onLoad);
  iframe.src = url;
  doc.body.append(iframe);

  return handle;
}

/**
 * Blob → data URL.
 *
 * Dipakai sebelum mencetak: dokumen print dibuat dari **blob URL**, dan
 * dokumen di dalam iframe itu tidak boleh mengandalkan blob URL lain dari
 * halaman induk (orisinnya bisa opaque). Data URL menghilangkan ketergantungan
 * itu — gambar benar-benar tertanam di dokumen.
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("FileReader tidak menghasilkan data URL"));
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("gagal membaca blob jadi data URL")),
    );
    reader.readAsDataURL(blob);
  });
}

/**
 * Pratinjau print: dokumen yang sama dengan yang dicetak, tapi ditampilkan
 * sebagai elemen `img` — supaya user melihat **persis** apa yang akan keluar
 * di dialog, sebelum menekan Cetak.
 */
export interface PrintPreview {
  /** Ukuran lembar, px @300 dpi. */
  width: number;
  height: number;
  /** Ukuran `@page`, mm — sama dengan yang dipakai dokumen print. */
  widthMm: number;
  heightMm: number;
}

export function printPreviewMeta(
  preset: Pick<PrintPreset, "width" | "height" | "dpi" | "bleed">,
  options: { includeBleed?: boolean } = {},
): PrintPreview {
  const mm = printSizeMm(preset, options);
  const dpi = preset.dpi;
  const bleed = options.includeBleed === true ? preset.bleed : 0;

  return {
    width: Math.round((preset.width + bleed * 2) * dpi),
    height: Math.round((preset.height + bleed * 2) * dpi),
    widthMm: mm.width,
    heightMm: mm.height,
  };
}
