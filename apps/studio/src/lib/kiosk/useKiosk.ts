/**
 * Hook kiosk (Fase 4) — satu tempat yang menyatukan config, fullscreen, wake
 * lock, guard gesture, dan idle reset.
 *
 * Kenapa satu hook: status kiosk itu satu kesatuan. Kalau config, fullscreen,
 * dan idle punya hook masing-masing, ketiganya bisa tidak sinkron (mis. kiosk
 * dimatikan tapi timer idle masih jalan dan me-reset layar di tengah sesi).
 * Di sini semua transisi lewat satu reducer.
 *
 * Siklus hidup layar:
 *
 *   attract (sentuh untuk mulai) ──tap──▶ armed ──sesi selesai──▶ attract
 *        ▲                                                            │
 *        └──────────────── idle timeout ───────────────────────────────┘
 *
 * Semua sumber non-deterministik injectable (`now`, `setTimer`, storage,
 * fullscreen, wake lock) supaya tes memeriksa angka, bukan menunggu detik nyata.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { createFullscreenController, type FullscreenState } from "./fullscreen.ts";
import { createGestureGuard } from "./gestureGuard.ts";
import {
  IDLE_DEFAULT_CONFIG,
  idleStatus,
  initialIdleState,
  noteActivity,
  resumeIdle,
  suspendIdle,
  type IdleConfig,
  type IdleState,
  type IdleStatus,
} from "./idle.ts";
import {
  loadKioskConfig,
  saveKioskConfig,
  type KioskButtons,
  type KioskConfig,
} from "./kioskConfig.ts";
import { createPinRecord, verifyPin, type PinCrypto, type PinRecord } from "./pin.ts";
import { clearPinRecord, hasPin, loadPinRecord, savePinRecord } from "./pinStore.ts";
import { createWakeLock, type WakeLockController, type WakeLockState } from "./wakeLock.ts";

export interface KioskDeps {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
  /** Sumber PIN record; dipakai tes untuk menyuntik storage palsu. */
  readPin?: () => PinRecord | null;
  writePin?: (record: PinRecord) => void;
  removePin?: () => void;
  crypto?: PinCrypto;
  /** Controller wake lock; dipakai tes untuk memeriksa permintaan layar. */
  wakeLock?: WakeLockController;
}

interface KioskState {
  config: KioskConfig;
  idle: IdleState;
  fullscreen: FullscreenState;
  /** Permintaan fullscreen ditolak browser → sediakan tombol manual. */
  fullscreenBlocked: boolean;
  /** Layar sudah disentuh tamu (keluar dari layar tarik). */
  armed: boolean;
}

type KioskAction =
  | { type: "config"; config: KioskConfig }
  | { type: "activity"; now: number }
  | { type: "suspend"; now: number }
  | { type: "resume"; now: number }
  | { type: "fullscreen"; state: FullscreenState }
  | { type: "fullscreen-blocked"; blocked: boolean }
  | { type: "arm"; now: number }
  | { type: "reset-idle"; now: number };

function reducer(state: KioskState, action: KioskAction): KioskState {
  switch (action.type) {
    case "config":
      return { ...state, config: action.config };
    case "activity":
      return { ...state, idle: noteActivity(state.idle, action.now) };
    case "suspend":
      return { ...state, idle: suspendIdle(state.idle, action.now) };
    case "resume":
      return { ...state, idle: resumeIdle(state.idle, action.now) };
    case "fullscreen":
      return { ...state, fullscreen: action.state, fullscreenBlocked: false };
    case "fullscreen-blocked":
      return { ...state, fullscreenBlocked: action.blocked };
    case "arm":
      return { ...state, armed: true, idle: initialIdleState(action.now) };
    case "reset-idle":
      // Tanpa layar tarik, reset idle cuma menyetel ulang hitungan.
      return {
        ...state,
        armed: !state.config.tapToStart,
        idle: initialIdleState(action.now),
      };
    default:
      return state;
  }
}

function initialState(config: KioskConfig, fullscreen: FullscreenState, now: number): KioskState {
  return {
    config,
    idle: initialIdleState(now),
    fullscreen,
    fullscreenBlocked: false,
    // Tanpa layar tarik, kiosk langsung siap dipakai.
    armed: !config.tapToStart,
  };
}

/** Berapa sering timer idle berdetak. 250 ms cukup halus untuk hitung mundur detik. */
const IDLE_TICK_MS = 250;

