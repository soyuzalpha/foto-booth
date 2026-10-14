/**
 * Daftar field, data masuk, dan angka per acara — dibungkus untuk React.
 *
 * Logikanya dipisah dua lapis — `createLeadsController` (murni, tanpa React)
 * dan `useLeads` (pembungkus tipis) — karena beberapa janji di modul ini hanya
 * bisa dibuktikan kalau logikanya bisa dijalankan tanpa perender:
 *
 *   · **Tanpa token, jangan memanggil API.** Kiosk yang belum login akan
 *     menembakkan 401 beruntun kalau `refresh` tetap jalan.
 *   · **Balapan respons dibuang.** Operator menekan "Muat ulang" dua kali:
 *     respons pertama yang datang belakangan tidak boleh menimpa yang baru.
 *   · **Satu kegagalan tidak mengosongkan yang lain.** Gagal memuat angka
 *     tidak boleh menghapus data tamu yang sudah tampil.
 */

import { useEffect, useMemo, useState } from "react";

import type { AnalyticsOverview, CreateLeadField, Lead, LeadField, UpdateLeadField } from "@foto-booth/shared";

import { createLeadsClient, type LeadsClient } from "./leadsClient.ts";

export interface UseLeadsOptions {
  token: string | null;
  /** Injectable untuk tes. */
  client?: LeadsClient;
  baseUrl?: string;
}

export interface LeadsState {
  fields: LeadField[];
  /** Batas field per lingkup dari API; `null` kalau API tidak mengirimnya. */
  maxFields: number | null;
  leads: Lead[];
  analytics: AnalyticsOverview | null;
  loading: boolean;
  error: string | null;
}

export interface LeadsActions {
  refresh: () => Promise<void>;
  refreshAnalytics: (range?: { from?: string; to?: string }) => Promise<void>;
  createField: (body: CreateLeadField) => Promise<LeadField>;
  updateField: (id: string, body: UpdateLeadField) => Promise<LeadField>;
  deleteField: (id: string) => Promise<void>;
  removeLead: (id: string) => Promise<void>;
  exportCsv: (filter?: { eventId?: string; from?: string }) => Promise<{ filename: string; csv: string }>;
}

export interface LeadsController extends LeadsActions {
  getState: () => LeadsState;
}

const EMPTY_STATE: LeadsState = {
  fields: [],
  maxFields: null,
  leads: [],
  analytics: null,
  loading: false,
  error: null,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLeadsController(options: {
  client: LeadsClient | null;
  onState?: (state: LeadsState) => void;
}): LeadsController {
  let state: LeadsState = EMPTY_STATE;
  let seq = 0;

  function set(next: LeadsState): void {
    state = next;
    options.onState?.(state);
  }

  async function refresh(): Promise<void> {
    const client = options.client;
    if (client === null) {
      // Belum login: bersihkan, tapi jangan tandai "memuat" — tidak ada yang
      // sedang dimuat, dan badge "memuat" yang tak pernah selesai menyesatkan.
      set(EMPTY_STATE);
      return;
    }

    const mine = ++seq;
    // Daftar lama tetap tampil selama memuat: mengosongkannya bikin layar
    // berkedip kosong tiap kali operator menekan "Muat ulang".
    set({ ...state, loading: true, error: null });

    try {
      const [fieldList, leadList] = await Promise.all([client.listFields(), client.listLeads()]);
      if (mine !== seq) return;
      set({
        ...state,
        fields: fieldList.fields,
        maxFields: fieldList.maxFields,
        leads: leadList.leads,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (mine !== seq) return;
      set({ ...state, loading: false, error: messageOf(error) });
    }
  }

  async function refreshAnalytics(range: { from?: string; to?: string } = {}): Promise<void> {
    const client = options.client;
    if (client === null) return;

    try {
      const analytics = await client.analytics(range);
      set({ ...state, analytics });
    } catch (error) {
      // Angka gagal tidak mengosongkan data tamu yang sudah tampil: yang satu
      // ringkasan, yang lain daftar kerja operator.
      set({ ...state, error: messageOf(error) });
    }
  }

  /** Aksi yang mengubah data selalu memuat ulang dari server, bukan menambal lokal. */
  async function mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = await action();
    await refresh();
    return result;
  }

  return {
    getState: () => state,
    refresh,
    refreshAnalytics,

    async createField(body) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      return mutate(() => client.createField(body));
    },

    async updateField(id, body) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      return mutate(() => client.updateField(id, body));
    },

    async deleteField(id) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      await client.deleteField(id);
      await refresh();
    },

    async removeLead(id) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      await client.deleteLead(id);
      await refresh();
    },

    async exportCsv(filter = {}) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      return client.exportCsv(filter);
    },
  };
}

export function useLeads(options: UseLeadsOptions): LeadsState & LeadsActions {
  const { token } = options;

  const client = useMemo<LeadsClient | null>(() => {
    if (options.client !== undefined) return options.client;
    if (token === null || token === "") return null;
    return createLeadsClient(
      options.baseUrl === undefined ? { token } : { token, baseUrl: options.baseUrl },
    );
  }, [options.client, options.baseUrl, token]);

  const [state, setState] = useState<LeadsState>(EMPTY_STATE);

  const controller = useMemo(() => createLeadsController({ client, onState: setState }), [client]);

  useEffect(() => {
    void controller.refresh();
    // Angka ikut dimuat saat tab dibuka. Tanpa ini kartunya menampilkan
    // "belum ada data" padahal datanya ada — terbaca seperti laporan kosong,
    // bukan seperti belum dimuat.
    void controller.refreshAnalytics();
  }, [controller]);

  return useMemo(
    () => ({
      ...state,
      refresh: controller.refresh,
      refreshAnalytics: controller.refreshAnalytics,
      createField: controller.createField,
      updateField: controller.updateField,
      deleteField: controller.deleteField,
      removeLead: controller.removeLead,
      exportCsv: controller.exportCsv,
    }),
    [controller, state],
  );
}
