/**
 * Klien HTTP untuk satu siklus upload foto.
 *
 * Fase 5 punya aturan yang menentukan bentuk modul ini: **foto tidak pernah
 * lewat API**. API hanya menandatangani URL; byte-nya pergi langsung dari
 * browser ke bucket. Jadi ada dua jenis request yang sengaja dipisah:
 *
 *   · ke API   — butuh token sesi operator (`authorization: Bearer …`);
 *   · ke bucket — **tanpa** header auth sama sekali. Otorisasinya ada di query
 *     string yang sudah ditandatangani. Menambahkan `Authorization` di sini
 *     justru bikin bucket menolak (dua skema auth sekaligus = tanda tangan
 *     tidak cocok).
 *
 * `fetch` injectable supaya runner bisa diuji tanpa jaringan.
 */

import {
  API_PREFIX,
  RegisterPhotoSchema,
  UploadUrlResponseSchema,
  type RegisteredPhoto,
  type RegisterPhoto,
  type UploadUrlRequest,
  type UploadUrlResponse,
} from "@foto-booth/shared";

export interface UploadClient {
  /** Minta dua URL presigned (berkas asli + thumbnail) untuk satu foto. */
  signUpload(galleryId: string, request: UploadUrlRequest): Promise<UploadUrlResponse>;
  /** PUT byte ke URL presigned. Tidak pakai token. */
  putBytes(url: string, blob: Blob, contentType: string): Promise<void>;
  /** Lapor ke API bahwa kedua PUT sudah selesai. */
  registerPhoto(galleryId: string, body: RegisterPhoto): Promise<RegisteredPhoto>;
}

export class UploadHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadHttpError";
    this.status = status;
  }
}

export interface UploadClientOptions {
  /** Token sesi operator. */
  token: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/** Pesan error dari API kalau ada; kalau tidak, status HTTP-nya saja. */
async function describeFailure(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
  } catch {
    // Balasan bukan JSON (mis. halaman HTML dari proxy) — pakai status saja.
  }
  return `HTTP ${res.status}`;
}

export function createHttpUploadClient(options: UploadClientOptions): UploadClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? globalThis.fetch;
  const auth = { authorization: `Bearer ${options.token}` };

  return {
    async signUpload(galleryId, request) {
      const res = await doFetch(`${baseUrl}${API_PREFIX}/galleries/${galleryId}/upload-url`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(request),
      });

      if (!res.ok) throw new UploadHttpError(res.status, await describeFailure(res));

      const parsed = UploadUrlResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new UploadHttpError(res.status, "balasan upload-url tidak dikenali");
      }
      return parsed.data;
    },

    async putBytes(url, blob, contentType) {
      // Sengaja tanpa header auth: tanda tangannya sudah ada di URL.
      const res = await doFetch(url, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: blob,
      });

      if (!res.ok) throw new UploadHttpError(res.status, await describeFailure(res));
    },

    async registerPhoto(galleryId, body) {
      const res = await doFetch(`${baseUrl}${API_PREFIX}/galleries/${galleryId}/photos`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(RegisterPhotoSchema.parse(body)),
      });

      if (!res.ok) throw new UploadHttpError(res.status, await describeFailure(res));
      return (await res.json()) as RegisteredPhoto;
    },
  };
}
