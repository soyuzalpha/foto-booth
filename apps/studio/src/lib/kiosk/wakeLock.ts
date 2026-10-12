/**
 * Wake lock kiosk (Fase 4, §A18 / §B50).
 *
 * Layar kiosk tidak boleh tidur di tengah antrean. Wake Lock API bisa ditolak
 * (baterai lemah, tab tidak aktif) dan **otomatis dilepas oleh browser** saat
 * tab disembunyikan — jadi kontraknya:
 *
 *   - `request()` mengembalikan status nyata, tidak pernah melempar;
 *   - sentinel yang dilepas browser memicu `onRelease`, dan pemanggil boleh
 *     meminta ulang saat tab kembali terlihat;
 *   - semua API injectable supaya tes bisa memakai sentinel palsu.
 */

export type WakeLockState = "off" | "on" | "unsupported" | "denied";

export interface WakeLockSentinelLike {
  release?: () => Promise<void>;
  released?: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export interface WakeLockNavigatorLike {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
}

export interface WakeLockController {
  state(): WakeLockState;
  /** Minta layar tetap menyala. Aman dipanggil berulang. */
  request(): Promise<WakeLockState>;
  release(): Promise<void>;
  /** Dipanggil saat sentinel dilepas browser (mis. tab disembunyikan). */
  onRelease(listener: () => void): () => void;
  dispose(): void;
}

export function resolveWakeLockNavigator(): WakeLockNavigatorLike | null {
  if (typeof navigator === "undefined") return null;
  return navigator as unknown as WakeLockNavigatorLike;
}

export function createWakeLock(
  nav: WakeLockNavigatorLike | null = resolveWakeLockNavigator(),
): WakeLockController {
  const listeners = new Set<() => void>();
  let sentinel: WakeLockSentinelLike | null = null;
  let state: WakeLockState = nav?.wakeLock ? "off" : "unsupported";

  const handleRelease = (): void => {
    sentinel = null;
    state = nav?.wakeLock ? "off" : "unsupported";
    for (const listener of listeners) listener();
  };

  const detach = (target: WakeLockSentinelLike): void => {
    target.removeEventListener?.("release", handleRelease);
  };

  return {
    state: () => state,

    request: async () => {
      if (!nav?.wakeLock) {
        state = "unsupported";
        return state;
      }
      if (sentinel !== null && sentinel.released !== true) {
        state = "on";
        return state;
      }

      try {
        const next = await nav.wakeLock.request("screen");
        sentinel = next;
        next.addEventListener?.("release", handleRelease);
        state = "on";
        return state;
      } catch {
        // NotAllowedError / tab tidak aktif → bukan error fatal, layar saja
        // yang boleh tidur.
        sentinel = null;
        state = "denied";
        return state;
      }
    },

    release: async () => {
      const current = sentinel;
      sentinel = null;
      state = nav?.wakeLock ? "off" : "unsupported";
      if (current === null) return;

      detach(current);
      try {
        await current.release?.();
      } catch {
        // Sudah dilepas browser: tidak ada yang perlu dilakukan.
      }
    },

    onRelease: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose: () => {
      listeners.clear();
      if (sentinel !== null) detach(sentinel);
      sentinel = null;
    },
  };
}
