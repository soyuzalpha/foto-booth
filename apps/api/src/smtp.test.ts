/**
 * Tes kanal SMTP (Fase 11).
 *
 * Yang diuji di sini bukan "apakah nodemailer jalan", melainkan **apakah kita
 * berhenti pada saat yang benar**. Dua kegagalan mahal yang dicegah:
 *
 *   1. Mengirim kredensial lewat koneksi polos — server tidak menawarkan
 *      STARTTLS tapi kita tetap AUTH. Tes `"tanpa STARTTLS → tidak pernah AUTH"`
 *      mengunci aturan itu.
 *   2. Menganggap kiriman sukses padahal server menolak (`535`, `550`) —
 *      booking akan ditandai "sudah diingatkan" tanpa pesan yang keluar.
 *
 * Server SMTP-nya palsu dan hidup di dalam satu `Duplex` — tidak ada jaringan,
 * tidak ada port, dan urutan perintahnya bisa diperiksa persis.
 */

import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import test from "node:test";

import {
  buildMessage,
  encodeHeader,
  sendSmtpMail,
  smtpConfigFromEnv,
  type SmtpConfig,
} from "./smtp.ts";

const BASE: SmtpConfig = {
  host: "smtp.test",
  port: 587,
  secure: false,
  starttls: false,
  user: "",
  pass: "",
  from: "booth@foto-booth.test",
  timeoutMs: 2_000,
};

/**
 * Server SMTP mainan: membaca perintah baris demi baris, membalas sesuai
 * skrip. Semua yang masuk dicatat di `commands` supaya tes bisa menegaskan
 * "AUTH tidak pernah dikirim", bukan cuma "panggilan gagal".
 */
class FakeSmtp extends Duplex {
  readonly commands: string[] = [];
  readonly data: string[] = [];
  private buffer = "";
  private inData = false;
  /** Kode balasan untuk MAIL/RCPT/DATA; 250 = diterima. */
  failAt: { command: string; code: number; text: string } | null = null;
  advertiseStartTls = false;
  /** 0 = belum AUTH; 1 = sudah kirim user, menunggu pass; 2 = sudah kirim pass. */
  private authStep = 0;
  private pendingData: string[] = [];

  constructor(greet = true) {
    // Tanpa opsi `read`/`write` di konstruktor: opsi `write` akan menutupi
    // `_write` di bawah, dan server palsu diam-diam tidak menerima perintah.
    super();
    // Sisi TLS setelah STARTTLS tidak menyapa ulang (`220`) — klien langsung
    // mengirim EHLO kedua. Fake tanpa sapaan dipakai di tes STARTTLS.
    if (greet) queueMicrotask(() => this.greet());
  }

  private greet(): void {
    this.push("220 smtp.test ESMTP\r\n");
  }

  /** Duplex menuntut `_read`; tanpa isi, cukup supaya `push` tidak melempar. */
  override _read(): void {}

