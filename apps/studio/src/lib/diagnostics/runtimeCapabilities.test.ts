/**
 * Tes pemeriksaan kemampuan runtime (Fase 12, #81).
 *
 * Yang perlu dibuktikan bukan bahwa browser punya WebGL — itu urusan browser —
 * melainkan bahwa **pemeriksaannya sendiri tidak pernah melempar**. Laporan
 * diagnostik dipakai justru saat ada yang rusak; kalau alatnya ikut mati di
 * perangkat aneh, operator kehilangan satu-satunya hal yang bisa dikirim ke
 * teknisi.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_CAPABILITIES, readinessScore } from "@foto-booth/shared";

import {
  detectRuntimeName,
  isSecureContext,
  probeCapabilities,
} from "./runtimeCapabilities.ts";

test("di Node tanpa DOM, semua pemeriksaan mengembalikan bentuk yang sah", () => {
  const caps = probeCapabilities();

  assert.deepEqual(
    Object.keys(caps).sort(),
    Object.keys(EMPTY_CAPABILITIES).sort(),
    "bentuk laporan harus sama dengan kontrak shared",
  );
  for (const [key, value] of Object.entries(caps)) {
    assert.equal(typeof value, "boolean", `${key} harus boolean, bukan ${typeof value}`);
  }
});

test("tanpa DOM tidak ada kemampuan yang diklaim ada", () => {
  const caps = probeCapabilities();
  // Di Node murni tidak ada kamera, canvas, service worker, atau localStorage —
  // mengklaim salah satunya ada berarti laporan berbohong.
  assert.equal(caps.camera, false);
  assert.equal(caps.webgl, false);
  assert.equal(caps.serviceWorker, false);
  assert.equal(caps.storage, false);
  assert.equal(caps.fullscreen, false);
  assert.equal(readinessScore(caps), 0);
});

test("nama runtime membedakan Electron dari browser yang juga punya WebUSB", () => {
  // Electron juga mengekspos `navigator.usb`, jadi tanpa urutan yang benar
  // kiosk paket desktop akan dilaporkan sebagai "Browser".
  assert.equal(detectRuntimeName({ hasDesktopBridge: true, isCapacitor: true }), "Electron (desktop)");
  assert.equal(detectRuntimeName({ hasDesktopBridge: false, isCapacitor: true }), "Capacitor (mobile)");
  assert.equal(detectRuntimeName({ hasDesktopBridge: false, isCapacitor: false }), "Browser");
});

test("secure context dilaporkan apa adanya, tidak ditebak", () => {
  // Node bukan secure context; kiosk di HTTPS/localhost harus `true`.
  assert.equal(isSecureContext(), false);
});
