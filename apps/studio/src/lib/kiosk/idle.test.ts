/**
 * Tes idle reset kiosk.
 *
 * Semua nilai waktu eksplisit: tidak ada `setTimeout` di tes, jadi hasilnya
 * angka yang bisa dibandingkan persis.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IDLE_DEFAULT_CONFIG,
  IDLE_MAX_TIMEOUT_MS,
  IDLE_MIN_TIMEOUT_MS,
  idleSecondsRemaining,
  idleStatus,
  initialIdleState,
  normalizeIdleConfig,
  noteActivity,
  resumeIdle,
  suspendIdle,
} from "./idle.ts";

const CONFIG = { timeoutMs: 90_000, warningMs: 15_000 };
const T0 = 1_000_000;

test("normalizeIdleConfig mengisi default dan menjepit ke rentang aman", () => {
  assert.deepEqual(normalizeIdleConfig(), IDLE_DEFAULT_CONFIG);
  assert.equal(normalizeIdleConfig({ timeoutMs: 1 }).timeoutMs, IDLE_MIN_TIMEOUT_MS);
  assert.equal(normalizeIdleConfig({ timeoutMs: 99_999_999 }).timeoutMs, IDLE_MAX_TIMEOUT_MS);
  assert.equal(normalizeIdleConfig({ timeoutMs: Number.NaN }).timeoutMs, IDLE_MIN_TIMEOUT_MS);
});

test("peringatan tidak pernah lebih panjang dari batasnya", () => {
  const config = normalizeIdleConfig({ timeoutMs: 20_000, warningMs: 999_999 });
  assert.equal(config.warningMs, 20_000);
});

test("status tetap active selama masih jauh dari batas", () => {
  const state = initialIdleState(T0);
  const status = idleStatus(CONFIG, state, T0 + 10_000);

  assert.equal(status.phase, "active");
  assert.equal(status.remainingMs, 80_000);
  assert.equal(status.warningInMs, 65_000);
  assert.equal(status.expired, false);
});

test("status naik ke warning tepat saat sisa == warningMs", () => {
  const state = initialIdleState(T0);

  assert.equal(idleStatus(CONFIG, state, T0 + 74_999).phase, "active", "1 ms sebelum warning");
  assert.equal(idleStatus(CONFIG, state, T0 + 75_000).phase, "warning", "tepat di ambang");
  assert.equal(idleStatus(CONFIG, state, T0 + 89_999).phase, "warning");
});

test("status menjadi expired tepat saat sisa == 0", () => {
  const state = initialIdleState(T0);

  assert.equal(idleStatus(CONFIG, state, T0 + 90_000).phase, "expired");
  assert.equal(idleStatus(CONFIG, state, T0 + 90_000).remainingMs, 0);
});

test("expired hanya true pada tepi pertama — aksi reset tidak diulang", () => {
  const state = initialIdleState(T0);

  const first = idleStatus(CONFIG, state, T0 + 90_001);
  assert.equal(first.expired, true, "tepi pertama");

  const second = idleStatus(CONFIG, state, T0 + 91_000, first);
  assert.equal(second.expired, false, "tick berikutnya tidak mengulang aksi");
  assert.equal(second.phase, "expired");
});

test("aktivitas operator memulai ulang hitungan", () => {
  const state = initialIdleState(T0);
  const afterIdle = idleStatus(CONFIG, state, T0 + 80_000);
  assert.equal(afterIdle.phase, "warning");

  const touched = noteActivity(state, T0 + 80_000);
  const afterTouch = idleStatus(CONFIG, touched, T0 + 80_000);
  assert.equal(afterTouch.phase, "active");
  assert.equal(afterTouch.remainingMs, 90_000);
});

test("aktivitas pada waktu yang sama tidak membuat state baru", () => {
  const state = initialIdleState(T0);
  assert.equal(noteActivity(state, T0), state);
});

test("selama ditahan, hitungan tidak pernah expired walau waktu jauh lewat", () => {
  const state = suspendIdle(initialIdleState(T0), T0);
  const status = idleStatus(CONFIG, state, T0 + 10_000_000);

  assert.equal(status.phase, "active");
  assert.equal(status.expired, false);
  assert.equal(status.remainingMs, CONFIG.timeoutMs);
});

test("setelah dilepas, hitungan mulai dari waktu pelepasan", () => {
  const suspended = suspendIdle(initialIdleState(T0), T0);
  const released = resumeIdle(suspended, T0 + 300_000);

  assert.equal(released.suspended, false);
  assert.equal(idleStatus(CONFIG, released, T0 + 300_000).remainingMs, 90_000);
  assert.equal(idleStatus(CONFIG, released, T0 + 390_000).phase, "expired");
});

test("suspend/resume idempoten", () => {
  const state = initialIdleState(T0);
  const once = suspendIdle(state, T0 + 5);
  assert.equal(suspendIdle(once, T0 + 9), once);
  assert.equal(resumeIdle(state, T0 + 9), state);
});

test("idleSecondsRemaining membulatkan ke atas dan berhenti di 0", () => {
  const state = initialIdleState(T0);

  assert.equal(idleSecondsRemaining(idleStatus(CONFIG, state, T0)), 90);
  assert.equal(idleSecondsRemaining(idleStatus(CONFIG, state, T0 + 1_500)), 89);
  assert.equal(idleSecondsRemaining(idleStatus(CONFIG, state, T0 + 90_000)), 0);
});
