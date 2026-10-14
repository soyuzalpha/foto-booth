/**
 * Konteks server: satu objek yang memuat semua ketergantungan luar.
 *
 * Route tidak pernah membaca `process.env` atau membuat koneksi sendiri. Semua
 * yang tidak-deterministik (`now`, `fetch`, pengiriman email, rahasia JWT)
 * datang dari sini, jadi tes bisa menyuntik versi palsu tanpa memalsukan modul.
 *
 * Ini juga yang membuat rahasia punya **satu** tempat asal. `JWT_SECRET` yang
 * di-generate ulang tiap start akan membuat semua sesi operator mati setiap
 * deploy — jadi kalau env-nya kosong, kita berhenti dengan pesan jelas alih-alih
 * diam-diam memakai nilai default.
 */

import { join } from "node:path";

import type { S3Config } from "./objectStore.ts";
import { s3ConfigFromEnv } from "./objectStore.ts";
import { DB_FILENAME, openDatabase, type Db } from "./db.ts";
import { STORAGE_DIR } from "./paths.ts";

/** Cara kode OTP sampai ke operator. */
export interface Mailer {
  send(email: string, code: string, expiresAt: Date): Promise<void>;
}

/**
 * Mailer default: tulis ke log server.
 *
 * Server ini milik satu orang dan dijalankan di rumah. Selama belum ada SMTP
 * yang dikonfigurasi, mencetak kode ke log lebih jujur daripada berpura-pura
 * mengirim email lalu gagal tanpa jejak.
 */
export const logMailer: Mailer = {
  send(email, code, expiresAt) {
    // Sengaja ke stdout, bukan `console.error`: ini bukan error.
    console.log(`[otp] ${email} → ${code} (berlaku sampai ${expiresAt.toISOString()})`);
    return Promise.resolve();
  },
};

/**
 * Kanal pengiriman pesan booking (Fase 11).
 *
 * `live` sengaja jadi bagian dari kontrak, bukan detail implementasi: route
 * yang membalas ke operator harus bisa mengatakan "email benar-benar terkirim"
 * vs "pesan disiapkan, SMTP belum ada" — dan itu tidak bisa ditebak dari nama
 * fungsi. WhatsApp tidak punya metode kirim di sini karena memang belum ada
 * Business API: yang disiapkan hanyalah tautan `wa.me` untuk ditekan operator.
 */
export interface BookingNotifier {
  email(to: string, subject: string, body: string): Promise<void>;
  /** `true` hanya kalau pesan benar-benar keluar dari server. */
  readonly live: boolean;
}

/**
 * Notifier default: tulis ke log.
 *
 * Sama alasannya dengan `logMailer` — selama SMTP belum dikonfigurasi, mencatat
 * pesan yang *akan* dikirim lebih jujur daripada mengaku sudah mengirim.
 */
export const logNotifier: BookingNotifier = {
  live: false,
  email(to, subject, body) {
    console.log(`[booking-mail] → ${to} · ${subject}\n${body}`);
    return Promise.resolve();
  },
};

export interface ServerContext {
  db: Db;
  s3: S3Config;
  jwtSecret: string;
  now: () => Date;
  fetch: typeof globalThis.fetch;
  mailer: Mailer;
  /**
   * Kanal kirim pesan booking (konfirmasi & pengingat, Fase 11).
   *
   * Terpisah dari `mailer` karena keduanya punya bentuk yang berbeda: `mailer`
   * mengirim *kode* ke operator yang sedang login, sedangkan ini mengirim
   * *pesan* ke tamu. Menggabungkannya berarti template OTP dan template tamu
   * hidup di satu fungsi.
   */
  notifier: BookingNotifier;
  /**
   * `true` hanya kalau `OTP_DEV_MODE=1`. Membuat balasan `otp/request` memuat
   * kodenya supaya bisa dipakai tanpa kotak masuk. Jangan pernah di produksi.
   */
  exposeOtpCode: boolean;
}

export interface ContextOptions {
  db?: Db;
  s3?: S3Config;
  jwtSecret?: string;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  mailer?: Mailer;
  notifier?: BookingNotifier;
  exposeOtpCode?: boolean;
}

const JWT_SECRET_MIN_LENGTH = 32;

/**
 * Bangun konteks dari environment.
 *
 * `JWT_SECRET` wajib dan minimal 32 karakter. Rahasia pendek bikin HS256 bisa
 * di-brute-force; lebih baik server menolak start daripada terlihat sehat.
 */
export function createContext(env: NodeJS.ProcessEnv = process.env, overrides: ContextOptions = {}): ServerContext {
  const jwtSecret = overrides.jwtSecret ?? env.JWT_SECRET ?? "";
  if (jwtSecret.length < JWT_SECRET_MIN_LENGTH) {
    throw new Error(
      `JWT_SECRET wajib diisi (minimal ${JWT_SECRET_MIN_LENGTH} karakter). ` +
        `Contoh: JWT_SECRET="$(head -c 32 /dev/urandom | base64)"`,
    );
  }

  const db = overrides.db ?? openDatabase(env.DATA_DIR ? join(env.DATA_DIR, DB_FILENAME) : ":memory:");

  return {
    db,
    s3: overrides.s3 ?? s3ConfigFromEnv(env),
    jwtSecret,
    now: overrides.now ?? (() => new Date()),
    fetch: overrides.fetch ?? globalThis.fetch,
    mailer: overrides.mailer ?? logMailer,
    notifier: overrides.notifier ?? logNotifier,
    exposeOtpCode: overrides.exposeOtpCode ?? env.OTP_DEV_MODE === "1",
  };
}

/** Direktori database default kalau `DATA_DIR` tidak diisi. */
export const DEFAULT_DATA_DIR = join(STORAGE_DIR, "data");
