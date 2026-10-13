/**
 * Jembatan React ↔ `CaptureSession`.
 *
 * Semua logika sesi hidup di `CaptureSession` (yang tidak tahu apa-apa soal
 * React). Hook ini hanya:
 *   1. membuat sesi sekali, lalu membuangnya saat unmount,
 *   2. menerjemahkan store-nya jadi state React lewat `useSyncExternalStore`,
 *   3. mengubah `Blob` frame jadi object URL supaya bisa ditampilkan.
 *
 * Tidak ada state sesi yang disalin ke sini. Kalau hook ini ikut menyimpan
 * "sedang countdown" atau "sedang gagal", itu cuma menambah sumber kebenaran
 * kedua yang cepat atau lambat berbeda dengan state machine.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { AspectRatioId } from "./capture/aspectRatio.ts";
import { CaptureSession } from "./capture/captureSession.ts";
import { createFrameStore } from "./capture/frameStore.ts";
import type { SessionConfig } from "./capture/stateMachine.ts";
import { DEFAULT_SESSION_CONFIG, normalizeConfig } from "./capture/stateMachine.ts";
import type { CaptureError } from "./transports/errors.ts";
import { demoSpecs } from "./transports/demoMode.ts";
import { FAKE_DEVICES, FakeTransport } from "./transports/fakeTransport.ts";
import type { CameraDevice, CameraTransport } from "./transports/types.ts";
import { UvcTransport } from "./transports/uvcTransport.ts";

/** Frame siap-tampil: `Blob` sudah jadi object URL. */
export interface DisplayFrame {
  id: string;
  shotIndex: number;
  width: number;
  height: number;
  url: string;
}

export interface CaptureSnapshot {
  /** `false` selama sesi belum dibuat (render pertama, termasuk double-mount StrictMode). */
  ready: boolean;
  session: CaptureSession | null;
  /** Mode demo: browser tidak punya kamera, `FakeTransport` yang dipakai. */
  demo: boolean;
  /** `memory` = frame tidak tahan refresh. */
  storageKind: "indexeddb" | "memory";
  state: ReturnType<CaptureSession["getSnapshot"]> | null;
  devices: CameraDevice[];
  frames: DisplayFrame[];
  aspect: AspectRatioId;
  mirror: boolean;
  /** Pengaturan sesi yang akan dipakai saat `arm` berikutnya. */
  config: SessionConfig;
  /** Kesalahan terakhir yang dilaporkan mesin capture — belum tentu mematikan. */
  error: CaptureError | null;
}

export interface CaptureActions {
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  arm(): void;
  begin(): void;
  retake(index: number): void;
  retry(): void;
  accept(): void;
  reset(): void;
  newSession(): void;
  setAspect(id: AspectRatioId): void;
  setMirrorOverride(value: boolean | null): void;
  setConfig(patch: Partial<SessionConfig>): void;
  setResolution(width: number, height: number): Promise<void>;
  refreshDevices(): Promise<void>;
  clearError(): void;
}

const EMPTY_SLOTS: readonly (string | null)[] = [];

const noopSubscribe = (): (() => void) => () => undefined;
const nullSnapshot = (): null => null;

/**
 * Pengaturan operator disimpan di localStorage supaya tidak perlu diisi ulang
 * tiap buka aplikasi — kiosk biasanya dijalankan orang yang sama terus.
 */
const CONFIG_KEY = "foto-booth:config";

function loadConfig(): SessionConfig {
  if (typeof localStorage === "undefined") return DEFAULT_SESSION_CONFIG;

  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw === null) return DEFAULT_SESSION_CONFIG;
    return normalizeConfig({ ...DEFAULT_SESSION_CONFIG, ...(JSON.parse(raw) as object) });
  } catch {
    return DEFAULT_SESSION_CONFIG;
  }
}

/**
 * Pilih transport sesuai kemampuan browser.
 *
 * Urutannya menentukan:
 *
 *   1. `?fake=...` menang lebih dulu — mode demo harus bisa dipaksa walau
 *      browser punya `getUserMedia` (mesin pengembang, CI, harness e2e);
 *   2. `getUserMedia` butuh secure context (HTTPS atau localhost). Kalau tidak
 *      ada, aplikasi jangan mati: `FakeTransport` dipakai supaya operator masih
 *      bisa mencoba alur sesi dan menilai tata letaknya.
 */
function pickTransport(): { transport: CameraTransport; demo: boolean } {
  const search = typeof location === "undefined" ? "" : location.search;
  const demo = demoSpecs(search);

  if (demo !== null) return { transport: new FakeTransport({ specs: demo }), demo: true };

  const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;

  if (mediaDevices !== undefined && typeof mediaDevices.getUserMedia === "function") {
    return { transport: new UvcTransport({ mediaDevices }), demo: false };
  }

  return { transport: new FakeTransport({ specs: FAKE_DEVICES }), demo: true };
}

