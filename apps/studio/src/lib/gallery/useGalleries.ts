/**
 * Daftar galeri operator + aksi buat/hapus.
 *
 * Hook ini **tidak** menyimpan galeri aktif: itu urusan `GalleryProvider`,
 * karena galeri aktif dibaca juga oleh antrian upload dan halaman capture.
 * Di sini cuma data dari API.
 *
 * Logikanya dipisah dua lapis — `createGalleriesController` (murni, tanpa
 * React) dan `useGalleries` (pembungkus tipis). Bukan karena gaya: dua janji
 * di modul ini hanya bisa dibuktikan kalau logikanya bisa dijalankan tanpa
 * perender. Keduanya adalah janji yang gagalnya tidak terlihat di UI:
 *
 *   · **Tanpa token, jangan memanggil API.** Kiosk yang belum login akan
 *     menembakkan 401 beruntun kalau `refresh` tetap jalan. `token === null`
 *     berarti "belum login", bukan "token kosong yang dicoba dulu".
 *   · **Balapan respons dibuang.** Operator menekan "Muat ulang" dua kali:
 *     respons pertama yang datang belakangan tidak boleh menimpa yang lebih
 *     baru. `seq` yang menjaga itu — dan balapan asinkron tidak bisa diuji
 *     lewat render.
 */

import { useEffect, useMemo, useState } from "react";

import type { CreateEvent, CreateGallery, Event } from "@foto-booth/shared";

import { createGalleryClient, type GalleryClient, type GallerySummary } from "./galleryClient.ts";

export interface UseGalleriesOptions {
  token: string | null;
  /** Injectable untuk tes. */
  client?: GalleryClient;
  baseUrl?: string;
}

export interface GalleriesState {
  galleries: GallerySummary[];
  loading: boolean;
  error: string | null;
}

export interface GalleriesActions {
  refresh: () => Promise<void>;
  createEvent: (body: CreateEvent) => Promise<Event>;
  createGallery: (body: CreateGallery) => Promise<GallerySummary>;
  removeGallery: (id: string) => Promise<void>;
}

/** Versi tanpa React: state disimpan di closure, perubahan dilaporkan lewat `onState`. */
export interface GalleriesController extends GalleriesActions {
  getState: () => GalleriesState;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGalleriesController(options: {
  client: GalleryClient | null;
  onState?: (state: GalleriesState) => void;
}): GalleriesController {
  let state: GalleriesState = { galleries: [], loading: false, error: null };
  let seq = 0;

  function set(next: GalleriesState): void {
    state = next;
    options.onState?.(state);
  }

  async function refresh(): Promise<void> {
    const client = options.client;
    if (client === null) {
      set({ galleries: [], loading: false, error: null });
      return;
    }

    const mine = ++seq;
    // Daftar lama sengaja tetap ada selama memuat: mengosongkannya bikin layar
    // berkedip kosong tiap kali operator menekan "Muat ulang".
    set({ ...state, loading: true, error: null });

    try {
      const galleries = await client.listGalleries();
      if (mine !== seq) return;
      set({ galleries, loading: false, error: null });
    } catch (error) {
      if (mine !== seq) return;
      set({ ...state, loading: false, error: messageOf(error) });
    }
  }

  return {
    getState: () => state,
    refresh,

    async createEvent(body: CreateEvent): Promise<Event> {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      return client.createEvent(body);
    },

    async createGallery(body: CreateGallery): Promise<GallerySummary> {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      const created = await client.createGallery(body);
      // Daftar di-refresh dari server, bukan disisipkan lokal: `photoCount`
      // dan `url` dihitung server, dan menebaknya di klien bikin angkanya
      // berbeda dari yang dilihat tamu.
      await refresh();
      return created;
    },

    async removeGallery(id: string): Promise<void> {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      await client.deleteGallery(id);
      await refresh();
    },
  };
}

export function useGalleries(options: UseGalleriesOptions): GalleriesState & GalleriesActions {
  const { token } = options;

  const client = useMemo<GalleryClient | null>(() => {
    if (options.client !== undefined) return options.client;
    if (token === null || token === "") return null;
    return createGalleryClient(
      options.baseUrl === undefined ? { token } : { token, baseUrl: options.baseUrl },
    );
  }, [options.client, options.baseUrl, token]);

  const [state, setState] = useState<GalleriesState>({ galleries: [], loading: false, error: null });

  const controller = useMemo(
    () => createGalleriesController({ client, onState: setState }),
    [client],
  );

  useEffect(() => {
    void controller.refresh();
  }, [controller]);

  return useMemo(
    () => ({
      ...state,
      refresh: controller.refresh,
      createEvent: controller.createEvent,
      createGallery: controller.createGallery,
      removeGallery: controller.removeGallery,
    }),
    [controller, state],
  );
}