export interface UseKioskResult {
  /** Kiosk aktif (penuh-layar + reset idle). */
  enabled: boolean;
  /** Layar tarik sedang tampil (menunggu tamu menyentuh). */
  showAttract: boolean;
  /** Prompt PIN sedang tampil dan menahan keluar. */
  locked: boolean;
  /** Sisa waktu sampai reset, dalam detik (0 kalau sudah lewat). */
  secondsToReset: number;
  /** true saat fase peringatan: tampilkan hitung mundur + tombol lanjut. */
  warning: boolean;
  fullscreen: FullscreenState;
  /** true kalau browser menolak masuk fullscreen otomatis. */
  fullscreenBlocked: boolean;
  wakeLock: WakeLockState;
  /** PIN sudah diatur atau belum. */
  pinConfigured: boolean;
  idleConfig: IdleConfig;
  requirePinOnExit: boolean;
  blockGestures: boolean;
  tapToStart: boolean;
  buttons: KioskButtons;
  /** Kiosk berjalan di lingkungan aman (HTTPS/localhost) — syarat kamera. */
  secureContext: boolean;
  /** true kalau PIN diminta tapi belum ada — kiosk tidak bisa ditinggal aman. */
  pinMissingWarning: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  /** Coba keluar: minta PIN kalau diwajibkan, kalau tidak langsung matikan. */
  requestExit: () => void;
  /** Batal dari prompt PIN. */
  cancelExit: () => void;
  setPin: (pin: string) => Promise<void>;
  clearPin: () => void;
  /** Verifikasi PIN lalu buka kunci. Mengembalikan `true` kalau cocok. */
  unlock: (pin: string) => Promise<boolean>;
  /** Tamu menyentuh layar tarik. */
  start: () => void;
  /** Setel ulang hitungan idle (dipakai tombol "masih di sini"). */
  keepAlive: () => void;
  setIdleConfig: (config: IdleConfig) => void;
  setRequirePinOnExit: (value: boolean) => void;
  setBlockGestures: (value: boolean) => void;
  setTapToStart: (value: boolean) => void;
  setButton: (key: keyof KioskButtons, value: boolean) => void;
  /** Tahan reset idle selama sesi foto. */
  hold: () => void;
  release: () => void;
}

