/**
 * Video guestbook untuk React: dinding pesan tamu + moderasi operator.
 *
 * Dua peran dalam satu hook, karena keduanya membaca data yang sama:
 *
 *   · **Tamu** memakai dinding publik (`wall`) dan memuat berkasnya lewat
 *     `mediaUrl`.
 *   · **Operator** memakai daftar lengkap (`adminList`), menyembunyikan/
 *     menampilkan, dan menghapus.
 *
 * Yang dijaga:
 *
 *   · **Tanpa token, operator tidak memanggil API.** `adminList` langsung
 *     mengembalikan daftar kosong; tidak ada 401 beruntun di kiosk.
 *   · **Balapan respons dibuang** — moderator yang menekan "Muat ulang" dua
 *     kali tidak melihat daftar lama menimpa yang baru.
 *   · **Aksi moderasi selalu memuat ulang dari server**, bukan menambal lokal:
 *     jumlah dan total durasi dihitung server, menambalnya di klien cepat atau
 *     lambat berbeda dari yang tersimpan.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GuestbookEntry } from "@foto-booth/shared";

import {
  createGuestbookClient,
  type GuestbookAdminList,
  type GuestbookClient,
} from "./guestbookClient.ts";

export interface UseGuestbookOptions {
  token: string | null;
  eventId: string | null;
  client?: GuestbookClient;
  baseUrl?: string;
  includeHidden?: boolean;
}

export interface GuestbookState {
  entries: GuestbookEntry[];
  total: number;
  totalDurationSeconds: number;
  loading: boolean;
  error: string | null;
}

export interface GuestbookActions {
  refresh: () => Promise<void>;
  setVisible: (id: string, visible: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  mediaUrl: (id: string) => string;
}

const EMPTY: GuestbookState = {
  entries: [],
  total: 0,
  totalDurationSeconds: 0,
  loading: false,
  error: null,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useGuestbook(options: UseGuestbookOptions): GuestbookState & GuestbookActions {
  const { token, eventId, includeHidden = true } = options;

  const client = useMemo<GuestbookClient>(
    () =>
      options.client ??
      createGuestbookClient({
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(token === null || token === "" ? {} : { token }),
      }),
    [options.client, options.baseUrl, token],
  );

  const [state, setState] = useState<GuestbookState>(EMPTY);
  // Nomor urut balapan: respons lama yang datang belakangan tidak boleh
  // menimpa yang baru.
  const seq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (eventId === null) {
      setState(EMPTY);
      return;
    }
    if (token === null || token === "") {
      // Belum login: daftar lengkap butuh sesi operator. Dinding publik dibaca
      // lewat `wall()`, bukan di sini.
      setState(EMPTY);
      return;
    }

    const mine = ++seq.current;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const list: GuestbookAdminList = await client.adminList(eventId, { includeHidden });
      if (mine !== seq.current) return;
      setState({
        entries: list.entries,
        total: list.total,
        totalDurationSeconds: list.totalDurationSeconds,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (mine !== seq.current) return;
      setState((prev) => ({ ...prev, loading: false, error: messageOf(error) }));
    }
  }, [client, eventId, includeHidden, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      await action();
      await refresh();
    },
    [refresh],
  );

  const setVisible = useCallback(
    async (id: string, visible: boolean): Promise<void> => {
      await mutate(() => client.setVisible(id, visible));
    },
    [client, mutate],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await mutate(() => client.remove(id));
    },
    [client, mutate],
  );

  const mediaUrl = useCallback((id: string): string => client.mediaUrl(id), [client]);

  return useMemo(
    () => ({ ...state, refresh, setVisible, remove, mediaUrl }),
    [state, refresh, setVisible, remove, mediaUrl],
  );
}
