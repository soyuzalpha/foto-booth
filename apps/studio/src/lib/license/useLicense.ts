/**
 * Lisensi & order untuk React: katalog, order, kode aktivasi, entitlement.
 *
 * Dipisah controller (murni) + hook (tipis), seperti `useBranding`, karena ada
 * janji yang hanya bisa dibuktikan tanpa perender:
 *
 *   · **Katalog tetap terbaca tanpa sesi.** Halaman harga publik; kiosk yang
 *     belum login tetap boleh melihat daftar SKU.
 *   · **Balapan refresh dibuang.** Operator menekan "Muat ulang" dua kali;
 *     balasan pertama yang datang belakangan tidak boleh menimpa yang baru.
 *   · **Aksi butuh token dan gagal cepat tanpa token.** Kiosk yang belum login
 *     tidak boleh menembakkan 401 beruntun tiap kali tombol ditekan.
 *   · **Entitlement dihitung ulang setelah menebus kode.** Menampilkan badge
 *     lama sesudah aktivasi berhasil membuat operator mengira kodenya gagal.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CreateOrderInput, OrderStatus } from "@foto-booth/shared";

import {
  createLicenseClient,
  type CatalogState,
  type ClientActivationCode,
  type ClientOrder,
  type EntitlementState,
  type LicenseClient,
} from "./licenseClient.ts";

export interface UseLicenseOptions {
  token: string | null;
  client?: LicenseClient;
  baseUrl?: string;
}

export interface LicenseHookState {
  catalog: CatalogState;
  entitlement: EntitlementState | null;
  orders: ClientOrder[];
  codes: ClientActivationCode[];
  loading: boolean;
  busy: boolean;
  error: string | null;
}

export interface LicenseActions {
  refresh: () => Promise<void>;
  refreshOrders: (filter?: { status?: OrderStatus; email?: string }) => Promise<void>;
  createOrder: (body: CreateOrderInput) => Promise<ClientOrder>;
  setOrderStatus: (id: string, status: OrderStatus, note?: string) => Promise<ClientOrder>;
  activate: (code: string) => Promise<ClientActivationCode>;
}

const EMPTY_CATALOG: CatalogState = { items: [], providers: [], activationCodeLength: 12 };

const INITIAL: LicenseHookState = {
  catalog: EMPTY_CATALOG,
  entitlement: null,
  orders: [],
  codes: [],
  loading: false,
  busy: false,
  error: null,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useLicense(options: UseLicenseOptions): LicenseHookState & LicenseActions {
  const { token } = options;

  // Klien tanpa token tetap boleh membaca katalog (publik), jadi satu klien
  // cukup — token hanya dipakai aksi operator.
  const client = useMemo<LicenseClient>(
    () =>
      options.client ??
      createLicenseClient({
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(token === null || token === "" ? {} : { token }),
      }),
    [options.client, options.baseUrl, token],
  );

  const [state, setState] = useState<LicenseHookState>(INITIAL);

  // Nomor urut permintaan: balasan yang datang belakangan tapi berasal dari
  // permintaan lebih lama dibuang, supaya "Muat ulang" yang diklik dua kali
  // tidak menampilkan hasil klik pertama.
  const seq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = (seq.current += 1);
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const catalog = await client.catalog();
      // Katalog dulu: satu-satunya yang tidak butuh sesi, jadi panel tetap
      // punya sesuatu untuk ditampilkan walau sisanya gagal.
      if (mine !== seq.current) return;

      let entitlement: EntitlementState | null = null;
      let orders: ClientOrder[] = [];
      if (token !== null && token !== "") {
        entitlement = await client.entitlement();
        if (mine !== seq.current) return;
        orders = await client.listOrders({ limit: 50 });
      }
      if (mine !== seq.current) return;
      setState((prev) => ({ ...prev, catalog, entitlement, orders, loading: false, error: null }));
    } catch (error) {
      if (mine !== seq.current) return;
      setState((prev) => ({ ...prev, loading: false, error: messageOf(error) }));
    }
  }, [client, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshOrders = useCallback(
    async (filter: { status?: OrderStatus; email?: string } = {}): Promise<void> => {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const orders = await client.listOrders({ ...filter, limit: 50 });
        setState((prev) => ({ ...prev, orders, loading: false, error: null }));
      } catch (error) {
        setState((prev) => ({ ...prev, loading: false, error: messageOf(error) }));
      }
    },
    [client],
  );

  const createOrder = useCallback(
    async (body: CreateOrderInput): Promise<ClientOrder> => {
      setState((prev) => ({ ...prev, busy: true, error: null }));
      try {
        const order = await client.createOrder(body);
        setState((prev) => ({ ...prev, orders: [order, ...prev.orders], busy: false, error: null }));
        return order;
      } catch (error) {
        setState((prev) => ({ ...prev, busy: false, error: messageOf(error) }));
        throw error;
      }
    },
    [client],
  );

  const setOrderStatus = useCallback(
    async (id: string, status: OrderStatus, note?: string): Promise<ClientOrder> => {
      setState((prev) => ({ ...prev, busy: true, error: null }));
      try {
        const { order, issuedCode } = await client.setOrderStatus(id, status, note);
        setState((prev) => ({
          ...prev,
          orders: prev.orders.map((o) => (o.id === id ? order : o)),
          codes: issuedCode === null ? prev.codes : [issuedCode, ...prev.codes],
          busy: false,
          error: null,
        }));
        return order;
      } catch (error) {
        setState((prev) => ({ ...prev, busy: false, error: messageOf(error) }));
        throw error;
      }
    },
    [client],
  );

  const activate = useCallback(
    async (code: string): Promise<ClientActivationCode> => {
      setState((prev) => ({ ...prev, busy: true, error: null }));
      try {
        const result = await client.activate(code);
        setState((prev) => ({
          ...prev,
          // Entitlement dihitung ulang dari balasan aktivasi: badge lama
          // sesudah kode berhasil ditebus membuat operator mengira gagal.
          entitlement: {
            entitlement: result.entitlement,
            verdict: result.verdict,
            limits: result.limits,
          },
          codes: [result.code, ...prev.codes],
          busy: false,
          error: null,
        }));
        return result.code;
      } catch (error) {
        setState((prev) => ({ ...prev, busy: false, error: messageOf(error) }));
        throw error;
      }
    },
    [client],
  );

  return useMemo(
    () => ({ ...state, refresh, refreshOrders, createOrder, setOrderStatus, activate }),
    [state, refresh, refreshOrders, createOrder, setOrderStatus, activate],
  );
}
