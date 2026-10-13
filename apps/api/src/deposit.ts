/**
 * Deposit — **interface + stub**, belum tersambung ke gateway mana pun.
 *
 * Fase 11 membangun alur booking sampai titik "deposit diminta". Yang belum ada
 * adalah uangnya: QRIS/Midtrans/Xendit masuk di Fase 10. Supaya penundaan itu
 * tidak jadi utang teknis, pembayaran di sini dibentuk sebagai satu antarmuka
 * (`DepositProvider`) dengan tiga implementasi:
 *
 *   · `none`   — belum ada pembayaran sama sekali (kondisi jujur hari ini);
 *   · `manual` — operator menandai sendiri bahwa deposit sudah masuk;
 *   · `qris`   — **stub** untuk Fase 10; sengaja melempar, bukan diam-diam
 *                mengembalikan "pending" palsu.
 *
 * Aturan yang dipegang: provider yang tidak hidup **melempar**, tidak pernah
 * mengembalikan status sukses. Booking yang dikira sudah deposit padahal tidak
 * jauh lebih mahal daripada error yang terlihat.
 */

import type { PaymentProvider } from "@foto-booth/shared";

/** Status deposit yang bisa dihasilkan provider. */
export type DepositOutcome = "pending" | "paid" | "refunded" | "failed";

export interface DepositIntent {
  bookingId: string;
  /** Token publik booking — dipakai provider sebagai idempotency key. */
  token: string;
  amountIdr: number;
  /** Nama pemesan, buat ditampilkan di halaman pembayaran nanti. */
  customerName: string;
  /** ISO — batas waktu pembayaran sebelum slot dilepas. */
  expiresAt: string;
}

export interface DepositResult {
  outcome: DepositOutcome;
  /** Id transaksi di sisi provider; `null` kalau belum ada. */
  reference: string | null;
  /** URL halaman pembayaran, kalau provider memakai redirect. */
  redirectUrl: string | null;
  /**
   * Teks siap tampil untuk tamu: nomor QRIS, instruksi transfer, dsb.
   * `null` = tidak ada instruksi tambahan.
   */
  instructions: string | null;
}

export interface DepositCallback {
  bookingId: string;
  outcome: DepositOutcome;
  reference: string | null;
}

export interface DepositProvider {
  readonly name: PaymentProvider;
  /**
   * `false` = provider ini tidak bisa memproses apa pun. Route memakai ini
   * untuk memutuskan apakah booking langsung berstatus "menunggu konfirmasi
   * operator" atau "menunggu pembayaran".
   */
  readonly live: boolean;
  createIntent(intent: DepositIntent): Promise<DepositResult>;
  /** Verifikasi webhook. `null` = payload tidak sah dan harus diabaikan. */
  verifyCallback?(
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<DepositCallback | null>;
}

/** Dilempar kalau provider dipanggil padahal belum ada pembayaran yang bisa jalan. */
export class DepositUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepositUnavailableError";
  }
}

/**
 * Tidak ada pembayaran. Ini default Fase 11.
 *
 * Booking tetap bisa dibuat; depositnya cuma tidak ditagih lewat sistem. Yang
 * penting: `live = false`, jadi tidak ada kode lain yang boleh menganggap
 * `createIntent` akan berhasil.
 */
export const noneDepositProvider: DepositProvider = {
  name: "none",
  live: false,
  createIntent(intent) {
    return Promise.reject(
      new DepositUnavailableError(
        `Pembayaran belum tersambung (booking ${intent.bookingId}). ` +
          `Operator akan menghubungi lewat WhatsApp/email.`,
      ),
    );
  },
};

/**
 * Operator menandai deposit sendiri.
 *
 * Tidak ada gateway, tapi `live = true` karena memang ada orang yang memproses.
 * Instruksi yang dikembalikan sengaja berupa arahan manual — bukan QR palsu.
 */
export const manualDepositProvider: DepositProvider = {
  name: "manual",
  live: true,
  createIntent(intent) {
    return Promise.resolve({
      outcome: "pending",
      reference: null,
      redirectUrl: null,
      instructions:
        `Deposit ${formatIdr(intent.amountIdr)} dikonfirmasi manual oleh operator. ` +
        `Instruksi pembayaran (transfer/QRIS statis) dikirim lewat WhatsApp ke nomor yang kamu isi.`,
    });
  },
};

/**
 * Stub QRIS untuk Fase 10.
 *
 * Sengaja melempar dengan pesan yang menyebut fasenya. Alternatifnya —
 * mengembalikan `outcome: "pending"` tanpa transaksi nyata — akan membuat
 * booking terlihat menunggu pembayaran yang tidak pernah bisa dibayar.
 */
export const qrisDepositProvider: DepositProvider = {
  name: "qris",
  live: false,
  createIntent() {
    return Promise.reject(
      new DepositUnavailableError(
        "Provider QRIS belum diimplementasikan (menunggu Fase 10 — payment gateway). " +
          "Setel paymentProvider ke \"manual\" atau \"none\" di setelan booking.",
      ),
    );
  },
};

const PROVIDERS: Record<PaymentProvider, DepositProvider> = {
  none: noneDepositProvider,
  manual: manualDepositProvider,
  qris: qrisDepositProvider,
};

export function resolveDepositProvider(name: PaymentProvider): DepositProvider {
  return PROVIDERS[name];
}

/**
 * Format rupiah tanpa Intl.
 *
 * `Intl.NumberFormat("id-ID")` bergantung pada data locale yang tersedia di
 * build Node; di image minimal bisa jadi menghasilkan format berbeda. Karena
 * angka ini masuk ke instruksi pembayaran yang dibaca manusia, hasilnya harus
 * sama di mana pun.
 */
export function formatIdr(amount: number): string {
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? "-" : "";
  const digits = String(Math.abs(rounded));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
    out += digits[i];
  }
  return `${sign}Rp${out}`;
}
