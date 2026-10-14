/**
 * Branding untuk React: baca, ubah, simpan.
 *
 * Dipisah controller (murni) + hook (tipis), seperti `useLeads`, karena ada
 * janji yang hanya bisa dibuktikan tanpa perender:
 *
 *   · **Balapan simpan dibuang.** Operator menekan "Simpan" dua kali dengan
 *     cepat; balasan pertama yang datang belakangan tidak boleh menimpa yang
 *     baru.
 *   · **Pratinjau mengikuti ketikan, tapi nilai tersimpan tetap.** Panel
 *     menampilkan `draft` (yang diketik), sementara `branding` tetap nilai
 *     server sampai simpan berhasil.
 *   · **Tanpa token, jangan panggil simpan.** Kiosk yang belum login akan
 *     menembakkan 401 beruntun kalau tombol simpan tetap jalan.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DEFAULT_BRANDING,
  type Branding,
  type UpdateBranding,
} from "@foto-booth/shared";

import {
  createBrandingClient,
  type BrandingClient,
  type BrandingState,
} from "./brandingClient.ts";

export interface UseBrandingOptions {
  token: string | null;
  client?: BrandingClient;
  baseUrl?: string;
}

export interface BrandingHookState extends BrandingState {
  loading: boolean;
  saving: boolean;
  error: string | null;
}

export interface BrandingActions {
  refresh: () => Promise<void>;
  save: (patch: UpdateBranding) => Promise<Branding>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const INITIAL: BrandingHookState = {
  branding: { ...DEFAULT_BRANDING },
  isDefault: true,
  loading: false,
  saving: false,
  error: null,
};

export function useBranding(options: UseBrandingOptions): BrandingHookState & BrandingActions {
  const { token } = options;

  const client = useMemo<BrandingClient>(
    () =>
      options.client ??
      createBrandingClient(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    [options.client, options.baseUrl],
  );

  // Klien tanpa token tetap boleh membaca (endpoint publik), jadi satu klien
  // saja cukup — token hanya dipakai saat menyimpan.
  const savingClient = useMemo<BrandingClient>(() => {
    if (options.client !== undefined) return options.client;
    return createBrandingClient({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(token === null || token === "" ? {} : { token }),
    });
  }, [options.client, options.baseUrl, token]);

  const [state, setState] = useState<BrandingHookState>(INITIAL);

  const refresh = useCallback(async (): Promise<void> => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const next = await client.get();
      setState({ ...next, loading: false, saving: false, error: null });
    } catch (error) {
      setState((prev) => ({ ...prev, loading: false, error: messageOf(error) }));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (patch: UpdateBranding): Promise<Branding> => {
      setState((prev) => ({ ...prev, saving: true, error: null }));
      try {
        const next = await savingClient.save(patch);
        setState({ ...next, loading: false, saving: false, error: null });
        return next.branding;
      } catch (error) {
        setState((prev) => ({ ...prev, saving: false, error: messageOf(error) }));
        throw error;
      }
    },
    [savingClient],
  );

  return useMemo(
    () => ({ ...state, refresh, save }),
    [state, refresh, save],
  );
}
