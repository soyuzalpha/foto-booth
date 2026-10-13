/**
 * Klien HTTP panel galeri: acara, galeri, dan profil operator.
 *
 * Ini sisi **operator** — semua request di sini butuh token sesi. Sisi tamu
 * (halaman `/a/:hash`) tidak lewat modul ini: halaman itu HTML dari API, dan
 * studio tidak pernah merendernya.
 *
 * Aturan yang menentukan bentuknya:
 *
 *   · **Satu galeri aktif pada satu waktu.** Kiosk melayani satu acara, jadi
 *     UI-nya memilih satu galeri, bukan menampilkan semuanya setara.
 *   · **Balasan divalidasi per-item, bukan dipercaya.** Satu galeri rusak di
 *     tengah daftar dibuang; sisanya tetap tampil. Melempar di situ bikin
 *     seluruh panel kosong gara-gara satu baris buruk.
 *   · **`photoCount` dan `url` tidak ada di `GallerySchema`.** API menambah
 *     keduanya di route; keduanya dibaca dengan nilai cadangan supaya UI tidak
 *     menampilkan `undefined`.
 */

import {
  API_PREFIX,
  EventSchema,
  GallerySchema,
  PhotoSchema,
  type CreateEvent,
  type CreateGallery,
  type Entitlement,
  type Event,
  type Gallery,
  type Photo,
} from "@foto-booth/shared";

/** Galeri seperti yang dikembalikan `GET /v1/galleries`. */
export interface GallerySummary extends Gallery {
  photoCount: number;
  url: string;
}

/** Galeri + acara + foto, seperti `GET /v1/galleries/:id`. */
export interface GalleryDetail extends GallerySummary {
  event: Event | null;
  photos: Photo[];
}

export interface OperatorProfile {
  email: string;
  galleries: number;
  entitlement: Entitlement | null;
}

export interface DeleteReport {
  deleted: boolean;
  removedObjects: number;
  removedPhotos: number;
}

export interface GalleryClient {
  listEvents(): Promise<Event[]>;
  createEvent(body: CreateEvent): Promise<Event>;
  listGalleries(): Promise<GallerySummary[]>;
  getGallery(id: string): Promise<GalleryDetail>;
  createGallery(body: CreateGallery): Promise<GallerySummary>;
  deleteGallery(id: string): Promise<DeleteReport>;
  profile(): Promise<OperatorProfile>;
}

export class GalleryHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GalleryHttpError";
    this.status = status;
  }
}

export interface GalleryClientOptions {
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

/** `photoCount` yang tidak masuk akal jadi `0`, bukan `NaN` di layar. */
function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readUrl(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Galeri mentah → `GallerySummary`; `null` kalau bentuknya tidak dikenali. */
export function parseGallerySummary(raw: unknown): GallerySummary | null {
  const parsed = GallerySchema.safeParse(raw);
  if (!parsed.success) return null;

  const source = raw as Record<string, unknown>;
  return { ...parsed.data, photoCount: readCount(source.photoCount), url: readUrl(source.url) };
}

export function createGalleryClient(options: GalleryClientOptions): GalleryClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? globalThis.fetch;
  const auth = { authorization: `Bearer ${options.token}` };

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await doFetch(`${baseUrl}${API_PREFIX}${path}`, {
      ...init,
      headers: { ...auth, accept: "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new GalleryHttpError(res.status, await describeFailure(res));
    return res;
  }

  return {
    async listEvents() {
      const res = await send("/events");
      const body = (await res.json()) as { events?: unknown };
      if (!Array.isArray(body.events)) return [];

      const events: Event[] = [];
      for (const raw of body.events) {
        const parsed = EventSchema.safeParse(raw);
        if (parsed.success) events.push(parsed.data);
      }
      return events;
    },

    async createEvent(body) {
      const res = await send("/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      const parsed = EventSchema.safeParse(await res.json());
      if (!parsed.success) throw new GalleryHttpError(res.status, "balasan create event tidak dikenali");
      return parsed.data;
    },

    async listGalleries() {
      const res = await send("/galleries");
      const body = (await res.json()) as { galleries?: unknown };
      if (!Array.isArray(body.galleries)) return [];

      const galleries: GallerySummary[] = [];
      for (const raw of body.galleries) {
        const parsed = parseGallerySummary(raw);
        if (parsed !== null) galleries.push(parsed);
      }
      return galleries;
    },

    async getGallery(id) {
      const res = await send(`/galleries/${encodeURIComponent(id)}`);
      const raw = (await res.json()) as Record<string, unknown>;

      const summary = parseGallerySummary(raw);
      if (summary === null) throw new GalleryHttpError(res.status, "balasan galeri tidak dikenali");

      const event = EventSchema.safeParse(raw.event);
      const photos: Photo[] = [];
      if (Array.isArray(raw.photos)) {
        for (const item of raw.photos) {
          const parsed = PhotoSchema.safeParse(item);
          if (parsed.success) photos.push(parsed.data);
        }
      }

      return { ...summary, event: event.success ? event.data : null, photos };
    },

    async createGallery(body) {
      const res = await send("/galleries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      const parsed = parseGallerySummary(await res.json());
      if (parsed === null) throw new GalleryHttpError(res.status, "balasan create gallery tidak dikenali");
      return parsed;
    },

    async deleteGallery(id) {
      const res = await send(`/galleries/${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = (await res.json()) as Record<string, unknown>;

      return {
        deleted: body.deleted === true,
        removedObjects: readCount(body.removedObjects),
        removedPhotos: readCount(body.removedPhotos),
      };
    },

    async profile() {
      const res = await send("/me");
      const body = (await res.json()) as Record<string, unknown>;

      return {
        email: typeof body.email === "string" ? body.email : "",
        galleries: readCount(body.galleries),
        entitlement: (body.entitlement ?? null) as Entitlement | null,
      };
    },
  };
}
