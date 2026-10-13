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
import {
  asArchiveRoot,
  browserArchiveDeps,
  chooseArchiveBackend,
  pickArchiveTarget,
  type ArchiveDeps,
  type ArchiveTarget,
} from "../storage/directoryPicker.ts";
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
import { GalleryContext, type ArchiveState, type GalleryContextValue } from "./galleryContext.ts";
import { useGalleries } from "./useGalleries.ts";

export interface GalleryProviderProps {
  children: ReactNode;
  /** Injectable untuk tes. */
  client?: GalleryClient;
  store?: UploadStore;
  archive?: LocalArchive | null;
  /** Injectable untuk tes; default dari global browser. */
  archiveDeps?: ArchiveDeps;
}

export function GalleryProvider({
  children,
  client,
  store,
  archive,
  archiveDeps,
}: GalleryProviderProps): React.JSX.Element {
  const [session, setSession] = useState<OperatorSession | null>(() => loadSession());
  const [active, setActiveState] = useState<ActiveGallery | null>(() => loadActiveGallery());

  // Folder arsip pilihan operator. Disimpan per sesi aplikasi saja: handle
  // File System Access tidak bisa ditaruh di localStorage, dan menyimpannya di
  // IndexedDB berarti menambah satu jalur pemulihan izin yang belum dibutuhkan.
  const [archiveTarget, setArchiveTarget] = useState<ArchiveTarget | null>(null);

  const deps = useMemo<ArchiveDeps>(() => archiveDeps ?? browserArchiveDeps(), [archiveDeps]);
  const archiveAvailable = useMemo(() => chooseArchiveBackend(deps), [deps]);

  const galleries = useGalleries(
    client === undefined ? { token: session?.token ?? null } : { token: session?.token ?? null, client },
  );

  // Store dibangun sekali: tiap `createUploadStore()` membuka koneksi
  // IndexedDB sendiri, dan membangunnya per render bikin koneksinya menumpuk.
  const uploadStore = useMemo(() => store ?? createUploadStore().store, [store]);

  // Arsip mengikuti album aktif — foldernya adalah hash album, sama seperti di
  // ZIP galeri, jadi penamaan berkasnya konsisten di kedua sisi.
  //
  // Kalau operator memilih folder sendiri, akarnya folder itu; kalau tidak,
  // akarnya OPFS. Keduanya lewat `LocalArchive` yang sama sehingga jalur
  // kegagalannya pun sama: gagal simpan → `null`, upload tetap jalan.
  const localArchive = useMemo<LocalArchive | null>(() => {
    if (archive !== undefined) return archive;
    if (active === null) return null;
    if (archiveTarget !== null) return createLocalArchive(active.hash, asArchiveRoot(archiveTarget.handle));
    return createLocalArchive(active.hash);
  }, [active, archive, archiveTarget]);

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

  // Pilih folder arsip. `pickArchiveTarget` tidak pernah melempar dan sudah
  // menjatuhkan diri ke OPFS kalau API-nya tidak ada atau izinnya ditolak —
  // jadi di sini tidak ada penanganan error yang bisa menutupi kegagalan.
  const chooseFolder = useCallback(async (): Promise<ArchiveTarget | null> => {
    const picked = await pickArchiveTarget(deps);
    if (picked !== null) setArchiveTarget(picked);
    return picked;
  }, [deps]);

  const clearFolder = useCallback((): void => {
    setArchiveTarget(null);
  }, []);

  const archiveState = useMemo<ArchiveState>(
    () => ({
      available: archiveAvailable,
      chosen: archiveTarget?.backend ?? null,
      chosenLabel: archiveTarget?.label ?? null,
      chooseFolder,
      clearFolder,
    }),
    [archiveAvailable, archiveTarget, chooseFolder, clearFolder],
  );

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
      archive: archiveState,
      intake,
    }),
    [active, archiveState, clearActive, galleries, intake, queue, session, setActive, signIn, signOut],
  );

  return <GalleryContext.Provider value={value}>{children}</GalleryContext.Provider>;
}
