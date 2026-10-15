/**
 * Tes laporan diagnostik (Fase 12, #81).
 *
 * Dua hal yang paling mahal kalau salah di sini:
 *
 *   · **rahasia bocor ke laporan** — laporan ini dikirim ke WhatsApp/email
 *     teknisi, keluar dari mesin, dan tidak bisa ditarik kembali;
 *   · **kesiapan dilaporkan bagus padahal kamera tidak ada** — operator
 *     dikirim mengejar masalah yang salah.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPABILITY_LABELS,
  EMPTY_CAPABILITIES,
  buildDiagnosticReport,
  diagnosticFileName,
  diagnosticReportText,
  missingCapabilities,
  readinessLabel,
  readinessScore,
  type DiagnosticCapabilities,
} from "./diagnostics.ts";
import { type PrinterInfo } from "./printer.ts";

const FULL_CAPS: DiagnosticCapabilities = {
  camera: true,
  webusb: true,
  webcodecs: true,
  webgl: true,
  serviceWorker: true,
  storage: true,
  fullscreen: true,
  wakeLock: true,
};

function report(over: Partial<Parameters<typeof buildDiagnosticReport>[0]> = {}) {
  return buildDiagnosticReport({
    appVersion: "0.1.0",
    generatedAt: "2026-10-15T10:00:00.000Z",
    runtime: "browser",
    secureContext: true,
    online: true,
    capabilities: FULL_CAPS,
    ...over,
  });
}

test("skor kesiapan: semua ada = 100, tanpa apa-apa = 0", () => {
  assert.equal(readinessScore(FULL_CAPS), 100);
  assert.equal(readinessScore(EMPTY_CAPABILITIES), 0);
});

test("tanpa kamera skor turun di bawah ambang 'siap' walaupun sisanya lengkap", () => {
  // Kiosk tanpa kamera tidak bisa memotret — itu fakta, bukan nuansa.
  const noCamera = { ...FULL_CAPS, camera: false };
  assert.ok(readinessScore(noCamera) < 90);
  assert.equal(readinessLabel(readinessScore(noCamera)), "siap dengan catatan");
});

test("label kesiapan naik bertingkat dan tidak pernah kosong", () => {
  assert.equal(readinessLabel(100), "siap");
  assert.equal(readinessLabel(70), "siap dengan catatan");
  assert.equal(readinessLabel(40), "terbatas");
  assert.equal(readinessLabel(0), "tidak siap");
});

test("kemampuan yang hilang didaftar lengkap dan konsisten dengan labelnya", () => {
  const missing = missingCapabilities({ ...FULL_CAPS, webusb: false, wakeLock: false });
  assert.deepEqual(missing.sort(), ["wakeLock", "webusb"].sort());
  for (const key of missing) {
    assert.equal(typeof CAPABILITY_LABELS[key], "string");
  }
});

test("laporan tidak pernah memuat nilai rahasia apa pun", () => {
  // Sabuk pengaman: kalau ada yang menambahkan field rahasia ke laporan,
  // tes ini harus menangkapnya.
  const text = diagnosticReportText(
    report({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/152" }),
  );
  const forbidden = [
    "jwt",
    "secret",
    "password",
    "passwd",
    "token",
    "api_key",
    "apikey",
    "authorization",
    "aws_",
    "s3_",
    "smpt",
    "smtp",
  ];

  const lower = text.toLowerCase();
  for (const word of forbidden) {
    assert.equal(lower.includes(word), false, `laporan memuat "${word}"`);
  }
});

test("laporan menyebut nama tamu tidak pernah — hanya perangkat", () => {
  const text = diagnosticReportText(report({ notes: ["Kamera depan gagal dibuka"] }));
  assert.match(text, /Kamera depan gagal dibuka/);
  assert.equal(text.includes("Budi"), false);
});

test("runtime yang tidak melaporkan versi → null, bukan tebakan", () => {
  const r = report({ runtimeVersion: null, platform: null, userAgent: null });
  assert.equal(r.runtimeVersion, null);
  assert.equal(r.platform, null);
  assert.equal(r.userAgent, null);
  assert.match(diagnosticReportText(r), /Platform: tidak dilaporkan/);
});

test("secure context yang salah dilaporkan sebagai peringatan, bukan disembunyikan", () => {
  const text = diagnosticReportText(report({ secureContext: false }));
  assert.match(text, /TIDAK/);
  assert.match(text, /kamera\/USB akan gagal/);
});

test("daftar printer ikut ke laporan teks beserta statusnya", () => {
  const printers: PrinterInfo[] = [
    {
      id: "d1",
      name: "DNP DS-RX1",
      transport: "electron",
      isDefault: true,
      status: "ready",
      detail: "USB",
    },
    {
      id: "u1",
      name: "Printer USB",
      transport: "webusb",
      isDefault: false,
      status: "offline",
      detail: null,
    },
  ];

  const text = diagnosticReportText(report({ printers }));
  assert.match(text, /DNP DS-RX1/);
  assert.match(text, /bawaan, ready/);
  assert.match(text, /offline/);
});

test("laporan tanpa printer tetap menyebutnya jelas", () => {
  const text = diagnosticReportText(report({ printers: [] }));
  assert.match(text, /Tidak ada printer terdeteksi/);
});

test("nama berkas lampiran aman dipakai di semua OS", () => {
  const name = diagnosticFileName(report());
  const stem = name.replace(/\.json$/, "");
  assert.equal(name.endsWith(".json"), true);
  assert.equal(stem.includes(":"), false);
  assert.equal(stem.includes("."), false, "titik di tengah nama bisa menyamar jadi ekstensi");
  assert.match(name, /^diagnostik-foto-booth-.*\.json$/);
});

test("JSON dan teks dibangun dari objek yang sama — tidak bisa berbeda isi", () => {
  const r = report({ notes: ["uji"] });
  const text = diagnosticReportText(r);
  assert.match(text, new RegExp(r.appVersion));
  assert.match(text, new RegExp(r.generatedAt.replaceAll(/[:.]/g, ".")));
});
