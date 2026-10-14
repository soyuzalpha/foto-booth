/**
 * Tes pembungkus share studio.
 *
 * Janji yang diuji:
 *
 *   1. **Tautan kanal datang dari fungsi shared**, bukan dirakit ulang di sini.
 *      Kalau dirakit ulang, kartu share dan pesan WhatsApp bisa berbeda begitu
 *      salah satunya diubah.
 *   2. **`native` jatuh ke clipboard saat Web Share tidak ada.** Tombol tidak
 *      boleh mati di browser tanpa Web Share API.
 *   3. **Clipboard yang ditolak berakhir di `prompt`**, bukan tautan hilang.
 *   4. **`opened` untuk kanal ber-URL**, `copied`/`shared`/`manual` untuk
 *      sisanya — panel perlu tahu hasilnya untuk menampilkan umpan balik.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_BRANDING, shareLink, type ShareTarget } from "@foto-booth/shared";

import {
  runShare,
  shareDescriptionOf,
  shareOptionsOf,
  shareTargetOf,
  type ShareContext,
} from "./shareClient.ts";

const CONTEXT: ShareContext = {
  branding: { ...DEFAULT_BRANDING, heading: "Pernikahan Dina" },
  event: { name: "Pernikahan Dina", date: "2026-10-20", hashtag: "#DinaRizky" },
  galleryUrl: "https://foto.example/a/abc123",
};

/* ---- Target & opsi ------------------------------------------------ */

test("target memakai judul dari fungsi shared", () => {
  const target = shareTargetOf(CONTEXT);
  assert.equal(target.url, CONTEXT.galleryUrl);
  assert.equal(target.title, "Pernikahan Dina");
});

test("deskripsi jatuh ke ajakan kalau subjudul kosong", () => {
  const context: ShareContext = { ...CONTEXT, branding: { ...DEFAULT_BRANDING }, event: null };
  assert.equal(shareDescriptionOf(context), "Ambil & bagikan fotonya.");
});

test("deskripsi memakai nama acara saat branding kosong", () => {
  const context: ShareContext = { ...CONTEXT, branding: { ...DEFAULT_BRANDING } };
  assert.equal(shareDescriptionOf(context), "Pernikahan Dina · 2026-10-20 · #DinaRizky");
});

test("opsi kanal cocok dengan shareLink untuk setiap kanal", () => {
  const target = shareTargetOf(CONTEXT);
  for (const option of shareOptionsOf(CONTEXT)) {
    assert.equal(option.href, shareLink(option.channel, target), `kanal ${option.channel}`);
  }
});

test("hanya kanal ber-URL yang punya href", () => {
  const byChannel = new Map(shareOptionsOf(CONTEXT).map((option) => [option.channel, option.href]));
  assert.match(String(byChannel.get("whatsapp")), /^https:\/\/wa\.me\/\?text=/);
  assert.match(String(byChannel.get("email")), /^mailto:\?subject=/);
  assert.match(String(byChannel.get("sms")), /^sms:\?body=/);
  assert.equal(byChannel.get("native"), null);
  assert.equal(byChannel.get("copy"), null);
});

/* ---- runShare ----------------------------------------------------- */

test("kanal ber-URL membuka tab baru", async () => {
  const opened: string[] = [];
  const outcome = await runShare("whatsapp", CONTEXT, { open: (href) => opened.push(href) });

  assert.equal(outcome.result, "opened");
  assert.equal(opened.length, 1);
  assert.match(opened[0] ?? "", /^https:\/\/wa\.me\//);
});

test("native memakai Web Share kalau tersedia", async () => {
  const seen: ShareTarget[] = [];
  const outcome = await runShare("native", CONTEXT, {
    native: async (target) => {
      seen.push(target);
      return true;
    },
    copy: async () => {
      throw new Error("clipboard tidak boleh dipanggil");
    },
  });

  assert.equal(outcome.result, "shared");
  assert.equal(seen[0]?.url, CONTEXT.galleryUrl);
});

test("native jatuh ke clipboard saat Web Share tidak ada", async () => {
  const copied: string[] = [];
  const outcome = await runShare("native", CONTEXT, {
    native: async () => false,
    copy: async (text) => {
      copied.push(text);
      return true;
    },
  });

  assert.equal(outcome.result, "copied");
  assert.deepEqual(copied, [CONTEXT.galleryUrl]);
});

test("clipboard yang ditolak berakhir di prompt", async () => {
  const prompted: string[] = [];
  const outcome = await runShare("copy", CONTEXT, {
    copy: async () => false,
    prompt: (text) => prompted.push(text),
  });

  assert.equal(outcome.result, "manual");
  assert.deepEqual(prompted, [CONTEXT.galleryUrl]);
});

test("copy langsung ke clipboard kalau diizinkan", async () => {
  const outcome = await runShare("copy", CONTEXT, { copy: async () => true });
  assert.equal(outcome.result, "copied");
});
