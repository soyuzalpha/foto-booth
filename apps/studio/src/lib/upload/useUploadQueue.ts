/**
 * Auto-sync antrian upload — penghubung antara IndexedDB, jaringan, dan UI.
 *
 * Yang menentukan bentuk hook ini:
 *
 *   · **Jaringan lemah itu normal, bukan pengecualian.** Kiosk di gedung
 *     pernikahan sering kehilangan sinyal. Jadi hook ini tidak menunggu
 *     perintah: begitu ada item siap dan jaringan ada, dia jalan sendiri.
 *   · **Timer hanya hidup kalau memang ada yang ditunggu.** Dua keadaan yang
 *     butuh timer berbeda, dan keduanya gampang salah:
 *       – ada item **siap sekarang** → tick pendek, langsung kerjakan;
 *       – semua item siap **terjadwal di masa depan** (backoff) → timer disetel
 *         tepat ke jadwal terdekat, bukan tick pendek yang berputar-putar.
 *     Timer yang selalu menyala bikin laptop kiosk tidak pernah tidur; timer
 *     yang tidak dipasang saat backoff bikin foto menggantung sampai user
 *     menekan tombol.
 *   · **Satu putaran pada satu waktu.** Dua putaran paralel memproses batch
 *     yang sama dua kali; guard `running` yang mencegahnya.
 *   · **Item `uploading` yang tertinggal diperbaiki saat bangun.** Tab ditutup
 *     di tengah upload itu biasa; tanpa pemulihan, item itu macet selamanya.
 *
 * Semua ketergantungan luar injectable (`store`, `client`, `now`, `setTimer`)
 * supaya bisa diuji tanpa browser dan tanpa jaringan.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isReady, type UploadItem } from "@foto-booth/shared";

import {
  listenForSyncRequests,
  registerUploadSync,
  UPLOAD_SYNC_TAG,
  type SyncCapableRegistration,
  type SyncSupport,
} from "./backgroundSync.ts";
import { runUploadQueue, type RunReport } from "./uploadRunner.ts";
import { createUploadStore, type UploadStore } from "./uploadStore.ts";
import { createHttpUploadClient, type UploadClient } from "./uploadClient.ts";

export interface UploadQueueState {
  items: UploadItem[];
  /** Sedang ada putaran berjalan. */
  running: boolean;
  /** Hasil putaran terakhir; `null` sebelum ada putaran. */
  lastReport: RunReport | null;
  /** Status Background Sync — diagnostik, bukan error. */
  sync: SyncSupport | null;
  /** Pesan kalau penyimpanan IndexedDB tidak bisa dibuka. */
  storageError: string | null;
}

export interface UseUploadQueueOptions {
  /** Galeri tujuan. Tanpa ini antrian tidak dijalankan. */
  galleryId: string | null;
  /** Token sesi operator. */
  token: string | null;
  /** `false` = jangan jalankan (mis. belum login). */
  enabled?: boolean;
  /** Jeda sebelum memeriksa ulang saat ada item siap. */
  tickMs?: number;
  now?: () => Date;
  /** Injectable untuk tes: `window.setTimeout` pada produksi. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  store?: UploadStore;
  client?: UploadClient;
}

/** Jeda default saat ada item siap sekarang. */
const DEFAULT_TICK_MS = 1000;
/** Batas bawah timer backoff: jangan sampai timer 0 ms berputar tanpa jeda. */
const MIN_BACKOFF_MS = 50;

function sortItems(items: UploadItem[]): UploadItem[] {
  // Urut waktu dibuat: daftar yang berubah urutannya tiap refresh bikin
  // operator mengira ada foto yang hilang.
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Berapa lama menunggu sebelum putaran berikutnya, atau `null` kalau tidak ada
 * yang perlu ditunggu. Dipisah dari hook supaya bisa diuji sendiri.
 */
export function nextDelayMs(items: readonly UploadItem[], now: Date, tickMs: number): number | null {
  // Item `uploading` yang tersisa di sini **bukan** yang sedang berjalan:
  // penjadwalan hanya dihitung saat `running` false, dan satu putaran selalu
  // menuntaskan setiap item yang diambilnya. Jadi `uploading` yang masih
  // tersimpan = tab ditutup di tengah upload (orphan). Runner mengembalikannya
  // ke `queued` saat dijalankan — tapi kalau tidak ada yang menjadwalkan
  // putaran, item itu menggantung selamanya sampai operator menekan "Send now".
  // Jadwalkan sekarang juga.
  if (items.some((item) => item.state === "uploading")) return tickMs;

  // Hanya `queued` yang bisa diambil `nextBatch`. `uploaded`/`failed` sudah
  // selesai; `local-only` belum punya byte. Memasukkan state lain ke sini bikin
  // timer menunggu item yang tidak akan pernah jalan — pada `local-only`
  // (nextAttemptAt null) bahkan jadi timer 50 ms yang berputar selamanya.
  const pending = items.filter((item) => item.state === "queued");
  if (pending.length === 0) return null;

  if (pending.some((item) => isReady(item, now))) return tickMs;

  // Semua terjadwal di masa depan: tunggu yang paling dekat.
  const soonest = Math.min(
    ...pending.map((item) => new Date(item.nextAttemptAt ?? 0).getTime() - now.getTime()),
  );
  return Math.max(MIN_BACKOFF_MS, soonest);
}

export function useUploadQueue(options: UseUploadQueueOptions): UploadQueueState & {
  runNow: () => Promise<void>;
  refresh: () => Promise<void>;
} {
  const enabled = options.enabled ?? true;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  // Di-`useMemo` supaya identitasnya stabil antar render. Tanpa ini, ekspresi
  // `??` bikin fungsi baru tiap render, dan setiap `useEffect`/`useCallback`
  // yang memakainya ikut dijalankan ulang tanpa henti.
  const now = useMemo(() => options.now ?? (() => new Date()), [options.now]);
  const setTimer = useMemo(
    () => options.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms)),
    [options.setTimer],
  );
  const clearTimer = useMemo(
    () => options.clearTimer ?? ((id: number) => window.clearTimeout(id)),
    [options.clearTimer],
  );

