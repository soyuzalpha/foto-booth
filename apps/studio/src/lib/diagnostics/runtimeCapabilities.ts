/**
 * Pemeriksaan kemampuan perangkat dari lingkungan nyata (Fase 12, #81).
 *
 * Keputusan **apa arti** sebuah kemampuan ada di `packages/shared/diagnostics.ts`
 * (murni, teruji). Berkas ini hanya menjawab "apakah lingkungan ini punya X",
 * dan ia menyentuh `navigator`/`window` — jadi setiap pembacaan dibungkus dan
 * tidak pernah melempar.
 *
 * Alasan setiap pemeriksaan dibungkus: laporan diagnostik dipakai justru saat
 * ada yang rusak. Kalau pemeriksaannya sendiri melempar di perangkat aneh,
 * operator kehilangan satu-satunya alat yang bisa dikirim ke teknisi.
 */

import {
  EMPTY_CAPABILITIES,
  type DiagnosticCapabilities,
} from "@foto-booth/shared";

/** Apakah `navigator.mediaDevices.getUserMedia` ada. */
function hasCamera(): boolean {
  try {
    const nav = globalThis.navigator as { mediaDevices?: { getUserMedia?: unknown } } | undefined;
    return typeof nav?.mediaDevices?.getUserMedia === "function";
  } catch {
    return false;
  }
}

function hasWebUsb(): boolean {
  try {
    return (globalThis.navigator as { usb?: unknown } | undefined)?.usb !== undefined;
  } catch {
    return false;
  }
}

function hasWebCodecs(): boolean {
  try {
    const scope = globalThis as { VideoEncoder?: unknown; VideoDecoder?: unknown };
    return typeof scope.VideoEncoder === "function" && typeof scope.VideoDecoder === "function";
  } catch {
    return false;
  }
}

/** WebGL dianggap ada kalau canvas bisa memberi konteks `webgl2`/`webgl`. */
function hasWebGl(): boolean {
  try {
    const doc = globalThis.document as
      | { createElement(tag: string): { getContext(name: string): unknown } }
      | undefined;
    if (doc === undefined) return false;
    const canvas = doc.createElement("canvas");
    return canvas.getContext("webgl2") !== null || canvas.getContext("webgl") !== null;
  } catch {
    return false;
  }
}

function hasServiceWorker(): boolean {
  try {
    return (globalThis.navigator as { serviceWorker?: unknown } | undefined)?.serviceWorker !== undefined;
  } catch {
    return false;
  }
}

/** Penyimpanan lokal dianggap ada kalau benar-benar bisa ditulis. */
function hasStorage(): boolean {
  try {
    const store = globalThis.localStorage;
    if (store === undefined) return false;
    const probe = "__fb-diag__";
    store.setItem(probe, "1");
    store.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function hasFullscreen(): boolean {
  try {
    const doc = globalThis.document as { fullscreenEnabled?: boolean } | undefined;
    return doc?.fullscreenEnabled === true;
  } catch {
    return false;
  }
}

function hasWakeLock(): boolean {
  try {
    return typeof (globalThis.navigator as { wakeLock?: unknown } | undefined)?.wakeLock === "object";
  } catch {
    return false;
  }
}

/**
 * Periksa semua kemampuan sekarang.
 *
 * Tidak ada satu pun pemeriksaan yang bisa melempar keluar dari fungsi ini —
 * kegagalan berarti "tidak ada", sesuai arti `EMPTY_CAPABILITIES`.
 */
export function probeCapabilities(): DiagnosticCapabilities {
  return {
    ...EMPTY_CAPABILITIES,
    camera: hasCamera(),
    webusb: hasWebUsb(),
    webcodecs: hasWebCodecs(),
    webgl: hasWebGl(),
    serviceWorker: hasServiceWorker(),
    storage: hasStorage(),
    fullscreen: hasFullscreen(),
    wakeLock: hasWakeLock(),
  };
}

/**
 * Nama runtime yang bisa dibaca manusia.
 *
 * Urutannya penting: shell Electron juga punya `navigator.usb`, jadi Electron
 * harus dikenali lebih dulu supaya laporan tidak menyebut "browser biasa" untuk
 * kiosk yang sebenarnya paket desktop.
 */
export function detectRuntimeName(scope: {
  hasDesktopBridge: boolean;
  isCapacitor: boolean;
}): string {
  if (scope.hasDesktopBridge) return "Electron (desktop)";
  if (scope.isCapacitor) return "Capacitor (mobile)";
  return "Browser";
}

/** Apakah halaman berjalan di secure context (wajib untuk kamera/USB). */
export function isSecureContext(): boolean {
  try {
    return globalThis.isSecureContext === true;
  } catch {
    return false;
  }
}
