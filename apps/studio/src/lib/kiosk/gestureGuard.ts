/**
 * Guard gesture kiosk (Fase 4, task "preventDefault gesture yang tidak diinginkan").
 *
 * Di kiosk, tamu sering tanpa sengaja: mencubit untuk zoom, menekan lama lalu
 * "buka gambar di tab baru", atau menyapu dari tepi dan keluar dari halaman.
 * Modul ini memasang listener yang menolak gesture itu, dan **hanya** itu —
 * scroll dan klik normal tetap jalan supaya layar tidak terasa rusak.
 *
 * Target-nya injectable supaya tes bisa memeriksa `preventDefault` yang
 * dipanggil, bukan bergantung pada browser.
 */

export interface GuardEvent {
  type: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  scale?: number;
  cancelable?: boolean;
  preventDefault?: () => void;
}

export interface GuardTarget {
  addEventListener: (type: string, listener: (event: GuardEvent) => void, options?: unknown) => void;
  removeEventListener: (type: string, listener: (event: GuardEvent) => void) => void;
}

export interface GestureGuardOptions {
  /** Blokir menu konteks (tekan lama). Default true. */
  blockContextMenu?: boolean;
  /** Blokir zoom (ctrl/⌘ + scroll, pinch, gesturestart). Default true. */
  blockZoom?: boolean;
  /** Blokir tarik-dari-tepi untuk kembali. Default true. */
  blockSwipeBack?: boolean;
  /** Dipanggil saat guard mencegah sesuatu — berguna untuk diagnostik/QA. */
  onBlocked?: (type: string) => void;
}

export interface GestureGuard {
  /** Jenis event yang dipasang. */
  readonly types: readonly string[];
  dispose(): void;
}

/** Event yang selalu ditolak apa pun opsinya. */
const BASE_EVENTS = ["contextmenu", "gesturestart", "gesturechange", "gestureend"] as const;

export function createGestureGuard(
  target: GuardTarget | null = resolveGestureTarget(),
  options: GestureGuardOptions = {},
): GestureGuard {
  const blockContextMenu = options.blockContextMenu ?? true;
  const blockZoom = options.blockZoom ?? true;
  const blockSwipeBack = options.blockSwipeBack ?? true;

  const handlers = new Map<string, (event: GuardEvent) => void>();

  const block = (type: string) => (event: GuardEvent): void => {
    if (event.cancelable === false) return;
    event.preventDefault?.();
    options.onBlocked?.(type);
  };

  if (target !== null) {
    if (blockContextMenu) {
      handlers.set("contextmenu", block("contextmenu"));
    }

    if (blockZoom) {
      for (const type of BASE_EVENTS) {
        if (type === "contextmenu" && blockContextMenu) continue;
        if (type === "contextmenu") continue;
        handlers.set(type, block(type));
      }

      // Ctrl/⌘ + scroll = zoom di desktop.
      handlers.set("wheel", (event) => {
        if (event.ctrlKey === true || event.metaKey === true) block("wheel")(event);
      });

      // Pinch di trackpad Chrome mengirim wheel dengan ctrlKey, tapi sebagian
      // perangkat mengirim touchmove dengan lebih dari satu jari.
      handlers.set("touchmove", (event) => {
        const touches = (event as GuardEvent & { touches?: unknown[] }).touches;
        if (Array.isArray(touches) && touches.length > 1) block("touchmove")(event);
      });

      // Ctrl/⌘ +/- dan Ctrl/⌘ 0 = zoom lewat keyboard.
      handlers.set("keydown", (event) => {
        const keyboard = event as GuardEvent & { key?: string };
        const modifier = event.ctrlKey === true || event.metaKey === true;
        if (!modifier) return;
        if (keyboard.key === "+" || keyboard.key === "-" || keyboard.key === "=" || keyboard.key === "0") {
          block("keydown")(event);
        }
      });
    }

    if (blockSwipeBack) {
      // Gesture back di iOS Safari / Chrome Android.
      handlers.set("touchstart", (event) => {
        const touch = (event as GuardEvent & { touches?: { clientX?: number }[] }).touches?.[0];
        const x = touch?.clientX ?? 999;
        // Mulai dari 24 px tepi kiri/kanan → kemungkinan besar swipe-back.
        const width = (event as GuardEvent & { view?: { innerWidth?: number } }).view?.innerWidth ?? 0;
        if (x <= 24 || (width > 0 && x >= width - 24)) block("touchstart")(event);
      });
    }

    for (const [type, listener] of handlers) {
      target.addEventListener(type, listener, { passive: false, capture: true });
    }
  }

  return {
    types: [...handlers.keys()],
    dispose: () => {
      if (target === null) return;
      for (const [type, listener] of handlers) target.removeEventListener(type, listener);
      handlers.clear();
    },
  };
}

export function resolveGestureTarget(): GuardTarget | null {
  if (typeof document === "undefined") return null;
  return document as unknown as GuardTarget;
}
