/**
 * Tes pencetak desktop (Fase 12, FEATURE-MATRIX #45, #80, #88).
 *
 * Yang dibuktikan di sini bukan bahwa Electron bisa mencetak — itu perlu mesin
 * sungguhan — melainkan **keputusan** yang membuat kiosk tetap hidup:
 *
 *   · jalur desktop dipakai hanya saat jembatan **dan** nama printer ada;
 *   · tanpa keduanya, pencetakan jatuh ke jalur browser;
 *   · gagal cetak menjadi `throw` berisi alasan, bukan diam-diam sukses;
 *   · salinan dihormati; gambar yang belum ditempelkan ditolak.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createPrintJob, type PrintJob } from "@foto-booth/shared";

import { buildDesktopPrintHtml, desktopPrinter, willPrintViaDesktop } from "./desktopPrinter.ts";
import { buildPrintDocument } from "./printBrowser.ts";
import type { PrintFn } from "./printQueueRunner.ts";
import type { DesktopBridge } from "./printerRuntime.ts";

const PRESET = { width: 2, height: 6, bleed: 0, dpi: 300, name: "2x6" };

function job(copies = 1): PrintJob {
  return createPrintJob({ id: "job-1", copies, now: "2026-10-15T00:00:00.000Z" }, 1);
}

test("jalur desktop dipakai saat jembatan dan nama printer tersedia", () => {
  const calls: { html: string; deviceName?: string | null; silent?: boolean }[] = [];
  const bridge: DesktopBridge = {
    getPrinters: async () => [],
    printHtml: async (input) => {
      calls.push(input);
      return { ok: true };
    },
  };

  assert.equal(willPrintViaDesktop({ bridge: null, transport: "electron", deviceName: "X" }), false);
  assert.equal(willPrintViaDesktop({ bridge, transport: "electron", deviceName: null }), false);
  assert.equal(willPrintViaDesktop({ bridge, transport: "browser", deviceName: "X" }), false);
  assert.equal(willPrintViaDesktop({ bridge, transport: "electron", deviceName: "X" }), true);
});

test("cetak senyap diteruskan apa adanya, salinan dihormati", async () => {
  const calls: { deviceName?: string | null; silent?: boolean }[] = [];
  const bridge = {
    getPrinters: async () => [],
    printHtml: async (input: { deviceName?: string | null; silent?: boolean }) => {
      calls.push(input);
      return { ok: true };
    },
  };

  const print = desktopPrinter({
    bridge,
    getTransport: () => "electron",
    getDeviceName: () => "DNP DS-RX1",
    getSilent: () => true,
    resolveImage: () => "data:image/png;base64,AAAA",
    fallback: async () => {
      throw new Error("jalur browser tidak boleh dipakai");
    },
  });

  await print(job(3));

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.deviceName, "DNP DS-RX1");
    assert.equal(call.silent, true);
  }
});

test("tanpa jembatan, pencetakan jatuh ke jalur browser", async () => {
  let fallbackCalls = 0;
  const fallback: PrintFn = async () => {
    fallbackCalls += 1;
  };

  const print = desktopPrinter({
    bridge: null,
    getTransport: () => "browser",
    getDeviceName: () => null,
    getSilent: () => true,
    resolveImage: () => "data:image/png;base64,AAAA",
    fallback,
  });

  await print(job());
  assert.equal(fallbackCalls, 1);
});

test("jembatan ada tapi printer tak bernama tetap jatuh ke browser", async () => {
  let fallbackCalls = 0;
  const bridge = {
    getPrinters: async () => [],
    printHtml: async () => ({ ok: true }),
  };

  const print = desktopPrinter({
    bridge,
    getTransport: () => "browser",
    getDeviceName: () => null,
    getSilent: () => true,
    resolveImage: () => "data:image/png;base64,AAAA",
    fallback: async () => {
      fallbackCalls += 1;
    },
  });

  await print(job());
  assert.equal(fallbackCalls, 1, "printer bawaan sistem dicetak lewat browser, bukan jembatan");
});

test("gagal cetak membawa alasan dari jembatan", async () => {
  const bridge = {
    getPrinters: async () => [],
    printHtml: async () => ({ ok: false, reason: "printer sedang sibuk" }),
  };

  const print = desktopPrinter({
    bridge,
    getTransport: () => "electron",
    getDeviceName: () => "X",
    getSilent: () => true,
    resolveImage: () => "data:image/png;base64,AAAA",
    fallback: async () => {},
  });

  await assert.rejects(() => print(job()), /printer sedang sibuk/);
});

test("gagal cetak tanpa alasan tetap memberi pesan yang bisa dibaca", async () => {
  const bridge = {
    getPrinters: async () => [],
    printHtml: async () => ({ ok: false }),
  };

  const print = desktopPrinter({
    bridge,
    getTransport: () => "electron",
    getDeviceName: () => "X",
    getSilent: () => true,
    resolveImage: () => "data:image/png;base64,AAAA",
    fallback: async () => {},
  });

  await assert.rejects(() => print(job()), /cetak lewat jembatan desktop gagal/);
});

test("gambar yang belum ditempelkan ditolak sebelum menyentuh printer", async () => {
  let printed = 0;
  const bridge = {
    getPrinters: async () => [],
    printHtml: async () => {
      printed += 1;
      return { ok: true };
    },
  };

  const print = desktopPrinter({
    bridge,
    getTransport: () => "electron",
    getDeviceName: () => "X",
    getSilent: () => true,
    resolveImage: () => null,
    fallback: async () => {},
  });

  await assert.rejects(() => print(job()), /belum ditempelkan/);
  assert.equal(printed, 0);
});

test("HTML desktop memakai ukuran @page yang sama dengan jalur browser", () => {
  const imageUrl = "data:image/png;base64,AAAA";
  const desktop = buildDesktopPrintHtml(imageUrl, "job-1");
  const browser = buildPrintDocument(PRESET, { imageUrl }).html;

  const pageOf = (html: string): string => html.match(/@page \{[^}]*\}/)?.[0] ?? "";
  assert.equal(pageOf(desktop), pageOf(browser), "@page harus identik dengan jalur browser");
  assert.match(desktop, /data:image\/png;base64,AAAA/);
});
