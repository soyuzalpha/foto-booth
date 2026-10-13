/**
 * Sesi operator di studio: token OTP → JWT, disimpan di perangkat.
 *
 * Kenapa di `localStorage` dan bukan IndexedDB: token ini dibaca **sebelum**
 * apa pun berjalan — apakah antrian upload boleh jalan, apakah panel galeri
 * boleh memuat. IndexedDB asinkron, dan menunggu buka database cuma untuk tahu
 * "sudah login atau belum" bikin UI berkedip di render pertama.
 *
 * Yang dijaga:
 *
 *   · **Token kedaluwarsa dibuang saat dibaca**, bukan saat dipakai. Token
 *     basi yang tetap tersimpan bikin UI tampak login padahal setiap request
 *     akan 401 — operator lalu mengira API-nya yang rusak.
 *   · **Isi localStorage tidak dipercaya.** Bentuknya divalidasi ulang; berkas
 *     yang rusak atau ditulis versi lama menghasilkan `null`, bukan lemparan.
 *   · **localStorage yang gagal tidak mematikan aplikasi.** Mode privat dan
 *     kuota penuh bikin `setItem` melempar; aplikasi tetap jalan sebagai tamu.
 *
 * Klien HTTP-nya dipisah dari penyimpanan: yang satu soal "token ini masih
 * sah?", yang lain soal "tukar kode dengan token". Keduanya diuji sendiri.
 */

import { API_PREFIX, type Session } from "@foto-booth/shared";

/** Bagian `localStorage` yang kita pakai — dibuat sendiri supaya bisa dipalsukan. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface OperatorSession {
  token: string;
  email: string;
  expiresAt: string;
}

export const SESSION_STORAGE_KEY = "foto-booth:session";

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Akses localStorage bisa melempar di sandbox / cookie diblokir.
    return null;
  }
}

/** Validasi bentuk sesi. `null` = tidak bisa dipakai, bukan "sesi kosong". */
export function parseSession(raw: unknown): OperatorSession | null {
  if (typeof raw !== "object" || raw === null) return null;

  const { token, email, expiresAt } = raw as Record<string, unknown>;
  if (typeof token !== "string" || token === "") return null;
  if (typeof email !== "string" || email === "") return null;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;

  return { token, email, expiresAt };
}

/**
 * Batas kedaluwarsa memakai `<=`: token yang berakhir **tepat sekarang** sudah
 * tidak bisa dipakai, jadi memperlakukannya sebagai sah cuma menunda 401.
 */
export function isSessionExpired(session: OperatorSession, now: Date): boolean {
  return Date.parse(session.expiresAt) <= now.getTime();
}

/**
 * Baca sesi tersimpan. Sesi kedaluwarsa **dihapus dari penyimpanan** saat
 * ditemukan, jadi panggilan berikutnya tidak memeriksanya lagi.
 */
export function loadSession(now: Date = new Date(), storage: StorageLike | null = defaultStorage()): OperatorSession | null {
  if (storage === null) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const session = parseSession(parsed);
  if (session === null) return null;

  if (isSessionExpired(session, now)) {
    clearSession(storage);
    return null;
  }
  return session;
}

/** `false` = tidak bisa disimpan (localStorage diblokir/penuh). Pemanggil yang memutuskan. */
export function saveSession(session: OperatorSession, storage: StorageLike | null = defaultStorage()): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function clearSession(storage: StorageLike | null = defaultStorage()): void {
  if (storage === null) return;
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Tidak ada yang bisa dibereskan: penyimpanan memang tidak bisa diakses.
  }
}

/* ------------------------------------------------------------------ *
 * Klien OTP
 * ------------------------------------------------------------------ */

/** Balasan `POST /v1/auth/otp/request`. `code` hanya ada di mode dev. */
export interface OtpRequested {
  sent: true;
  expiresAt: string;
  code?: string;
}

export interface AuthClient {
  requestOtp(email: string): Promise<OtpRequested>;
  verifyOtp(email: string, code: string): Promise<OperatorSession>;
}

export class AuthHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthHttpError";
    this.status = status;
  }
}

export interface AuthClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

async function describeFailure(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
  } catch {
    // Balasan bukan JSON (halaman HTML dari proxy) — status saja sudah cukup.
  }
  return `HTTP ${res.status}`;
}

export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async requestOtp(email) {
      const res = await doFetch(`${baseUrl}${API_PREFIX}/auth/otp/request`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) throw new AuthHttpError(res.status, await describeFailure(res));

      const body = (await res.json()) as { sent?: unknown; expiresAt?: unknown; code?: unknown };
      if (body.sent !== true || typeof body.expiresAt !== "string") {
        throw new AuthHttpError(res.status, "balasan otp/request tidak dikenali");
      }

      const result: OtpRequested = { sent: true, expiresAt: body.expiresAt };
      // Mode dev mengembalikan kodenya supaya bisa dicoba tanpa kotak masuk.
      if (typeof body.code === "string") result.code = body.code;
      return result;
    },

    async verifyOtp(email, code) {
      const res = await doFetch(`${baseUrl}${API_PREFIX}/auth/otp/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email, code }),
      });

      if (!res.ok) throw new AuthHttpError(res.status, await describeFailure(res));

      const session = parseSession(await res.json());
      if (session === null) {
        throw new AuthHttpError(res.status, "balasan otp/verify tidak memuat token yang sah");
      }
      return session;
    },
  };
}

/** Bentuk respons API (`Session`) → bentuk penyimpanan studio. */
export function sessionFromApi(value: Session): OperatorSession {
  return { token: value.token, email: value.email, expiresAt: value.expiresAt };
}
