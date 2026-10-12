/**
 * Sinkronisasi konten saat app dibuka.
 *
 * Aturan pentingnya:
 *
 *   - **Sekali per pembukaan app**, bukan tiap render. Sync konten itu I/O
 *     jaringan; kalau dipasang di render, satu perubahan state bikin puluhan
 *     request.
 *   - **Gagal itu wajar.** Kalau jaringan mati, sync dilewati tanpa error ke
 *     UI — yang penting cache lama tetap dipakai. Karena itu hasilnya
 *     dilaporkan sebagai status (`"ok" | "offline" | "error"`), bukan throw.
 *   - **Tidak pernah menghapus cache lama.** Sync yang gagal tidak boleh
 *     mengosongkan katalog yang sudah ada, kalau tidak offline justru
 *     menghapus konten yang sebelumnya tersedia.
 */

import { useEffect, useRef, useState } from "react";

import type { ContentKind } from "@foto-booth/shared";

import { browserContentFetchers } from "../api.ts";
import { createContentCache, syncContent, type SyncResult } from "./contentCache.ts";

export type SyncStatus = "idle" | "syncing" | "ok" | "offline" | "error";

export interface ContentSyncState {
  status: SyncStatus;
  /** Hasil per kategori; kosong sampai sync pertama selesai. */
  results: SyncResult[];
  /** Kategori yang benar-benar tersimpan (aset atau katalog). */
  syncedKinds: ContentKind[];
  /** Total aset tersimpan di cache setelah sync. */
  cachedAssets: number;
  /** Error terakhir (kalau ada) — untuk diagnostik, bukan untuk user. */
  lastError: string | null;
}

const INITIAL: ContentSyncState = {
  status: "idle",
  results: [],
  syncedKinds: [],
  cachedAssets: 0,
  lastError: null,
};

/**
 * Jalankan sync konten sekali saat mount.
 *
 * `kinds` sengaja bisa dikosongkan (array kosong = tidak ada yang disinkronkan)
 * supaya tes bisa menguji jalur "tidak ada kerjaan" tanpa jaringan.
 */
export function useContentSync(
  kinds: readonly ContentKind[],
  options: { enabled?: boolean } = {},
): ContentSyncState {
  const [state, setState] = useState<ContentSyncState>(INITIAL);
  const started = useRef(false);
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    // Guard: React 18 StrictMode menjalankan effect dua kali di dev.
    if (started.current) return;
    started.current = true;

    if (kinds.length === 0) {
      setState({ ...INITIAL, status: "ok" });
      return;
    }

    let cancelled = false;
    setState({ ...INITIAL, status: "syncing" });

    const { cache } = createContentCache();
    const fetchers = browserContentFetchers();

    void (async () => {
      const results: SyncResult[] = [];
      let lastError: string | null = null;

      for (const kind of kinds) {
        try {
          results.push(await syncContent(cache, kind, fetchers));
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }

      if (cancelled) return;

      // Berapa aset yang benar-benar ada di cache sekarang — bukan berapa yang
      // berhasil di putaran ini, karena putaran sebelumnya mungkin sudah
      // menyimpan lebih banyak.
      let cachedAssets = 0;
      try {
        cachedAssets = (await cache.assetUrls()).length;
      } catch {
        cachedAssets = results.reduce((sum, r) => sum + r.assets, 0);
      }

      const syncedKinds = results.filter((r) => r.items > 0).map((r) => r.kind);

      setState({
        status: lastError !== null && results.length === 0 ? "offline" : "ok",
        results,
        syncedKinds,
        cachedAssets,
        lastError,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, kinds]);

  return state;
}
