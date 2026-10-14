/**
 * Bantu untuk tes: konteks + app dengan ketergantungan luar yang dipalsukan.
 *
 * Ada di `src/` (bukan `test/`) supaya impornya pendek dari tes yang duduk
 * bersebelahan dengan kode yang diuji, dan supaya setiap tes memakai konteks
 * yang sama bentuknya. Nama berkasnya sengaja bukan `*.test.ts` — `node --test`
 * akan menjalankannya sebagai berkas tes dan gagal karena tidak ada tes di sini.
 *
 * Yang dipalsukan:
 *   · `s3`     → alamat karangan; tidak ada tes yang benar-benar menyentuh bucket.
 *   · `fetch`  → ditolak secara default. Tes yang butuh jaringan harus menyuntik
 *                versi palsunya sendiri, jadi "lupa memalsukan" muncul sebagai
 *                kegagalan yang jelas, bukan panggilan jaringan diam-diam.
 *   · `now`    → waktu tetap supaya tanda tangan & kedaluwarsa bisa di-assert.
 *   · `mailer` → menangkap kode OTP supaya alur masuk bisa diuji ujung ke ujung.
 */

import { buildApp } from "./app.ts";
import { createContext, type BookingNotifier, type ContextOptions, type Mailer, type ServerContext } from "./context.ts";
import type { S3Config } from "./objectStore.ts";

/** Waktu tetap: Senin, 12 Oktober 2026 00:00:00 UTC. */
export const FIXED_NOW = new Date("2026-10-12T00:00:00.000Z");

export const FAKE_S3: S3Config = {
  endpoint: "http://127.0.0.1:3900",
  region: "garage",
  bucket: "foto-booth",
  accessKeyId: "GKtestaccesskeyid0000000000000000",
  secretAccessKey: "test-secret-access-key-0000000000000000000000000000",
};

/** Mailer yang menyimpan kode terakhir, bukan mengirim apa pun. */
export class CapturingMailer implements Mailer {
  readonly sent: { email: string; code: string; expiresAt: Date }[] = [];

  send(email: string, code: string, expiresAt: Date): Promise<void> {
    this.sent.push({ email, code, expiresAt });
    return Promise.resolve();
  }

  /** Kode terakhir untuk email ini; `null` kalau tidak ada. */
  lastCode(email: string): string | null {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const entry = this.sent[i];
      if (entry !== undefined && entry.email === email) return entry.code;
    }
    return null;
  }
}

/**
 * Notifier yang menyimpan pesan terakhir, bukan mengirim apa pun.
 *
 * `live` sengaja bisa diatur per-tes: perilaku yang paling penting untuk diuji
 * adalah **apa yang terjadi saat notifier belum hidup** — booking tidak boleh
 * ditandai sudah diingatkan kalau pesannya tidak keluar.
 */
export class CapturingNotifier implements BookingNotifier {
  readonly sent: { to: string; subject: string; body: string }[] = [];
  live = false;

  email(to: string, subject: string, body: string): Promise<void> {
    this.sent.push({ to, subject, body });
    return Promise.resolve();
  }

  /** Pesan terakhir untuk alamat ini; `null` kalau tidak ada. */
  lastTo(to: string): { to: string; subject: string; body: string } | null {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const entry = this.sent[i];
      if (entry !== undefined && entry.to === to) return entry;
    }
    return null;
  }
}

export interface TestHarness {
  ctx: ServerContext;
  mailer: CapturingMailer;
  notifier: CapturingNotifier;
  app: Awaited<ReturnType<typeof buildApp>>;
  /** Waktu yang dipegang konteks; bisa dimajukan lewat `advance()`. */
  setNow(date: Date): void;
  close(): Promise<void>;
}

/**
 * Bangun konteks + app untuk tes.
 *
 * Job TTL dimatikan: ia berjalan saat start dan akan memanggil bucket palsu,
 * sehingga tes yang tidak peduli TTL bisa gagal karena alasan yang salah.
 */
export async function makeHarness(overrides: ContextOptions = {}): Promise<TestHarness> {
  let current = overrides.now?.() ?? FIXED_NOW;

  const mailer = new CapturingMailer();
  const notifier = new CapturingNotifier();
  const ctx = createContext(
    {},
    {
      jwtSecret: "test-jwt-secret-0123456789abcdef0123456789abcdef",
      s3: FAKE_S3,
      now: () => current,
      fetch: () => Promise.reject(new Error("tes ini tidak boleh menyentuh jaringan")),
      mailer,
      notifier,
      exposeOtpCode: false,
      ...overrides,
    },
  );

  const app = await buildApp(ctx, { logger: false, ttlJob: false, reminderJob: false });

  return {
    ctx,
    mailer,
    notifier,
    app,
    setNow(date) {
      current = date;
    },
    async close() {
      await app.close();
    },
  };
}
