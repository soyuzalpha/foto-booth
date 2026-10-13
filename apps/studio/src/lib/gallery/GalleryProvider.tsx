/**
 * Pemilik state tingkat aplikasi untuk galeri: sesi operator, galeri aktif,
 * antrian upload, dan arsip lokal.
 *
 * Kenapa satu provider, bukan state di dalam `GalleryPanel`: **tiga tempat
 * berbeda butuh fakta yang sama.**
 *
 *   · panel galeri menampilkan QR dan daftar galeri,
 *   · halaman capture mengirim foto ke galeri aktif,
 *   · antrian upload butuh tujuan + token untuk jalan sendiri.
 *
 * Kalau tiap tempat menyimpan salinannya sendiri, cepat atau lambat berbeda —
 * dan bentuk perbedaannya paling buruk: foto masuk ke galeri yang operator
 * kira sudah diganti.
 *
 * Provider ini **tidak menyentuh jaringan sendiri.** Panggilan API ada di
 * `useGalleries`/`useUploadQueue`; di sini cuma perakitan dan penyimpanan.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";

import {
  clearSession,
  loadSession,
  saveSession,
  type OperatorSession,
} from "../session/operatorSession.ts";
import { createLocalArchive, type LocalArchive } from "../upload/localArchive.ts";
import { intakePhoto, summarizeIntake, type IntakePhoto, type IntakeSummary } from "../upload/photoIntake.ts";
import { createUploadStore, type UploadStore } from "../upload/uploadStore.ts";
import { useUploadQueue } from "../upload/useUploadQueue.ts";
import {
  activeFromSummary,
  clearActiveGallery,
  loadActiveGallery,
  saveActiveGallery,
  type ActiveGallery,
} from "./activeGallery.ts";
import type { GalleryClient, GallerySummary } from "./galleryClient.ts";
import { GalleryContext, type GalleryContextValue } from "./galleryContext.ts";
import { useGalleries } from "./useGalleries.ts";

export interface GalleryProviderProps {
  children: ReactNode;
  /** Injectable untuk tes. */
  client?: GalleryClient;
  store?: UploadStore;
  archive?: LocalArchive | null;
}

export function GalleryProvider({ children, client, store, archive }: GalleryProviderProps): React.JSX.Element {
  const [session, setSession] = useState<OperatorSession | null>(() => loadSession());
  const [active, setActiveState] = useState<ActiveGallery | null>(() => loadActiveGallery());

  const galleries = useGalleries(
    client === undefined ? { token: session?.token ?? null } : { token: session?.token ?? null, client },
  );

  // Store dibangun sekali: tiap `createUploadStore()` membuka koneksi
  // IndexedDB sendiri, dan membangunnya per render bikin koneksinya menumpuk.
  const uploadStore = useMemo(() => store ?? createUploadStore().store, [store]);

  // Arsip mengikuti album aktif — foldernya adalah hash album, sama seperti di
  // ZIP galeri, jadi penamaan berkasnya konsisten di kedua sisi.
  const localArchive = useMemo<LocalArchive | null>(() => {
    if (archive !== undefined) return archive;
    if (active === null) return null;
    return createLocalArchive(active.hash);
  }, [active, archive]);

  const queue = useUploadQueue({
    galleryId: active?.id ?? null,
    token: session?.token ?? null,
    enabled: session !== null && active !== null,
    ...(store === undefined ? {} : { store: uploadStore }),
  });

  const signIn = useCallback((next: OperatorSession): void => {
    saveSession(next);
    setSession(next);
  }, []);

  const signOut = useCallback((): void => {
    clearSession();
    clearActiveGallery();
    setSession(null);
    setActiveState(null);
  }, []);

  const setActive = useCallback((gallery: GallerySummary, label: string): void => {
    const next = activeFromSummary(gallery, label);
    saveActiveGallery(next);
    setActiveState(next);
  }, []);

  const clearActive = useCallback((): void => {
    clearActiveGallery();
    setActiveState(null);
  }, []);

  const intake = useCallback(
    async (photos: IntakePhoto[]): Promise<IntakeSummary> => {
      if (active === null) {
        return {
          queued: 0,
          archived: 0,
          failed: photos.length,
          error: "galeri belum dipilih",
        };
      }

      const deps = { store: uploadStore, archive: localArchive, galleryId: active.id };
      const results = [];
      for (const photo of photos) {
        results.push(await intakePhoto(deps, photo));
      }

      // Antrian baru saja bertambah — kalau tidak disegarkan, daftar di layar
      // tetap kosong sampai timer berikutnya, dan operator mengira gagal.
      await queue.refresh();
      return summarizeIntake(results);
    },
    [active, localArchive, queue, uploadStore],
  );

  const value = useMemo<GalleryContextValue>(
    () => ({
      session,
      signIn,
      signOut,
      galleries,
      active,
      setActive,
      clearActive,
      queue,
      intake,
    }),
    [active, clearActive, galleries, intake, queue, session, setActive, signIn, signOut],
  );

  return <GalleryContext.Provider value={value}>{children}</GalleryContext.Provider>;
}
