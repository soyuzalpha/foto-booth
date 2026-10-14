/**
 * Klien HTTP panel leads & analytics: definisi field, data masuk, ekspor CSV,
 * dan angka per acara.
 *
 * Sisi **operator** — semua request butuh token sesi. Sisi tamu (form data di
 * halaman `/a/:hash`) tidak lewat modul ini: halaman itu HTML dari API.
 *
 * Aturan yang menentukan bentuknya:
 *
 *   · **Balasan divalidasi per-item.** Satu field rusak di tengah daftar
 *     dibuang; sisanya tetap tampil. Melempar di situ mengosongkan seluruh
 *     layar pengaturan gara-gara satu baris buruk.
 *   · **`maxFields` dibaca dengan cadangan.** Kalau API tidak mengirimnya, UI
 *     tetap boleh menampilkan daftar; yang hilang hanya info "sisa slot".
 *   · **Ekspor CSV mengembalikan teks, bukan blob.** Unduhan disusun di panel;
 *     di sini yang diuji cukup "teks CSV ini apa dan namanya apa", tanpa
 *     menyentuh `URL.createObjectURL` yang tidak ada di Node.
 *   · **Nama berkas dari header, bukan tebakan.** API menaruh
 *     `content-disposition`; kalau tidak ada, dipakai nama cadangan supaya
 *     unduhan tidak bernama "download".
 */

import {
  API_PREFIX,
  AnalyticsOverviewSchema,
  LeadFieldSchema,
  LeadSchema,
  type AnalyticsOverview,
  type CreateLeadField,
  type Lead,
  type LeadField,
  type UpdateLeadField,
} from "@foto-booth/shared";

export interface LeadsClient {
  listFields(eventId?: string): Promise<{ fields: LeadField[]; maxFields: number | null }>;
  createField(body: CreateLeadField): Promise<LeadField>;
  updateField(id: string, body: UpdateLeadField): Promise<LeadField>;
  deleteField(id: string): Promise<void>;
  listLeads(filter?: { eventId?: string; galleryId?: string; from?: string; limit?: number }): Promise<{
    leads: Lead[];
    fields: LeadField[];
  }>;
  deleteLead(id: string): Promise<void>;
  exportCsv(filter?: { eventId?: string; from?: string }): Promise<{ filename: string; csv: string }>;
  analytics(range?: { from?: string; to?: string }): Promise<AnalyticsOverview | null>;
}

export class LeadsHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LeadsHttpError";
    this.status = status;
  }
}

export interface LeadsClientOptions {
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

/** Nama berkas dari `content-disposition`, kalau ada. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (header === null) return fallback;

  // Bentuk `filename*=UTF-8''nama.csv` menang atas `filename="nama.csv"`:
  // yang pertama membawa nama asli, yang kedua versi ASCII-nya.
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended !== null && extended[1] !== undefined) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // Persen-encoding rusak — pakai bentuk biasa di bawah.
    }
  }

  const plain = /filename="?([^";]+)"?/i.exec(header);
  if (plain === null || plain[1] === undefined) return fallback;
  return plain[1].trim();
}

export function createLeadsClient(options: LeadsClientOptions): LeadsClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? globalThis.fetch;
  const auth = { authorization: `Bearer ${options.token}` };

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await doFetch(`${baseUrl}${API_PREFIX}${path}`, {
      ...init,
      headers: { ...auth, accept: "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new LeadsHttpError(res.status, await describeFailure(res));
    return res;
  }

  function parseFields(raw: unknown): LeadField[] {
    if (!Array.isArray(raw)) return [];
    const fields: LeadField[] = [];
    for (const item of raw) {
      const parsed = LeadFieldSchema.safeParse(item);
      if (parsed.success) fields.push(parsed.data);
    }
    return fields;
  }

  return {
    async listFields(eventId) {
      const suffix = eventId === undefined ? "" : `?eventId=${encodeURIComponent(eventId)}`;
      const res = await send(`/leads/admin/fields${suffix}`);
      const body = (await res.json()) as { fields?: unknown; maxFields?: unknown };

      return {
        fields: parseFields(body.fields),
        maxFields:
          typeof body.maxFields === "number" && Number.isFinite(body.maxFields) ? body.maxFields : null,
      };
    },

    async createField(body) {
      const res = await send("/leads/admin/fields", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = LeadFieldSchema.safeParse(await res.json());
      if (!parsed.success) throw new LeadsHttpError(res.status, "balasan field tidak dikenali");
      return parsed.data;
    },

    async updateField(id, body) {
      const res = await send(`/leads/admin/fields/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = LeadFieldSchema.safeParse(await res.json());
      if (!parsed.success) throw new LeadsHttpError(res.status, "balasan field tidak dikenali");
      return parsed.data;
    },

    async deleteField(id) {
      await send(`/leads/admin/fields/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    async listLeads(filter = {}) {
      const query = new URLSearchParams();
      if (filter.eventId !== undefined) query.set("eventId", filter.eventId);
      if (filter.galleryId !== undefined) query.set("galleryId", filter.galleryId);
      if (filter.from !== undefined) query.set("from", filter.from);
      if (filter.limit !== undefined) query.set("limit", String(filter.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";

      const res = await send(`/leads/admin/leads${suffix}`);
      const body = (await res.json()) as { leads?: unknown; fields?: unknown };

      const leads: Lead[] = [];
      if (Array.isArray(body.leads)) {
        for (const item of body.leads) {
          const parsed = LeadSchema.safeParse(item);
          if (parsed.success) leads.push(parsed.data);
        }
      }

      return { leads, fields: parseFields(body.fields) };
    },

    async deleteLead(id) {
      await send(`/leads/admin/leads/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    async exportCsv(filter = {}) {
      const query = new URLSearchParams();
      if (filter.eventId !== undefined) query.set("eventId", filter.eventId);
      if (filter.from !== undefined) query.set("from", filter.from);
      const suffix = query.size > 0 ? `?${query.toString()}` : "";

      // Tanpa `accept: application/json` — endpoint ini balas CSV, dan header
      // JSON bisa memicu API membalas error JSON alih-alih berkasnya.
      const res = await doFetch(`${baseUrl}${API_PREFIX}/leads/admin/export.csv${suffix}`, {
        headers: { ...auth, accept: "text/csv" },
      });
      if (!res.ok) throw new LeadsHttpError(res.status, await describeFailure(res));

      return {
        filename: filenameFromDisposition(res.headers.get("content-disposition"), "leads.csv"),
        csv: await res.text(),
      };
    },

    async analytics(range = {}) {
      const query = new URLSearchParams();
      if (range.from !== undefined) query.set("from", range.from);
      if (range.to !== undefined) query.set("to", range.to);
      const suffix = query.size > 0 ? `?${query.toString()}` : "";

      const res = await send(`/analytics/overview${suffix}`);
      const parsed = AnalyticsOverviewSchema.safeParse(await res.json());
      // `null`, bukan lemparan: dasbor angka yang tidak dikenali lebih baik
      // tampil kosong daripada mematikan seluruh tab leads.
      return parsed.success ? parsed.data : null;
    },
  };
}