  override _write(chunk: Buffer, _enc: string, done: () => void): void {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\r\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.handle(line);
      index = this.buffer.indexOf("\r\n");
    }
    done();
  }

  private handle(line: string): void {
    if (this.inData) {
      if (line === ".") {
        this.inData = false;
        this.data.push(this.pendingData.join("\r\n"));
        this.push("250 OK queued\r\n");
        return;
      }
      this.pendingData.push(line);
      return;
    }

    const verb = line.split(" ")[0]?.toUpperCase() ?? "";
    this.commands.push(line);

    if (this.failAt !== null && verb === this.failAt.command) {
      this.push(`${this.failAt.code} ${this.failAt.text}\r\n`);
      return;
    }

    switch (verb) {
      case "EHLO":
        // Baris terakhir balasan wajib berakhir spasi (`250 teks`), bukan `-`:
        // `250-...` berarti "masih ada baris lanjutan", jadi pembaca menunggu
        // selamanya kalau seluruh balasan memakai pemisah `-`.
        this.push(this.advertiseStartTls ? "250-smtp.test\r\n250 STARTTLS\r\n" : "250 smtp.test\r\n");
        return;
      case "STARTTLS":
        this.push("220 ready\r\n");
        return;
      case "AUTH":
        this.authStep = 1;
        this.push("334 VXNlcm5hbWU6\r\n");
        return;
      case "MAIL":
      case "RCPT":
        this.push("250 OK\r\n");
        return;
      case "DATA":
        this.inData = true;
        this.pendingData = [];
        this.push("354 End data with <CR><LF>.<CR><LF>\r\n");
        return;
      case "QUIT":
        this.push("221 Bye\r\n");
        return;
      default:
        // Baris AUTH LOGIN: base64 user dulu (minta pass), lalu base64 pass.
        if (this.authStep === 1) {
          this.authStep = 2;
          this.push("334 UGFzc3dvcmQ6\r\n");
          return;
        }
        this.authStep = 0;
        this.push("235 Authentication successful\r\n");
    }
  }
}

function send(config: Partial<SmtpConfig>, server: FakeSmtp, message = { to: "tamu@example.com", subject: "Halo", body: "Isi pesan" }) {
  return sendSmtpMail({ ...BASE, ...config }, message, {
    openSocket: () => server,
    clientName: "foto-booth.test",
  });
}

test("jalur normal: MAIL/RCPT/DATA terkirim dan body di-base64", async () => {
  const server = new FakeSmtp();
  await send({}, server);

  assert.ok(server.commands.includes(`MAIL FROM:<${BASE.from}>`), "MAIL FROM dikirim");
  assert.ok(server.commands.includes("RCPT TO:<tamu@example.com>"), "RCPT TO dikirim");
  assert.ok(server.commands.includes("DATA"), "DATA dikirim");
  assert.equal(server.data.length, 1, "satu pesan masuk queue");

  const raw = server.data[0] as string;
  assert.match(raw, /^From: booth@foto-booth\.test/m);
  assert.match(raw, /^Subject: Halo/m);
  assert.match(raw, /Content-Transfer-Encoding: base64/);
  const encoded = raw.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") ?? "";
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "Isi pesan");
});

test("STARTTLS diiklankan di baris tengah EHLO pun terdeteksi", async () => {
  // Balasan EHLO di sini multi-baris: `250-smtp.test` lalu `250 STARTTLS`.
  // Kalau pembaca hanya melihat baris terakhir, server akan dikira tidak
  // menawarkan STARTTLS dan kiriman dibatalkan — bug yang pernah ada.
  const server = new FakeSmtp();
  server.advertiseStartTls = true;
  const tlsSide = new FakeSmtp(false);
  const sent: string[] = [];
  await sendSmtpMail({ ...BASE, starttls: true }, { to: "tamu@example.com", subject: "Halo", body: "Isi" }, {
    openSocket: () => server,
    openTls: () => {
      sent.push("tls");
      // Sisi TLS: server yang sama sudah melewati sapaan `220`.
      return tlsSide;
    },
    clientName: "foto-booth.test",
  });
  assert.deepEqual(sent, ["tls"], "sambungan dinaikkan ke TLS setelah STARTTLS");
  assert.ok(server.commands.includes("STARTTLS"));
  assert.equal(tlsSide.data.length, 1, "pesan dikirim lewat koneksi yang sudah TLS");
});

test("tanpa STARTTLS → tidak pernah mengirim AUTH (kredensial tidak bocor)", async () => {
  const server = new FakeSmtp();
  server.advertiseStartTls = false;
  await assert.rejects(
    () => send({ user: "booth", pass: "rahasia", starttls: true }, server),
    /tidak menawarkan STARTTLS/,
  );
  assert.equal(
    server.commands.some((line) => line.toUpperCase().startsWith("AUTH")),
    false,
    "AUTH tidak pernah dikirim ke koneksi polos",
  );
});

