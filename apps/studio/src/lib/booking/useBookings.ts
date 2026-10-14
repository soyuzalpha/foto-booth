/**
 * Daftar booking operator + paket + setelan + aksi.
 *
 * Logikanya dipisah dua lapis — `createBookingsController` (murni, tanpa React)
 * dan `useBookings` (pembungkus tipis) — karena beberapa janji di modul ini
 * hanya bisa dibuktikan kalau logikanya bisa dijalankan tanpa perender:
 *
 *   · **Tanpa token, jangan memanggil API.** Kiosk yang belum login akan
 *     menembakkan 401 beruntun kalau `refresh` tetap jalan.
 *   · **Balapan respons dibuang.** Operator menekan "Muat ulang" dua kali:
 *     respons pertama yang datang belakangan tidak boleh menimpa yang baru.
 *   · **Satu kegagalan tidak mengosongkan yang lain.** Gagal memuat laporan
 *     tidak boleh menghapus daftar booking yang sudah tampil.
 */

import { useEffect, useMemo, useState } from "react";

import {
  DEFAULT_BOOKING_SETTINGS,
  type Booking,
  type BookingPackage,
  type BookingSettings,
  type CreateBookingPackage,
  type DepositStatus,
  type RescheduleBooking,
  type UpdateBookingPackage,
  type UpdateBookingSettings,
  type UpdateBookingStatus,
} from "@foto-booth/shared";

import {
  createBookingClient,
  type BookingClient,
  type BookingMessageKind,
  type BookingNotification,
  type BookingReminders,
  type BookingReport,
  type ClientInvoice,
} from "./bookingClient.ts";

export interface UseBookingsOptions {
  token: string | null;
  /** Injectable untuk tes. */
  client?: BookingClient;
  baseUrl?: string;
}

export interface BookingsState {
  bookings: Booking[];
  packages: BookingPackage[];
  settings: BookingSettings;
  report: BookingReport | null;
  /** Booking yang menunggu pengingat H-1 + status kanal kirim. */
  reminders: BookingReminders | null;
  loading: boolean;
  error: string | null;
}

export interface BookingsActions {
  refresh: () => Promise<void>;
  refreshReport: (range?: { from?: string; to?: string }) => Promise<void>;
  refreshReminders: () => Promise<void>;
  createPackage: (body: CreateBookingPackage) => Promise<BookingPackage>;
  updatePackage: (id: string, body: UpdateBookingPackage) => Promise<BookingPackage>;
  updateSettings: (body: UpdateBookingSettings) => Promise<BookingSettings>;
  setStatus: (id: string, body: UpdateBookingStatus) => Promise<Booking>;
  setDeposit: (id: string, status: DepositStatus) => Promise<Booking>;
  reschedule: (id: string, body: RescheduleBooking) => Promise<Booking>;
  /** Ambil invoice + kwitansi satu booking. Tidak mengubah daftar. */
  loadInvoice: (id: string) => Promise<ClientInvoice>;
  /** Unduh kwitansi teks polos apa adanya dari server. */
  loadInvoiceText: (id: string) => Promise<string>;
  /** Kirim/siapkan pesan ke tamu; mengembalikan apa yang benar-benar terjadi. */
  notify: (id: string, kind: BookingMessageKind) => Promise<BookingNotification>;
}

export interface BookingsController extends BookingsActions {
  getState: () => BookingsState;
}

