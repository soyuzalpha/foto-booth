/**
 * Tes sharing (Fase 9).
 *
 * Fokus: **tautan yang benar-benar dibuka orang lain**. Salah satu karakter
 * yang tidak ter-encode di query WhatsApp membuat pesan sampai terpotong di
 * tengah; `mailto:` dengan `&` mentah membuat body berhenti di kata pertama.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SHARE_CHANNELS,
  SHARE_MESSAGE_MAX,
  isShareChannel,
  shareLink,
  sharePageTitle,
  shareText,
} from "./sharing.ts";

const target = { url: "https://foto.example/a/abc123", title: "Pernikahan Asep & Rina" };

test("isShareChannel menyaring nilai asing", () => {
  assert.equal(isShareChannel("whatsapp"), true);
  assert.equal(isShareChannel("native"), true);
  assert.equal(isShareChannel("twitter"), false);
  assert.equal(SHARE_CHANNELS.length, 5);
});

test("teks share memuat judul dan tautan", () => {
  const text = shareText(target);
  assert.match(text, /Pernikahan Asep & Rina/);
  assert.match(text, /https:\/\/foto\.example\/a\/abc123/);
});

test("pesan opsional ditaruh sebelum judul", () => {
  const text = shareText({ ...target, message: "Fotonya sudah jadi" });
  assert.match(text, /^Fotonya sudah jadi — Pernikahan/);
});

test("baris baru di judul dirapikan jadi spasi", () => {
  // Satu `\n` di tengah pesan WhatsApp memutus autolink tautannya.
  const text = shareText({ ...target, title: "Asep\n&\nRina" });
  assert.equal(text.includes("\n"), false);
  assert.match(text, /Asep & Rina/);
});

test("teks dibatasi panjangnya", () => {
  const text = shareText({ ...target, message: "x".repeat(1000) });
  assert.equal(text.length, SHARE_MESSAGE_MAX);
});

test("WhatsApp: satu parameter text, ter-encode", () => {
  const link = shareLink("whatsapp", target);
  assert.notEqual(link, null);
  const url = new URL(link as string);
  assert.equal(url.origin + url.pathname, "https://wa.me/");
  assert.equal(url.searchParams.get("text"), shareText(target));
});

test("email: subject dan body terpisah", () => {
  const link = shareLink("email", target) as string;
  assert.match(link, /^mailto:\?/);
  const params = new URLSearchParams(link.slice("mailto:?".length));
  assert.equal(params.get("subject"), "Pernikahan Asep & Rina");
  assert.equal(params.get("body"), shareText(target));
});

test("SMS: memakai ?body= yang diterima iOS dan Android", () => {
  const link = shareLink("sms", target) as string;
  assert.match(link, /^sms:\?body=/);
  assert.equal(decodeURIComponent(link.slice("sms:?body=".length)), shareText(target));
});

test("native & copy tidak punya URL", () => {
  // Web Share API dipanggil lewat navigator.share(); mengembalikan URL di sini
  // akan membuat pemanggil membuka jendela ke 'null'.
  assert.equal(shareLink("native", target), null);
  assert.equal(shareLink("copy", target), null);
});

test("sharePageTitle: heading → nama acara → generik", () => {
  assert.equal(sharePageTitle("Kita", "Acara"), "Kita");
  assert.equal(sharePageTitle("   ", "Acara"), "Acara");
  assert.equal(sharePageTitle("", null), "Galeri foto");
  assert.equal(sharePageTitle("", "  "), "Galeri foto");
});
