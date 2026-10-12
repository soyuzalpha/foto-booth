/**
 * Tes dokumen print (iframe).
 *
 * Yang penting di sini bukan "HTML-nya benar" secara umum, tapi dua hal yang
 * kalau salah bikin hasil cetak mengecil atau kertas salah:
 *   · `@page { size: … mm }` harus memakai ukuran preset, bukan default;
 *   · `margin: 0` wajib — tanpa itu Chromium menambah margin ~0,4 in.
 *
 * Siklus hidup iframe juga diuji: `afterprint` harus melepas iframe + blob URL,
 * dan kalau event itu tidak pernah datang, timeout jaring pengaman yang lepas.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { printPresetById, type PrintPreset } from "@foto-booth/shared";

import { buildPrintDocument, printImage, printPreviewMeta, type PrintDeps } from "./printBrowser.ts";

function preset(id: string): PrintPreset {
  const found = printPresetById(id);
  assert.ok(found !== null, `preset ${id} tidak ada`);
  return found;
}

test("dokumen print memakai @page ukuran preset dan margin 0", () => {
  const doc = buildPrintDocument(preset("2x6"), { imageUrl: "data:image/png;base64,AAAA" });

  assert.match(doc.html, /@page \{ size: 50\.8mm 152\.4mm; margin: 0; \}/);
  assert.equal(doc.widthMm, 50.8);
  assert.equal(doc.heightMm, 152.4);
});

test("4×6 menghasilkan @page 101,6 × 152,4 mm", () => {
  const doc = buildPrintDocument(preset("4x6"), { imageUrl: "data:image/png;base64,AAAA" });
  assert.equal(doc.widthMm, 101.6);
  assert.equal(doc.heightMm, 152.4);
});

test("bleed ikut masuk ukuran @page kalau diminta", () => {
  const doc = buildPrintDocument(preset("2x6"), {
    imageUrl: "data:image/png;base64,AAAA",
    includeBleed: true,
  });
  assert.equal(doc.widthMm, 53.34);
  assert.equal(doc.heightMm, 154.94);
});

test("gambar dibentangkan penuh, bukan object-fit contain dengan tinggi auto", () => {
  const doc = buildPrintDocument(preset("2x6"), { imageUrl: "data:image/png;base64,AAAA" });
  assert.match(doc.html, /img \{[^}]*width: 100%;[^}]*height: 100%;/);
});

test("judul dokumen di-escape — nama event tidak bisa menyuntik HTML", () => {
  const doc = buildPrintDocument(preset("2x6"), {
    imageUrl: "data:image/png;base64,AAAA",
    title: '<script>alert("x")</script>',
  });

  assert.ok(!doc.html.includes("<script>alert"), "judul mentah bocor ke HTML");
  assert.match(doc.html, /&lt;script&gt;/);
});

/** Iframe palsu + lingkungan print yang bisa diperiksa. */
function fakeEnv() {
  const removed: string[] = [];
  const revoked: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const listeners: Record<string, (() => void)[]> = {};

  const win = {
    addEventListener(type: string, fn: () => void) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type: string, fn: () => void) {
      listeners[type] = (listeners[type] ?? []).filter((item) => item !== fn);
    },
    focus() {},
    printed: false,
    print() { win.printed = true; },
  };

  const iframe = {
    style: {} as CSSStyleDeclaration,
    contentWindow: win,
    setAttribute() {},
    addEventListener(type: string, fn: () => void) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type: string, fn: () => void) {
      listeners[type] = (listeners[type] ?? []).filter((item) => item !== fn);
    },
    remove() { removed.push("iframe"); },
    src: "",
  };

  const doc = {
    createElement: () => iframe,
    body: { append: () => { removed.push("append"); } },
  };

  const deps: PrintDeps = {
    createIframe: () => iframe as unknown as HTMLIFrameElement,
    document: doc as unknown as Document,
    createObjectUrl: () => "blob:fake",
    revokeObjectUrl: (url) => revoked.push(url),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  };

  return {
    deps,
    win,
    iframe,
    removed,
    revoked,
    timers,
    fire(type: string) { for (const fn of [...(listeners[type] ?? [])]) fn(); },
  };
}

test("printImage memanggil window.print() setelah iframe load", () => {
  const env = fakeEnv();
  const handle = printImage(preset("2x6"), "data:image/png;base64,AAAA", env.deps);

  assert.equal(handle.printed, false, "belum load");
  env.fire("load");
  assert.equal(env.win.printed, true);
  assert.equal(handle.printed, true);
});

test("afterprint melepas iframe dan blob URL", () => {
  const env = fakeEnv();
  printImage(preset("2x6"), "data:image/png;base64,AAAA", env.deps);

  env.fire("load");
  assert.deepEqual(env.removed, ["append"], "iframe belum dilepas sebelum afterprint");

  env.fire("afterprint");
  // dispose dijadwalkan lewat setTimer(…, 0).
  for (const timer of env.timers) timer.fn();

  assert.ok(env.removed.includes("iframe"));
  assert.deepEqual(env.revoked, ["blob:fake"]);
});

test("tanpa afterprint, timeout jaring pengaman tetap melepas iframe", () => {
  const env = fakeEnv();
  const handle = printImage(preset("2x6"), "data:image/png;base64,AAAA", env.deps);

  env.fire("load");
  assert.ok(env.timers.some((timer) => timer.ms > 1000), "harus ada timer cleanup");

  // Jalankan timer cleanup terpanjang.
  for (const timer of env.timers) timer.fn();

  assert.ok(env.removed.includes("iframe"));
  assert.deepEqual(env.revoked, ["blob:fake"]);
  handle.dispose();
});

test("dispose aman dipanggil dua kali dan tidak melepas dua kali", () => {
  const env = fakeEnv();
  const handle = printImage(preset("2x6"), "data:image/png;base64,AAAA", env.deps);

  env.fire("load");
  handle.dispose();
  handle.dispose();

  assert.equal(env.removed.filter((item) => item === "iframe").length, 1);
  assert.deepEqual(env.revoked, ["blob:fake"]);
});

test("preview memakai ukuran dan mm yang sama dengan dokumen print", () => {
  const meta = printPreviewMeta(preset("4x6"));
  const doc = buildPrintDocument(preset("4x6"), { imageUrl: "x" });

  assert.deepEqual(meta, { width: 1200, height: 1800, widthMm: 101.6, heightMm: 152.4 });
  assert.equal(meta.widthMm, doc.widthMm);
  assert.equal(meta.heightMm, doc.heightMm);
});