export function useKiosk(deps: KioskDeps = {}): UseKioskResult {
  // Semua dependensi di-resolve di dalam satu useMemo supaya identitasnya stabil
  // antar-render; kalau tidak, efek dan callback di bawah ikut berubah tiap render.
  const {
    now,
    setTimer,
    clearTimer,
    readPin,
    writePin,
    removePin,
  } = useMemo(
    () => ({
      now: deps.now ?? (() => Date.now()),
      setTimer:
        deps.setTimer ??
        ((callback: () => void, ms: number) =>
          globalThis.setInterval(callback, ms) as unknown as number),
      clearTimer: deps.clearTimer ?? ((handle: number) => globalThis.clearInterval(handle)),
      readPin: deps.readPin ?? (() => loadPinRecord()),
      writePin: deps.writePin ?? ((record: PinRecord) => void savePinRecord(record)),
      removePin: deps.removePin ?? (() => clearPinRecord()),
    }),
    [deps.now, deps.setTimer, deps.clearTimer, deps.readPin, deps.writePin, deps.removePin],
  );

  const fullscreenController = useMemo(() => createFullscreenController(), []);
  const wakeLock = useMemo(() => deps.wakeLock ?? createWakeLock(), [deps.wakeLock]);

  const [state, dispatch] = useReducer(reducer, undefined, () =>
    initialState(loadKioskConfig(), fullscreenController.state(), now()),
  );
  const [locked, setLocked] = useState(false);
  const [pinConfigured, setPinConfigured] = useState(() => hasPin());
  const [wakeState, setWakeState] = useState<WakeLockState>(() => wakeLock.state());
  const [status, setStatus] = useState<IdleStatus>(() =>
    idleStatus(state.config.idle, initialIdleState(now()), now()),
  );

  const previousStatus = useRef<IdleStatus | null>(null);
  const configRef = useRef(state.config);
  configRef.current = state.config;

  // Langganan perubahan fullscreen dari browser (mis. pengguna menekan Esc).
  useEffect(() => {
    const unsubscribe = fullscreenController.subscribe((next) =>
      dispatch({ type: "fullscreen", state: next }),
    );
    return () => {
      unsubscribe();
      fullscreenController.dispose();
    };
  }, [fullscreenController]);

  // Browser melepas wake lock saat tab disembunyikan; laporkan ke UI.
  useEffect(() => {
    const unsubscribe = wakeLock.onRelease(() => setWakeState(wakeLock.state()));
    return () => {
      unsubscribe();
      wakeLock.dispose();
    };
  }, [wakeLock]);

  // Guard gesture: hanya saat kiosk aktif dan opsi menyala.
  useEffect(() => {
    if (!state.config.enabled || !state.config.blockGestures) return;

    const guard = createGestureGuard();
    return () => guard.dispose();
  }, [state.config.enabled, state.config.blockGestures]);

  // Layar tidak boleh tidur selama kiosk jalan.
  useEffect(() => {
    if (!state.config.enabled) return;

    void wakeLock.request().then(setWakeState);
  }, [state.config.enabled, wakeLock]);

  // Detak idle. Hanya jalan saat kiosk aktif.
  useEffect(() => {
    if (!state.config.enabled) {
      setStatus(idleStatus(state.config.idle, state.idle, now()));
      return;
    }

    const tick = (): void => {
      const current = now();
      const next = idleStatus(state.config.idle, state.idle, current, previousStatus.current);
      previousStatus.current = next;
      setStatus(next);

      if (next.expired) {
        // Kembali ke layar awal; kalau PIN diwajibkan, minta dulu.
        dispatch({ type: "reset-idle", now: current });
        previousStatus.current = null;
      }
    };

    tick();
    const handle = setTimer(tick, IDLE_TICK_MS);
    return () => clearTimer(handle);
  }, [state.config.enabled, state.config.idle, state.idle, now, setTimer, clearTimer]);

  // Aktivitas operator memulai ulang hitungan.
  useEffect(() => {
    if (!state.config.enabled) return;
    if (typeof window === "undefined") return;

    const onActivity = (): void => dispatch({ type: "activity", now: now() });
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

    for (const event of events) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    return () => {
      for (const event of events) window.removeEventListener(event, onActivity);
    };
  }, [state.config.enabled, now]);

  // Saat kiosk diaktifkan, langsung minta fullscreen.
  useEffect(() => {
    if (!state.config.enabled) return;
    if (fullscreenController.state() === "on") return;

    void (async () => {
      const ok = await fullscreenController.enter();
      if (!ok) dispatch({ type: "fullscreen-blocked", blocked: true });
    })();
  }, [state.config.enabled, fullscreenController]);

  const persist = useCallback((config: KioskConfig) => {
    dispatch({ type: "config", config });
    saveKioskConfig(config);
  }, []);

  const enable = useCallback(async () => {
    persist({ ...configRef.current, enabled: true });
    const ok = await fullscreenController.enter();
    if (!ok) dispatch({ type: "fullscreen-blocked", blocked: true });
  }, [persist, fullscreenController]);

  const disable = useCallback(async () => {
    persist({ ...configRef.current, enabled: false });
    await fullscreenController.exit();
    await wakeLock.release();
    setLocked(false);
  }, [persist, fullscreenController, wakeLock]);

  const requestExit = useCallback(() => {
    const config = configRef.current;
    if (config.requirePinOnExit && pinConfigured) {
      setLocked(true);
      return;
    }
    void disable();
  }, [pinConfigured, disable]);

  const cancelExit = useCallback(() => setLocked(false), []);

  const setPin = useCallback(
    async (pin: string) => {
      const record = await createPinRecord(pin, deps.crypto);
      writePin(record);
      setPinConfigured(true);
    },
    [deps.crypto, writePin],
  );

  const clearPin = useCallback(() => {
    removePin();
    setPinConfigured(false);
    setLocked(false);
  }, [removePin]);

  const unlock = useCallback(
    async (pin: string) => {
      const record = readPin();
      if (record === null) {
        setLocked(false);
        await disable();
        return true;
      }

      const ok = await verifyPin(pin, record, deps.crypto);
      if (ok) {
        setLocked(false);
        await disable();
      }
      return ok;
    },
    [readPin, deps.crypto, disable],
  );

  const start = useCallback(() => {
    dispatch({ type: "arm", now: now() });
    previousStatus.current = null;
    void wakeLock.request().then(setWakeState);
  }, [now, wakeLock]);

  const keepAlive = useCallback(() => {
    dispatch({ type: "activity", now: now() });
    previousStatus.current = null;
  }, [now]);

  const setIdleConfig = useCallback(
    (idle: IdleConfig) => persist({ ...configRef.current, idle }),
    [persist],
  );

  const setRequirePinOnExit = useCallback(
    (value: boolean) => persist({ ...configRef.current, requirePinOnExit: value }),
    [persist],
  );

  const setBlockGestures = useCallback(
    (value: boolean) => persist({ ...configRef.current, blockGestures: value }),
    [persist],
  );

  const setTapToStart = useCallback(
    (value: boolean) => persist({ ...configRef.current, tapToStart: value }),
    [persist],
  );

  const setButton = useCallback(
    (key: keyof KioskButtons, value: boolean) =>
      persist({ ...configRef.current, buttons: { ...configRef.current.buttons, [key]: value } }),
    [persist],
  );

  const hold = useCallback(() => dispatch({ type: "suspend", now: now() }), [now]);
  const release = useCallback(() => dispatch({ type: "resume", now: now() }), [now]);

  const secureContext = useMemo(() => typeof window !== "undefined" && window.isSecureContext, []);

  return {
    enabled: state.config.enabled,
    showAttract: state.config.enabled && state.config.tapToStart && !state.armed,
    locked,
    secondsToReset: Math.ceil(status.remainingMs / 1000),
    warning: status.phase === "warning",
    fullscreen: state.fullscreen,
    fullscreenBlocked: state.fullscreenBlocked,
    wakeLock: wakeState,
    pinConfigured,
    idleConfig: state.config.idle,
    requirePinOnExit: state.config.requirePinOnExit,
    blockGestures: state.config.blockGestures,
    tapToStart: state.config.tapToStart,
    buttons: state.config.buttons,
    secureContext,
    pinMissingWarning: state.config.requirePinOnExit && !pinConfigured,
    enable,
    disable,
    requestExit,
    cancelExit,
    setPin,
    clearPin,
    unlock,
    start,
    keepAlive,
    setIdleConfig,
    setRequirePinOnExit,
    setBlockGestures,
    setTapToStart,
    setButton,
    hold,
    release,
  };
}

export { IDLE_DEFAULT_CONFIG };
