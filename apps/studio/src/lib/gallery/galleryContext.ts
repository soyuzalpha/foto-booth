/**
 * Kontrak + hook untuk state galeri tingkat aplikasi.
 *
 * Dipisah dari `GalleryProvider.tsx` supaya berkas komponen hanya mengekspor
 * komponen: fast refresh React butuh itu, dan aturan lint `react-refresh`
 * memang menandai berkas yang mencampur keduanya.
 */

import { createContext, useContext } from "react";

import type { OperatorSession } from "../session/operatorSession.ts";
import type { ArchiveBackend, ArchiveTarget } from "../storage/directoryPicker.ts";
import type { IntakePhoto, IntakeSummary } from "../upload/photoIntake.ts";
import type { UploadQueueState } from "../upload/useUploadQueue.ts";
import type { ActiveGallery } from "./activeGallery.ts";
import type { GallerySummary } from "./galleryClient.ts";
import type { GalleriesActions, GalleriesState } from "./useGalleries.ts";

/** Keadaan arsip lokal: backend apa yang ada, dan folder mana yang dipilih. */
export interface ArchiveState {
  /** Backend terbaik yang tersedia di browser ini (folder pilihan > OPFS > tidak ada). */
  available: ArchiveBackend;
  /** Backend yang sedang dipakai; `null` = belum dipilih (default OPFS). */
  chosen: ArchiveBackend | null;
  /** Label folder pilihan, untuk ditampilkan; `null` = belum dipilih. */
  chosenLabel: string | null;
  /**
   * Minta operator memilih folder arsip. `null` = dibatalkan/tidak tersedia.
   * Tidak pernah melempar; kegagalan jatuh ke OPFS tanpa error.
   */
  chooseFolder: () => Promise<ArchiveTarget | null>;
  /** Lupakan folder pilihan, kembali ke arsip aplikasi (OPFS). */
  clearFolder: () => void;
}

export interface GalleryContextValue {
  session: OperatorSession | null;
  signIn: (session: OperatorSession) => void;
  signOut: () => void;

  galleries: GalleriesState & GalleriesActions;

  active: ActiveGallery | null;
  setActive: (gallery: GallerySummary, label: string) => void;
  clearActive: () => void;

  queue: UploadQueueState & { runNow: () => Promise<void>; refresh: () => Promise<void> };

  /** Arsip lokal foto — folder pilihan operator atau arsip aplikasi. */
  archive: ArchiveState;

  /** Simpan foto ke arsip lokal lalu masukkan ke antrian. Tidak pernah melempar. */
  intake: (photos: IntakePhoto[]) => Promise<IntakeSummary>;
}

export const GalleryContext = createContext<GalleryContextValue | null>(null);

export function useGallery(): GalleryContextValue {
  const value = useContext(GalleryContext);
  if (value === null) {
    throw new Error("useGallery dipakai di luar GalleryProvider");
  }
  return value;
}
