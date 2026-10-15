/**
 * Kanal kirim email booking (Fase 11) — SMTP sungguhan, tanpa dependensi.
 *
 * Sampai sekarang `BookingNotifier` default hanya menulis ke log, jadi
 * konfirmasi dan pengingat H-1 tidak pernah benar-benar sampai ke tamu. Modul
 * ini menutup lubang itu: satu implementasi `BookingNotifier` yang bicara SMTP
 * langsung lewat `node:net` / `node:tls`.
 *
 * Kenapa tidak memakai `nodemailer`: yang dibutuhkan cuma subset kecil dan
 * tetap (EHLO → AUTH LOGIN → MAIL/RCPT/DATA), sementara paketnya membawa
 * resolver transport, plugin, dan opsi yang tidak dipakai. Kode di sini ±200
 * baris, seluruhnya terbaca, dan bisa diuji terhadap server SMTP palsu lokal
 * tanpa jaringan luar.
 *
 * Dua aturan yang dipegang:
 *
 *   · **Gagal = melempar.** Kalau server menolak (535, 550) atau sambungan
 *     putus, pemanggil harus tahu. `live = true` pada notifier ini berarti
 *     "kanal ini bisa dipakai", bukan "semua kiriman pasti berhasil" — rute
 *     yang memanggilnya yang menangani kegagalan per pesan.
 *   · **Jangan kirim kredensial lewat koneksi polos.** Kalau port bukan TLS
 *     implisit, STARTTLS wajib dan harus diiklankan server; kalau tidak, kita
 *     berhenti sebelum AUTH. Opt-out-nya eksplisit (`SMTP_STARTTLS=0`) dan
 *     hanya masuk akal untuk relay lokal.
 */

import { connect as netConnect } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";

import type { BookingNotifier } from "./context.ts";

export interface SmtpConfig {
  host: string;
  port: number;
  /** TLS sejak sambungan dibuka (port 465). */
  secure: boolean;
  /** Naikkan ke TLS lewat STARTTLS setelah EHLO (port 587/25). */
  starttls: boolean;
  /** Kosong = relay tanpa autentikasi. Diisi = AUTH LOGIN wajib. */
  user: string;
  pass: string;
  /** Alamat pengirim di header `From` dan envelope `MAIL FROM`. */
  from: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Baca konfigurasi SMTP dari environment.
 *
 * `null` = memang belum dikonfigurasi, dan itu sah: pemanggil jatuh ke
 * `logNotifier` dan melaporkan `live: false` dengan jujur. Yang **tidak**
 * sah adalah setengah terkonfigurasi — host ada tapi pengirim tidak — karena
 * itu akan terlihat "hidup" di UI padahal setiap kiriman pasti gagal. Untuk
 * kasus itu kita melempar saat start, bukan diam-diam memakai log.
 */
export function smtpConfigFromEnv(env: NodeJS.ProcessEnv): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim() ?? "";
  if (host === "") return null;

  const from = env.SMTP_FROM?.trim() ?? "";
  if (from === "") {
    throw new Error("SMTP_HOST diisi tapi SMTP_FROM kosong — isi alamat pengirim, atau hapus SMTP_HOST.");
  }

  const user = env.SMTP_USER?.trim() ?? "";
  const pass = env.SMTP_PASS ?? "";
  if ((user === "") !== (pass === "")) {
    throw new Error("SMTP_USER dan SMTP_PASS harus diisi bersama-sama (atau dua-duanya kosong untuk relay tanpa auth).");
  }

