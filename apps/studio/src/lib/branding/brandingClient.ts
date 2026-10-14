/**
 * Klien HTTP branding / white-label (Fase 9, FEATURE-MATRIX #61).
 *
 * Dua sisi dengan aturan berbeda:
 *
 *   · **`GET /v1/branding` publik** — halaman galeri tamu memang menampilkan
 *     judul yang dipasang, jadi tidak ada yang perlu disembunyikan.
 *   · **`PUT /v1/branding/admin` operator** — butuh token sesi.
 *
 * Yang dijaga di sini, dan kenapa:
 *
 *   · **Balasan dinormalkan ulang, bukan dipercaya.** Nilai dari API bisa
 *     berasal dari versi lama atau baris yang ditulis tangan; `normalizeBranding`
 *     memotong & membersihkan, jadi panel tidak pernah menampilkan nilai yang
 *     akan ditolak server saat disimpan kembali.
 *   · **`isDefault` dibaca dengan cadangan.** Kalau API tidak mengirimnya,
 *     nilainya dihitung dari branding itu sendiri — bukan ditebak `false`.
 *   · **Simpan butuh token.** Tanpa token, request-nya pasti 401; lebih jujur
 *     menolak di klien dengan pesan jelas daripada mengirim lalu gagal.
 */

import {
  API_PREFIX,
  brandingIsDefault,
  normalizeBranding,
  type Branding,
  type UpdateBranding,
} from "@foto-booth/shared";

export interface BrandingState {
  branding: Branding;
  isDefault: boolean;
}

export interface BrandingClient {
  /** Branding tersimpan (atau default) — endpoint publik. */
  get(): Promise<BrandingState>;
  /** Simpan sebagian bidang; bidang yang tidak dikirim dibiarkan. */
  save(patch: UpdateBranding): Promise<BrandingState>;
}

export class BrandingHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BrandingHttpError";
    this.status = status;
  }
}

export interface BrandingClientOptions {
  /** Token sesi operator. Wajib hanya untuk `save`. */
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

/** Bentuk balasan apa pun → `BrandingState` yang aman dipakai UI. */
export function parseBrandingState(raw: unknown): BrandingState {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const branding = normalizeBranding(record.branding);

  // `isDefault` dari API menang kalau memang boolean; kalau tidak, dihitung.
  const isDefault = typeof record.isDefault === "boolean" ? record.isDefault : brandingIsDefault(branding);
  return { branding, isDefault };
}

export function createBrandingClient(options: BrandingClientOptions = {}): BrandingClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? globalThis.fetch;

  async function send(path: string, init: RequestInit = {}, withAuth = false): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    // Token hanya dikirim ke rute operator: endpoint publik sengaja tetap
    // publik, dan mengirim sesi ke sana cuma menambah permukaan kebocoran.
    if (withAuth && options.token !== undefined && options.token !== "") {
      headers.authorization = `Bearer ${options.token}`;
    }

    const res = await doFetch(`${baseUrl}${API_PREFIX}${path}`, { ...init, headers });
    if (!res.ok) throw new BrandingHttpError(res.status, await describeFailure(res));
    return res;
  }

  return {
    async get() {
      const res = await send("/branding");
      return parseBrandingState(await res.json());
    },

    async save(patch) {
      if (options.token === undefined || options.token === "") {
        throw new BrandingHttpError(401, "butuh masuk sebagai operator");
      }
      const res = await send(
        "/branding/admin",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
        true,
      );
      return parseBrandingState(await res.json());
    },
  };
}