export function useCaptureSession(): CaptureSnapshot & CaptureActions {
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [demo, setDemo] = useState(false);
  const [storageKind, setStorageKind] = useState<"indexeddb" | "memory">("memory");
  const [error, setError] = useState<CaptureError | null>(null);

  // Daftar device, cermin, dan rasio **bukan** state alur sesi — state machine
  // tidak mengurusnya. Tapi nilainya tetap harus sampai ke UI, dan satu-satunya
  // jalur yang benar adalah bus-nya, bukan membaca getter saat render: getter
  // tidak memicu render, jadi daftar kamera akan tetap kosong di layar.
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [mirror, setMirror] = useState(false);
  const [aspect, setAspectState] = useState<AspectRatioId>("original");
  const [config, setConfigState] = useState<SessionConfig>(loadConfig);

  // Object URL harus dibuang manual; kalau tidak, tiap jepretan meninggalkan
  // blob hidup sampai tab ditutup.
  const urls = useRef(new Map<string, string>());

  useEffect(() => {
    const { store, kind } = createFrameStore();
    const picked = pickTransport();

    const created = new CaptureSession({
      transport: picked.transport,
      store,
      mediaDevices: typeof navigator === "undefined" ? null : navigator.mediaDevices,
    });

    const unsubscribeError = created.on("error", (reported) => setError(reported));
    const unsubscribeDevices = created.on("devices:changed", (list) => setDevices(list));
    const unsubscribeMirror = created.on("mirror:changed", (value) => setMirror(value));
    const unsubscribeAspect = created.on("aspect:changed", (id) => setAspectState(id));

    setDemo(picked.demo);
    setStorageKind(kind);
    setSession(created);

    void created.init();

    return () => {
      unsubscribeError();
      unsubscribeDevices();
      unsubscribeMirror();
      unsubscribeAspect();
      void created.destroy();
      setSession((current) => (current === created ? null : current));
    };
  }, []);

  // ── store → React ─────────────────────────────────────────────────────
  //
  // `subscribe` dan `getSnapshot` diikat di konstruktor `CaptureSession`, jadi
  // identitasnya stabil dan aman dipakai `useSyncExternalStore`.
  const state = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getSnapshot ?? nullSnapshot,
  );

  const slots = state?.frames ?? EMPTY_SLOTS;

  // Kunci berdasarkan isi slot, bukan identitas array: state machine membuat
  // array baru setiap dispatch, jadi identitas akan memicu render terus-menerus.
  const slotKey = slots.join("|");

  const frames = useMemo(() => {
    if (session === null) return [];

    const cache = urls.current;
    const next: DisplayFrame[] = [];

    slots.forEach((id, index) => {
      if (id === null) return;

      const frame = session.frameAt(index);
      if (frame === null || frame.id !== id) return;

      let url = cache.get(frame.id);
      if (url === undefined) {
        url = URL.createObjectURL(frame.blob);
        cache.set(frame.id, url);
      }

      next.push({
        id: frame.id,
        shotIndex: frame.shotIndex,
        width: frame.width,
        height: frame.height,
        url,
      });
    });

    return next;
    // `slotKey` berdiri untuk `slots`: isinya berubah setiap ada frame baru.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey, session]);

  // Buang object URL milik frame yang sudah tidak ada (retake / reset).
  useEffect(() => {
    const alive = new Set(slots.filter((id): id is string => id !== null));
    const cache = urls.current;

    for (const [id, url] of cache) {
      if (alive.has(id)) continue;
      URL.revokeObjectURL(url);
      cache.delete(id);
    }
  }, [slotKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Buang sisanya saat unmount.
  useEffect(() => {
    const cache = urls.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  // Pengaturan operator ikut tersimpan — kalau tidak, tiap buka aplikasi
  // shot count kembali ke 4 dan operator harus menyetel ulang.
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch {
      // localStorage penuh / diblokir: pengaturan tetap jalan di sesi ini.
    }
  }, [config]);

  const setConfig = useCallback((patch: Partial<SessionConfig>): void => {
    setConfigState((current) => normalizeConfig({ ...current, ...patch }));
  }, []);

  // ── aksi ──────────────────────────────────────────────────────────────

  const connect = useCallback(
    async (deviceId: string): Promise<void> => {
      if (session === null) return;
      setError(null);
      await session.connect(deviceId);
    },
    [session],
  );

  const disconnect = useCallback(async (): Promise<void> => {
    await session?.disconnect();
  }, [session]);

  const setResolution = useCallback(
    async (width: number, height: number): Promise<void> => {
      await session?.setResolution(width, height);
    },
    [session],
  );

  const refreshDevices = useCallback(async (): Promise<void> => {
    await session?.refreshDevices();
  }, [session]);

  return {
    ready: session !== null,
    session,
    demo,
    storageKind,
    state,
    devices,
    frames,
    aspect,
    mirror,
    config,
    error,
    connect,
    disconnect,
    arm: () => session?.arm(config),
    begin: () => session?.begin(),
    retake: (index: number) => session?.retake(index),
    retry: () => session?.retry(),
    accept: () => session?.accept(),
    reset: () => session?.reset(),
    newSession: () => session?.newSession(),
    setAspect: (id: AspectRatioId) => session?.setAspect(id),
    setMirrorOverride: (value: boolean | null) => session?.setMirrorOverride(value),
    setConfig,
    setResolution,
    refreshDevices,
    clearError: () => setError(null),
  };
}
