/**
 * Klien HTTP panel booking: paket, setelan, daftar booking, dan laporan.
 *
 * Sisi **operator** — semua request butuh token sesi. Sisi tamu (form `/booking`
 * dan halaman status `/booking/s/<token>`) tidak lewat modul ini: keduanya HTML
 * dari API, dan studio tidak pernah merendernya.
 *
 * Aturan yang menentukan bentuknya:
 *
 *   · **Balasan divalidasi per-item.** Satu booking rusak di tengah daftar
 *     dibuang; sisanya tetap tampil. Melempar di situ mengosongkan seluruh
 *     panel gara-gara satu baris buruk.
 *   · **Setelan dibaca dengan cadangan.** `GET .../settings` mengembalikan
 *     objeknya langsung, bukan dibungkus. Kalau bentuknya tidak dikenali,
 *     `DEFAULT_BOOKING_SETTINGS` dipakai supaya formulir tidak menampilkan
 *     `undefined` di tiap kolom.
 *   · **`paymentProvider` tidak pernah ditebak.** Nilainya diteruskan apa
 *     adanya; UI yang memutuskan cara menampilkan "belum ada gateway".
 */

import {
  API_PREFIX,
  BookingPackageSchema,
  BookingSchema,
  BookingSettingsSchema,
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

/** Ringkas okupansi satu paket, seperti `GET /v1/booking/admin/report`. */
export interface PackageReport {
  packageId: string;
  packageName: string;
  durationMinutes: number;
  booked: number;
  requested: number;
  cancelled: number;
  rejected: number;
  bookedHours: number;
  revenueIdr: number;
  depositIdr: number;
}

export interface BookingReport {
  from: string;
  to: string;
  total: {
    booked: number;
    requested: number;
    cancelled: number;
    rejected: number;
    bookedHours: number;
    revenueIdr: number;
    depositIdr: number;
  };
  packages: PackageReport[];
}

export interface BookingClient {
  listPackages(): Promise<BookingPackage[]>;
  createPackage(body: CreateBookingPackage): Promise<BookingPackage>;
  updatePackage(id: string, body: UpdateBookingPackage): Promise<BookingPackage>;
  getSettings(): Promise<BookingSettings>;
  updateSettings(body: UpdateBookingSettings): Promise<BookingSettings>;
  listBookings(filter?: { from?: string; to?: string; status?: string }): Promise<Booking[]>;
  setStatus(id: string, body: UpdateBookingStatus): Promise<Booking>;
  setDeposit(id: string, status: DepositStatus): Promise<Booking>;
  reschedule(id: string, body: RescheduleBooking): Promise<Booking>;
  report(range?: { from?: string; to?: string }): Promise<BookingReport>;
}

export class BookingHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BookingHttpError";
    this.status = status;
  }
}

export interface BookingClientOptions {
  /** Token sesi operator. Wajib — tanpa ini semua route mengembalikan 401. */
  token: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

async function describeFailure(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
  } catch {
    // Bukan JSON — status saja.
  }
  return `HTTP ${res.status}`;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Satu baris laporan; `null` kalau bentuknya tidak dikenali. */
export function parsePackageReport(raw: unknown): PackageReport | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const packageId = readString(source.packageId);
  if (packageId === "") return null;

  return {
    packageId,
    packageName: readString(source.packageName),
    durationMinutes: readCount(source.durationMinutes),
    booked: readCount(source.booked),
    requested: readCount(source.requested),
    cancelled: readCount(source.cancelled),
    rejected: readCount(source.rejected),
    bookedHours: readNumber(source.bookedHours),
    revenueIdr: readCount(source.revenueIdr),
    depositIdr: readCount(source.depositIdr),
  };
}

/**
 * Setelan booking dari API.
 *
 * Objek yang tidak dikenali → default, bukan lemparan: panel setelan yang gagal
 * memuat tidak boleh membuat seluruh tab booking kosong.
 */
export function parseBookingSettings(raw: unknown): BookingSettings {
  const parsed = BookingSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_BOOKING_SETTINGS;
}

