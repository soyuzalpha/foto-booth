/**
 * Fullscreen kiosk (Fase 4, §B47).
 *
 * Browser hanya mengizinkan fullscreen dari gesture pengguna, jadi modul ini
 * **tidak** memaksa apa pun: ia melaporkan status nyata dan menyediakan jalur
 * masuk/keluar yang dipanggil dari klik. Target-nya injectable supaya tes tidak
 * butuh DOM fullscreen asli.
 *
 * Catatan API (jangan diubah tanpa mengukur): `requestFullscreen()` hidup di
 * **Element**, bukan di `Document`. Di Chromium `document.requestFullscreen`
 * bernilai `undefined` — kalau itu yang dipakai, kiosk akan selamanya melaporkan
 * "tidak didukung". Yang ada di `Document` hanya `exitFullscreen`,
 * `fullscreenElement`, dan `fullscreenEnabled`. Karena itu target di bawah ini
 * adalah adapter yang memisahkan keduanya.
 */

export type FullscreenState = "off" | "on" | "unsupported";

export interface FullscreenTarget {
  requestFullscreen?: () => Promise<void>;
  exitFullscreen?: () => Promise<void>;
  fullscreenElement?: Element | null;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export interface FullscreenController {
  state(): FullscreenState;
  enter(): Promise<boolean>;
  exit(): Promise<boolean>;
  toggle(): Promise<boolean>;
  /** Panggil listener tiap perubahan status (termasuk Esc dari pengguna). */
  subscribe(listener: (state: FullscreenState) => void): () => void;
  /** Tanggal dari luar: saat aplikasi menyelesaikan setup/teardown. */
  dispose(): void;
}

/**
 * Adapter DOM asli: minta fullscreen pada elemen (default `<html>`), tetapi
 * pantau/lepas lewat `document`.
 */
export function resolveFullscreenTarget(element?: Element | null): FullscreenTarget | null {
  if (typeof document === "undefined") return null;

  const host = element ?? document.documentElement;
  if (host === null || typeof host.requestFullscreen !== "function") return null;

  return {
    requestFullscreen: () => host.requestFullscreen(),
    exitFullscreen:
      typeof document.exitFullscreen === "function"
        ? () => document.exitFullscreen()
        : undefined,
    get fullscreenElement(): Element | null {
      return document.fullscreenElement;
    },
    addEventListener: (type, listener) => document.addEventListener(type, listener),
    removeEventListener: (type, listener) => document.removeEventListener(type, listener),
  };
}

export function readFullscreenState(target: FullscreenTarget | null): FullscreenState {
  if (target === null) return "unsupported";
  if (typeof target.requestFullscreen !== "function") return "unsupported";
  return target.fullscreenElement == null ? "off" : "on";
}

/**
 * Kendali fullscreen. `enter()` mengembalikan `false` kalau browser menolak
 * (bukan gesture pengguna) — pemanggil boleh menampilkan tombol manual.
 */
export function createFullscreenController(
  target: FullscreenTarget | null = resolveFullscreenTarget(),
): FullscreenController {
  const listeners = new Set<(state: FullscreenState) => void>();
  let last = readFullscreenState(target);

  const notify = (): void => {
    const next = readFullscreenState(target);
    if (next === last) return;
    last = next;
    for (const listener of listeners) listener(next);
  };

  const onChange = (): void => {
    notify();
  };

  /**
   * Tunggu sampai status benar-benar mencapai `want`. `requestFullscreen()`
   * boleh selesai sebelum event `fullscreenchange` sampai, jadi tanpa ini
   * kiosk bisa keliru melaporkan "ditolak" padahal fullscreen berhasil.
   */
  const waitFor = (want: FullscreenState, timeoutMs = 400): Promise<boolean> =>
    new Promise((resolve) => {
      if (readFullscreenState(target) === want) {
        resolve(true);
        return;
      }

      const settle = (): void => {
        if (readFullscreenState(target) === want) {
          done(true);
        }
      };
      const done = (value: boolean): void => {
        globalThis.clearTimeout(timer);
        listeners.delete(settle);
        resolve(value);
      };

      const timer = globalThis.setTimeout(() => done(readFullscreenState(target) === want), timeoutMs);
      listeners.add(settle);
    });

  if (target?.addEventListener) {
    target.addEventListener("fullscreenchange", onChange);
    target.addEventListener("webkitfullscreenchange", onChange);
  }

  return {
    state: () => readFullscreenState(target),

    enter: async () => {
      if (target === null || typeof target.requestFullscreen !== "function") return false;
      if (target.fullscreenElement != null) return true;

      try {
        await target.requestFullscreen();
        notify();
        return await waitFor("on");
      } catch {
        // Autoplay/gesture policy menolak: bukan error fatal.
        return false;
      }
    },

    exit: async () => {
      if (target === null || typeof target.exitFullscreen !== "function") return false;
      if (target.fullscreenElement == null) return true;

      try {
        await target.exitFullscreen();
        notify();
        return await waitFor("off");
      } catch {
        return false;
      }
    },

    toggle: async () =>
      readFullscreenState(target) === "on"
        ? (await exitFullscreenVia(target))
        : (await enterFullscreenVia(target)),

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose: () => {
      listeners.clear();
      if (target?.removeEventListener) {
        target.removeEventListener("fullscreenchange", onChange);
        target.removeEventListener("webkitfullscreenchange", onChange);
      }
    },
  };
}

async function enterFullscreenVia(target: FullscreenTarget | null): Promise<boolean> {
  if (target === null || typeof target.requestFullscreen !== "function") return false;
  try {
    await target.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

async function exitFullscreenVia(target: FullscreenTarget | null): Promise<boolean> {
  if (target === null || typeof target.exitFullscreen !== "function") return false;
  try {
    await target.exitFullscreen();
    return true;
  } catch {
    return false;
  }
}