test("AUTH LOGIN dikirim base64 saat STARTTLS tersedia", async () => {
  const server = new FakeSmtp();
  server.advertiseStartTls = true;
  await sendSmtpMail({ ...BASE, starttls: true, user: "booth", pass: "rahasia" }, { to: "t@example.com", subject: "s", body: "b" }, {
    openSocket: () => server,
    // Server TLS mainan yang tetap memeriksa urutannya.
    openTls: () => server,
    clientName: "foto-booth.test",
  });
  assert.ok(server.commands.includes("AUTH LOGIN"), "AUTH LOGIN dipanggil");
  assert.ok(server.commands.includes(Buffer.from("booth").toString("base64")), "user base64");
  assert.ok(server.commands.includes(Buffer.from("rahasia").toString("base64")), "pass base64");
});

test("penolakan server (550 RCPT) melempar dengan kodenya, bukan sukses palsu", async () => {
  const server = new FakeSmtp();
  server.failAt = { command: "RCPT", code: 550, text: "No such user" };
  await assert.rejects(() => send({}, server), /550 No such user/);
  assert.equal(server.data.length, 0, "tidak ada pesan yang dianggap terkirim");
});

test("penolakan DATA (554) juga melempar", async () => {
  const server = new FakeSmtp();
  server.failAt = { command: "DATA", code: 554, text: "Transaction failed" };
  await assert.rejects(() => send({}, server), /554 Transaction failed/);
  assert.equal(server.data.length, 0, "pesan gagal tidak masuk queue");
});

test("body yang berisi baris titik tidak mengakhiri DATA lebih awal", () => {
  // Base64 tidak menghasilkan baris ".", tapi `buildMessage` mengembalikan
  // payload siap-kirim — uji fungsinya langsung supaya aturan dot-stuffing
  // tetap terjaga walau encoding berubah di masa depan.
  const message = buildMessage(BASE, { to: "t@example.com", subject: "s", body: "." }, "test");
  assert.ok(!/\r\n\.\r\n/.test(message), "baris titik tunggal tidak muncul di payload");
});

test("subject non-ASCII dibungkus RFC 2047, ASCII dibiarkan", () => {
  assert.equal(encodeHeader("Pengingat sesi"), "Pengingat sesi");
  const encoded = encodeHeader("Pengingat — sesi");
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  const b64 = encoded.slice("=?UTF-8?B?".length, -"?=".length);
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "Pengingat — sesi");
});

test("smtpConfigFromEnv: kosong → null (log saja), setengah lengkap → melempar", () => {
  assert.equal(smtpConfigFromEnv({}), null);

  assert.throws(() => smtpConfigFromEnv({ SMTP_HOST: "smtp.test" }), /SMTP_FROM kosong/);
  assert.throws(
    () => smtpConfigFromEnv({ SMTP_HOST: "smtp.test", SMTP_FROM: "a@b.test", SMTP_USER: "x" }),
    /SMTP_USER dan SMTP_PASS/,
  );
  assert.throws(
    () => smtpConfigFromEnv({ SMTP_HOST: "smtp.test", SMTP_FROM: "a@b.test", SMTP_PORT: "abc" }),
    /SMTP_PORT tidak valid/,
  );
});

test("smtpConfigFromEnv: port 465 default TLS implisit, 587 default STARTTLS", () => {
  const implicit = smtpConfigFromEnv({ SMTP_HOST: "smtp.test", SMTP_FROM: "a@b.test", SMTP_PORT: "465" });
  assert.equal(implicit?.secure, true);
  assert.equal(implicit?.starttls, false, "TLS implisit tidak butuh STARTTLS lagi");

  const starttls = smtpConfigFromEnv({ SMTP_HOST: "smtp.test", SMTP_FROM: "a@b.test" });
  assert.equal(starttls?.secure, false);
  assert.equal(starttls?.port, 587);
  assert.equal(starttls?.starttls, true);
});