  const secure = env.SMTP_SECURE === undefined ? (env.SMTP_PORT ?? "") === "465" : env.SMTP_SECURE !== "0";
  const port = Number(env.SMTP_PORT ?? (secure ? "465" : "587"));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SMTP_PORT tidak valid: ${env.SMTP_PORT ?? ""}`);
  }

  return {
    host,
    port,
    secure,
    starttls: secure ? false : env.SMTP_STARTTLS !== "0",
    user,
    pass,
    from,
    timeoutMs: Number(env.SMTP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  };
}

// ── klien SMTP minimal ──────────────────────────────────────────────────

export interface Reply {
  code: number;
  text: string;
}

/** Pembaca baris+balasan SMTP dari socket. Satu balasan bisa berbaris-baris. */
class ReplyReader {
  private buffer = "";
  private readonly lines: string[] = [];
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  private closed = false;

  readonly socket: Duplex;

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let index = this.buffer.indexOf("\r\n");
      while (index >= 0) {
        this.lines.push(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + 2);
        index = this.buffer.indexOf("\r\n");
      }
      this.wake?.();
    });
    socket.on("error", (error: Error) => {
      this.failure ??= error;
      this.wake?.();
    });
    socket.on("close", () => {
      this.closed = true;
      this.wake?.();
    });
  }

  /**
   * Balasan SMTP lengkap.
   *
   * Satu balasan bisa terdiri dari beberapa baris: `250-A`, `250-B`, lalu
   * `250 C` (pemisah `-` vs spasi). Teksnya digabung karena yang menentukan
   * keputusan justru baris tengah — `STARTTLS` diiklankan di situ, bukan di
   * baris terakhir. Membaca baris terakhir saja akan membuat server yang
   * menawarkan STARTTLS terlihat tidak menawarkannya.
   */
  async next(): Promise<Reply> {
    const collected: string[] = [];
    for (;;) {
      while (this.lines.length > 0) {
        const line = this.lines.shift() as string;
        const match = /^(\d{3})([ -])(.*)$/.exec(line);
        if (match === null) continue;
        collected.push(match[3] ?? "");
        if (match[2] === " ") {
          return { code: Number(match[1]), text: collected.join("\n") };
        }
      }
      if (this.failure !== null) throw this.failure;
      if (this.closed) throw new Error("koneksi SMTP ditutup server sebelum balasan lengkap");
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  async expect(step: string, allowed: number[]): Promise<Reply> {
    const reply = await this.next();
    if (!allowed.includes(reply.code)) {
      throw new Error(`SMTP ${step} gagal: ${reply.code} ${reply.text}`);
    }
    return reply;
  }

  async command(step: string, line: string, allowed: number[]): Promise<Reply> {
    this.write(line);
    return this.expect(step, allowed);
  }
}

export interface SmtpTransportDeps {
  /** Cara membuka sambungan. Dipakai tes untuk menyuntik server palsu. */
  openSocket?: (config: SmtpConfig) => Duplex;
  /** Cara menaikkan sambungan ke TLS saat STARTTLS. Sama: hook untuk tes. */
  openTls?: (config: SmtpConfig, socket: Duplex) => Duplex;
  /** Nama yang dipakai di EHLO. */
  clientName?: string;
}

function defaultOpenSocket(config: SmtpConfig): Duplex {
  if (config.secure) {
    return tlsConnect({ host: config.host, port: config.port, servername: config.host });
  }
  return netConnect({ host: config.host, port: config.port });
}

/**
 * Kirim satu pesan.
 *
 * Ditulis sebagai satu urutan lurus supaya kegagalan SMTP terbaca apa adanya:
 * tiap langkah memeriksa kode balasan dan melempar dengan kode itu di pesan,
 * jadi log operator memuat `550`, bukan "gagal mengirim".
 */
export async function sendSmtpMail(
  config: SmtpConfig,
  message: { to: string; subject: string; body: string },
  deps: SmtpTransportDeps = {},
): Promise<void> {
  const clientName = deps.clientName ?? hostname() ?? "localhost";
  const openTls = deps.openTls;
  let reader = new ReplyReader((deps.openSocket ?? defaultOpenSocket)(config));
  let socket: Duplex = reader.socket;

  const timer = setTimeout(() => socket.destroy(new Error(`SMTP timeout ${config.timeoutMs} ms`)), config.timeoutMs);
  timer.unref?.();

  try {
    await reader.expect("greeting", [220]);
    const ehlo = await reader.command("EHLO", `EHLO ${clientName}`, [250]);

    if (!config.secure && config.starttls) {
      if (!/STARTTLS/i.test(ehlo.text)) {
        throw new Error("server SMTP tidak menawarkan STARTTLS — kiriman dibatalkan (kredensial tidak dikirim polos)");
      }
      await reader.command("STARTTLS", "STARTTLS", [220]);
      const upgraded = openTls !== undefined
        ? openTls(config, socket)
        : tlsConnect({ socket, host: config.host, servername: config.host });
      reader = new ReplyReader(upgraded);
      socket = upgraded;
      await reader.command("EHLO", `EHLO ${clientName}`, [250]);
    }

    if (config.user !== "") {
      await reader.command("AUTH LOGIN", "AUTH LOGIN", [334]);
      await reader.command("AUTH user", Buffer.from(config.user, "utf8").toString("base64"), [334]);
      await reader.command("AUTH pass", Buffer.from(config.pass, "utf8").toString("base64"), [235]);
    }

    await reader.command("MAIL FROM", `MAIL FROM:<${config.from}>`, [250]);
    await reader.command("RCPT TO", `RCPT TO:<${message.to}>`, [250, 251]);
    await reader.command("DATA", "DATA", [354]);
    await reader.command("body", `${dotStuff(buildMessage(config, message, clientName)).replace(/\r\n$/, "")}\r\n.`, [250]);

    socket.write("QUIT\r\n");
    socket.end();
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Bungkus payload RFC 5322. Body di-base64 supaya baris panjang & non-ASCII aman. */
export function buildMessage(
  config: SmtpConfig,
  message: { to: string; subject: string; body: string },
  clientName = "localhost",
): string {
  const headers = [
    `From: ${config.from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${clientName}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
  ];
  const encoded = Buffer.from(message.body, "utf8").toString("base64");
  const wrapped = encoded.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
  return `${headers.join("\r\n")}\r\n\r\n${wrapped}`;
}

/** Header non-ASCII dibungkus RFC 2047 supaya "—" tidak jadi mojibake. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Baris yang diawali titik harus di-escape, kalau tidak dianggap akhir DATA. */
function dotStuff(payload: string): string {
  return payload.replace(/\r\n\./g, "\r\n..").replace(/^\./, "..");
}

/**
 * Notifier berbasis SMTP. `live: true` — rute boleh melaporkan `delivered`
 * kalau `email()` tidak melempar.
 */
export function createSmtpNotifier(config: SmtpConfig, deps: SmtpTransportDeps = {}): BookingNotifier {
  return {
    live: true,
    email(to: string, subject: string, body: string) {
      return sendSmtpMail(config, { to, subject, body }, deps);
    },
  };
}
