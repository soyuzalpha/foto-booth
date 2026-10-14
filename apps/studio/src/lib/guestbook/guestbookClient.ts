/**
 * Klien HTTP video guestbook (Fase 9, FEATURE-MATRIX #19).
 *
 * Dua permukaan dengan aturan berbeda:
 *
 *   · **Tamu (tanpa token)** — minta URL upload, kirim metadata setelah naik,
 *     baca dinding pesan yang tampil, dan memuat berkasnya. Kiosk memakai ini.
 *   · **Operator (token)** — daftar lengkap termasuk yang disembunyikan,
 *     sembunyikan/tampilkan, dan hapus.
 *
 * Yang dijaga di sini:
 *
 *   · **Balasan divalidasi per-item.** Satu entri rusak di tengah dinding tidak
 *     boleh mengosongkan seluruh tampilan — sisanya tetap tampil.
 *   · **Berkas diproksi lewat URL API**, bukan URL bucket: bucket tetap privat,
 *     dan entri yang disembunyikan operator tidak bisa dibuka lewat id.
 *   · **Token hanya dikirim ke rute operator.** Endpoint tamu sengaja publik.
 */

import {
  API_PREFIX,
  GuestbookEntrySchema,
  type GuestbookEntry,
  type GuestbookEntryKind,
  type UploadUrlResponse,
} from "@foto-booth/shared";

export interface GuestbookWall {
  entries: GuestbookEntry[];
  total: number;
}

export interface GuestbookAdminList extends GuestbookWall {
  totalDurationSeconds: number;
}

/** Yang dibutuhkan untuk meminta URL upload — tanpa `key`, itu dibuat server. */
export interface GuestbookUploadRequest {
  galleryHash?: string;
  eventId?: string;
  kind: GuestbookEntryKind;
  contentType: string;
  durationSeconds: number;
  bytes: number;
  /**
   * Persetujuan UU PDP. **Wajib `true`** dan sengaja bukan opsional: server
   * menolak kiriman tanpa ini, jadi menjadikannya opsional hanya memindahkan
   * kegagalan dari waktu kompilasi ke waktu unggah — tepat saat tamu sudah
   * merekam dan menunggu.
   */
  consent: boolean;
}

export interface GuestbookRecordRequest extends GuestbookUploadRequest {
  key: string;
  label?: string;
}

export interface GuestbookClient {
  /** Tamu: URL upload bertanda tangan untuk satu pesan baru. */
  requestUploadUrl(body: GuestbookUploadRequest): Promise<UploadUrlResponse>;
  /** Tamu: daftarkan metadata setelah berkas naik. */
  record(body: GuestbookRecordRequest): Promise<GuestbookEntry>;
  /** Tamu: dinding pesan yang tampil. */
  wall(query: { galleryHash?: string; eventId?: string; limit?: number }): Promise<GuestbookWall>;
  /** URL byte satu entri (diproksi API). */
  mediaUrl(id: string): string;
  /** Operator: daftar lengkap satu acara. */
  adminList(eventId: string, options?: { includeHidden?: boolean }): Promise<GuestbookAdminList>;
  /** Operator: sembunyikan/tampilkan. */
  setVisible(id: string, visible: boolean): Promise<GuestbookEntry>;
  /** Operator: hapus permanen (objek + baris). */
  remove(id: string): Promise<void>;
}

export class GuestbookHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GuestbookHttpError";
    this.status = status;
  }
}

export interface GuestbookClientOptions {
  token?: string;
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

/** Daftar mentah → hanya entri yang bentuknya benar. */
export function parseEntries(raw: unknown): GuestbookEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: GuestbookEntry[] = [];
  for (const item of raw) {
    const parsed = GuestbookEntrySchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

export function createGuestbookClient(options: GuestbookClientOptions = {}): GuestbookClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? globalThis.fetch;

  async function send(path: string, init: RequestInit = {}, withAuth = false): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    if (withAuth && options.token !== undefined && options.token !== "") {
      headers.authorization = `Bearer ${options.token}`;
    }

    const res = await doFetch(`${baseUrl}${API_PREFIX}${path}`, { ...init, headers });
    if (!res.ok) throw new GuestbookHttpError(res.status, await describeFailure(res));
    return res;
  }

  function requireToken(): void {
    if (options.token === undefined || options.token === "") {
      throw new GuestbookHttpError(401, "butuh masuk sebagai operator");
    }
  }

  function jsonInit(body: unknown): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  return {
    async requestUploadUrl(body) {
      const res = await send("/guestbook/upload-url", jsonInit(body));
      return (await res.json()) as UploadUrlResponse;
    },

    async record(body) {
      const res = await send("/guestbook", jsonInit(body));
      const parsed = GuestbookEntrySchema.safeParse((await res.json() as { entry?: unknown }).entry);
      if (!parsed.success) throw new GuestbookHttpError(res.status, "balasan entri tidak dikenali");
      return parsed.data;
    },

    async wall(query) {
      const params = new URLSearchParams();
      if (query.galleryHash !== undefined) params.set("galleryHash", query.galleryHash);
      if (query.eventId !== undefined) params.set("eventId", query.eventId);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";

      const res = await send(`/guestbook${suffix}`);
      const body = (await res.json()) as { entries?: unknown; total?: unknown };
      return {
        entries: parseEntries(body.entries),
        total: typeof body.total === "number" ? body.total : 0,
      };
    },

    mediaUrl(id) {
      return `${baseUrl}${API_PREFIX}/guestbook/${encodeURIComponent(id)}/media`;
    },

    async adminList(eventId, opts = {}) {
      requireToken();
      const params = new URLSearchParams({ eventId });
      if (opts.includeHidden === true) params.set("includeHidden", "1");

      const res = await send(`/guestbook/admin?${params.toString()}`, {}, true);
      const body = (await res.json()) as {
        entries?: unknown;
        total?: unknown;
        totalDurationSeconds?: unknown;
      };
      return {
        entries: parseEntries(body.entries),
        total: typeof body.total === "number" ? body.total : 0,
        totalDurationSeconds:
          typeof body.totalDurationSeconds === "number" ? body.totalDurationSeconds : 0,
      };
    },

    async setVisible(id, visible) {
      requireToken();
      const res = await send(
        `/guestbook/admin/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visible }),
        },
        true,
      );
      const parsed = GuestbookEntrySchema.safeParse((await res.json() as { entry?: unknown }).entry);
      if (!parsed.success) throw new GuestbookHttpError(res.status, "balasan entri tidak dikenali");
      return parsed.data;
    },

    async remove(id) {
      requireToken();
      await send(`/guestbook/admin/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
    },
  };
}