const EMPTY_STATE: BookingsState = {
  bookings: [],
  packages: [],
  settings: DEFAULT_BOOKING_SETTINGS,
  report: null,
  reminders: null,
  loading: false,
  error: null,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBookingsController(options: {
  client: BookingClient | null;
  onState?: (state: BookingsState) => void;
}): BookingsController {
  let state: BookingsState = EMPTY_STATE;
  let seq = 0;

  function set(next: BookingsState): void {
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
    // Daftar lama sengaja tetap ada selama memuat: mengosongkannya bikin layar
    // berkedip kosong tiap kali operator menekan "Muat ulang".
    set({ ...state, loading: true, error: null });

    try {
      const [bookings, packages, settings] = await Promise.all([
        client.listBookings(),
        client.listPackages(),
        client.getSettings(),
      ]);
      if (mine !== seq) return;
      set({ ...state, bookings, packages, settings, loading: false, error: null });
    } catch (error) {
      if (mine !== seq) return;
      set({ ...state, loading: false, error: messageOf(error) });
    }
  }

  async function refreshReport(range: { from?: string; to?: string } = {}): Promise<void> {
    const client = options.client;
    if (client === null) return;

    try {
      const report = await client.report(range);
      set({ ...state, report });
    } catch (error) {
      // Laporan gagal tidak mengosongkan daftar booking yang sudah tampil:
      // yang satu ringkasan, yang lain data kerja operator.
      set({ ...state, error: messageOf(error) });
    }
  }

  async function refreshReminders(): Promise<void> {
    const client = options.client;
    if (client === null) return;

    try {
      const reminders = await client.reminders();
      set({ ...state, reminders });
    } catch (error) {
      // Sama seperti laporan: gagal memuat pengingat tidak boleh mengosongkan
      // daftar booking yang sudah tampil.
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
    refreshReport,
    refreshReminders,

    async createPackage(body) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      return mutate(() => client.createPackage(body));
    },

    async updatePackage(id, body) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      return mutate(() => client.updatePackage(id, body));
    },

    async updateSettings(body) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      return mutate(() => client.updateSettings(body));
    },

    async setStatus(id, body) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      return mutate(() => client.setStatus(id, body));
    },

    async setDeposit(id, status) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      return mutate(() => client.setDeposit(id, status));
    },

    async reschedule(id, body) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      return mutate(() => client.reschedule(id, body));
    },

    async loadInvoice(id) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      // Bukan `mutate`: membaca invoice tidak mengubah daftar booking, jadi
      // tidak perlu memicu muat ulang penuh.
      return client.invoice(id);
    },

    async loadInvoiceText(id) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      return client.invoiceText(id);
    },

    async notify(id, kind) {
      const client = options.client;
      if (client === null) throw new Error("belum login");
      const result = await client.notify(id, kind);
      // Pengingat yang benar-benar terkirim menandai `reminded_at` di server;
      // daftar pengingat harus ikut menyusut, bukan tetap menampilkan booking
      // yang baru saja diingatkan.
      if (result.delivered && kind === "reminder") await refreshReminders();
      return result;
    },
  };
}

export function useBookings(options: UseBookingsOptions): BookingsState & BookingsActions {
  const { token } = options;

  const client = useMemo<BookingClient | null>(() => {
    if (options.client !== undefined) return options.client;
    if (token === null || token === "") return null;
    return createBookingClient(
      options.baseUrl === undefined ? { token } : { token, baseUrl: options.baseUrl },
    );
  }, [options.client, options.baseUrl, token]);

  const [state, setState] = useState<BookingsState>(EMPTY_STATE);

  const controller = useMemo(
    () => createBookingsController({ client, onState: setState }),
    [client],
  );

  useEffect(() => {
    void controller.refresh();
    // Ringkasan okupansi ikut dimuat saat tab dibuka. Tanpa ini kartunya
    // menampilkan "belum ada data" padahal datanya ada — terbaca seperti
    // laporan kosong, bukan seperti belum dimuat.
    void controller.refreshReport();
    void controller.refreshReminders();
  }, [controller]);

  return useMemo(
    () => ({
      ...state,
      refresh: controller.refresh,
      refreshReport: controller.refreshReport,
      refreshReminders: controller.refreshReminders,
      createPackage: controller.createPackage,
      updatePackage: controller.updatePackage,
      updateSettings: controller.updateSettings,
      setStatus: controller.setStatus,
      setDeposit: controller.setDeposit,
      reschedule: controller.reschedule,
      loadInvoice: controller.loadInvoice,
      loadInvoiceText: controller.loadInvoiceText,
      notify: controller.notify,
    }),
    [controller, state],
  );
}