export function createBookingClient(options: BookingClientOptions): BookingClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? globalThis.fetch;
  const auth = { authorization: `Bearer ${options.token}` };

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await doFetch(`${baseUrl}${API_PREFIX}${path}`, {
      ...init,
      headers: { ...auth, accept: "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new BookingHttpError(res.status, await describeFailure(res));
    return res;
  }

  async function sendBooking(path: string, init: RequestInit = {}): Promise<Booking> {
    const res = await send(path, init);
    const parsed = BookingSchema.safeParse(await res.json());
    if (!parsed.success) throw new BookingHttpError(res.status, "balasan booking tidak dikenali");
    return parsed.data;
  }

  return {
    async listPackages() {
      const res = await send("/booking/admin/packages");
      const body = (await res.json()) as { packages?: unknown };
      if (!Array.isArray(body.packages)) return [];

      const packages: BookingPackage[] = [];
      for (const raw of body.packages) {
        const parsed = BookingPackageSchema.safeParse(raw);
        if (parsed.success) packages.push(parsed.data);
      }
      return packages;
    },

    async createPackage(body) {
      const res = await send("/booking/admin/packages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = BookingPackageSchema.safeParse(await res.json());
      if (!parsed.success) throw new BookingHttpError(res.status, "balasan paket tidak dikenali");
      return parsed.data;
    },

    async updatePackage(id, body) {
      const res = await send(`/booking/admin/packages/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = BookingPackageSchema.safeParse(await res.json());
      if (!parsed.success) throw new BookingHttpError(res.status, "balasan paket tidak dikenali");
      return parsed.data;
    },

    async getSettings() {
      const res = await send("/booking/admin/settings");
      return parseBookingSettings(await res.json());
    },

    async updateSettings(body) {
      const res = await send("/booking/admin/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return parseBookingSettings(await res.json());
    },

    async listBookings(filter = {}) {
      const query = new URLSearchParams();
      if (filter.from !== undefined) query.set("from", filter.from);
      if (filter.to !== undefined) query.set("to", filter.to);
      if (filter.status !== undefined) query.set("status", filter.status);
      const suffix = query.size > 0 ? `?${query.toString()}` : "";

      const res = await send(`/booking/admin/bookings${suffix}`);
      const body = (await res.json()) as { bookings?: unknown };
      if (!Array.isArray(body.bookings)) return [];

      const bookings: Booking[] = [];
      for (const raw of body.bookings) {
        const parsed = BookingSchema.safeParse(raw);
        if (parsed.success) bookings.push(parsed.data);
      }
      return bookings;
    },

    async setStatus(id, body) {
      return sendBooking(`/booking/admin/bookings/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },

    async setDeposit(id, status) {
      return sendBooking(`/booking/admin/bookings/${encodeURIComponent(id)}/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
    },

    async reschedule(id, body) {
      return sendBooking(`/booking/admin/bookings/${encodeURIComponent(id)}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },

    async report(range = {}) {
      const query = new URLSearchParams();
      if (range.from !== undefined) query.set("from", range.from);
      if (range.to !== undefined) query.set("to", range.to);
      const suffix = query.size > 0 ? `?${query.toString()}` : "";

      const res = await send(`/booking/admin/report${suffix}`);
      const body = (await res.json()) as Record<string, unknown>;
      const totalSource = (body.total ?? {}) as Record<string, unknown>;

      const packages: PackageReport[] = [];
      if (Array.isArray(body.packages)) {
        for (const raw of body.packages) {
          const parsed = parsePackageReport(raw);
          if (parsed !== null) packages.push(parsed);
        }
      }

      return {
        from: readString(body.from),
        to: readString(body.to),
        total: {
          booked: readCount(totalSource.booked),
          requested: readCount(totalSource.requested),
          cancelled: readCount(totalSource.cancelled),
          rejected: readCount(totalSource.rejected),
          bookedHours: readNumber(totalSource.bookedHours),
          revenueIdr: readCount(totalSource.revenueIdr),
          depositIdr: readCount(totalSource.depositIdr),
        },
        packages,
      };
    },
  };
}