  const [state, setState] = useState<UploadQueueState>({
    items: [],
    running: false,
    lastReport: null,
    sync: null,
    storageError: null,
  });

  const running = useRef(false);
  const timer = useRef<number | null>(null);

  // Store & client dibangun sekali. `createUploadStore` tidak boleh dibangun
  // ulang tiap render: tiap instance membuka koneksi IndexedDB sendiri.
  const store = useMemo(() => options.store ?? createUploadStore().store, [options.store]);

  const client = useMemo(() => {
    if (options.client !== undefined) return options.client;
    if (options.token === null || options.token === "") return null;
    return createHttpUploadClient({ token: options.token });
  }, [options.client, options.token]);

  const refresh = useCallback(async () => {
    try {
      const items = sortItems(await store.allItems());
      setState((prev) => ({ ...prev, items, storageError: null }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        storageError: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [store]);

  const runOnce = useCallback(async () => {
    if (running.current) return;
    if (client === null) return;

    running.current = true;
    setState((prev) => ({ ...prev, running: true }));

    try {
      const report = await runUploadQueue({ store, client, now });
      const items = sortItems(await store.allItems());
      setState((prev) => ({ ...prev, items, lastReport: report, storageError: null }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        storageError: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      running.current = false;
      setState((prev) => ({ ...prev, running: false }));
    }
  }, [client, now, store]);

  // Muat isi antrian saat mount / saat ganti galeri.
  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh, options.galleryId]);

  // Jadwalkan putaran berikutnya sesuai `nextDelayMs`.
  useEffect(() => {
    if (timer.current !== null) {
      clearTimer(timer.current);
      timer.current = null;
    }
    if (!enabled || client === null || state.running) return;

    const delay = nextDelayMs(state.items, now(), tickMs);
    if (delay === null) return;

    const id = setTimer(() => {
      timer.current = null;
      void runOnce();
    }, delay);
    timer.current = id;

    return () => {
      clearTimer(id);
      if (timer.current === id) timer.current = null;
    };
  }, [client, clearTimer, enabled, now, runOnce, setTimer, state.items, state.running, tickMs]);

  // Jaringan kembali → jalankan segera, tanpa menunggu tick.
  useEffect(() => {
    if (!enabled) return;

    const onOnline = () => void runOnce();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [enabled, runOnce]);

  // Background Sync: daftarkan tag, dan jalankan putaran kalau service worker
  // membangunkan halaman.
  useEffect(() => {
    if (!enabled || client === null) return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let cancelled = false;

    void navigator.serviceWorker.ready
      .then((registration) => registerUploadSync(registration as SyncCapableRegistration))
      .then((support) => {
        if (!cancelled) setState((prev) => ({ ...prev, sync: support }));
      })
      .catch(() => {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            sync: { supported: false, registered: false, reason: "service worker gagal siap" },
          }));
        }
      });

    const stop = listenForSyncRequests(() => void runOnce());

    return () => {
      cancelled = true;
      stop();
    };
  }, [client, enabled, runOnce]);

  return { ...state, runNow: runOnce, refresh };
}

export { UPLOAD_SYNC_TAG };
