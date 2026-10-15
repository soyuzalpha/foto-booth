/**
 * Tes layar hasil kiosk (#51 tombol tamu, #52 peringatan keluar).
 *
 * Yang dijaga di sini bukan tampilan, melainkan aturan produknya: tombol yang
 * mati tidak boleh muncul walau namanya ada di konfigurasi, dan peringatan
 * keluar tidak boleh muncul saat keluar memang aman (layar tarik, atau prompt
 * PIN yang sedang terbuka).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RESULT_ACTION_ORDER,
  exitWarningReason,
  shouldShowResultScreen,
  visibleResultActions,
} from "./resultActions.ts";
import { KIOSK_DEFAULT_CONFIG } from "./kioskConfig.ts";

test("tombol tamu mengikuti konfigurasi, bukan daftar tetap", () => {
  assert.deepEqual(visibleResultActions({ gallery: true, print: true, share: true }), [
    "print",
    "gallery",
    "share",
  ]);
  assert.deepEqual(visibleResultActions({ gallery: false, print: true, share: false }), ["print"]);
});

test("tombol yang mati tidak muncul — termasuk saat semuanya mati", () => {
  assert.deepEqual(visibleResultActions({ gallery: false, print: false, share: false }), []);
  assert.deepEqual(visibleResultActions(null), []);
  assert.deepEqual(visibleResultActions(undefined), []);
});

test("hanya `true` yang menyalakan tombol", () => {
  // Konfigurasi bisa datang dari localStorage yang sudah dimainkan tangan;
  // nilai truthy palsu tidak boleh membuka tombol yang sengaja dimatikan.
  const smuggled = { gallery: "true", print: 1, share: true } as unknown as KioskButtonsLike;
  assert.deepEqual(visibleResultActions(smuggled), ["share"]);
});

test("urutan tampil: cetak dulu, berbagi paling akhir", () => {
  assert.deepEqual(RESULT_ACTION_ORDER, ["print", "gallery", "share"]);
});

test("layar hasil hanya untuk tamu: kiosk aktif, sesi selesai, belum dibuka PIN", () => {
  assert.equal(
    shouldShowResultScreen({ kioskEnabled: true, finished: true, unlocked: false }),
    true,
  );
  assert.equal(
    shouldShowResultScreen({ kioskEnabled: false, finished: true, unlocked: false }),
    false,
    "di luar kiosk panel operator yang tampil",
  );
  assert.equal(
    shouldShowResultScreen({ kioskEnabled: true, finished: false, unlocked: false }),
    false,
    "sesi belum diterima",
  );
  assert.equal(
    shouldShowResultScreen({ kioskEnabled: true, finished: true, unlocked: true }),
    false,
    "PIN sudah dibuka — layar kembali milik operator",
  );
});

test("keluar dari kiosk tidak perlu peringatan kalau tidak ada yang hilang", () => {
  assert.equal(
    exitWarningReason({
      enabled: false,
      showAttract: false,
      locked: false,
      sessionRunning: false,
      hasSaved: false,
    }),
    null,
  );
  assert.equal(
    exitWarningReason({
      enabled: true,
      showAttract: true,
      locked: false,
      sessionRunning: false,
      hasSaved: false,
    }),
    null,
    "layar tarik: belum ada pekerjaan",
  );
  assert.equal(
    exitWarningReason({
      enabled: true,
      showAttract: false,
      locked: true,
      sessionRunning: true,
      hasSaved: true,
    }),
    null,
    "prompt PIN sudah menahan keluar — jangan menumpuk dialog",
  );
});

test("peringatan menyebut sebabnya: sesi jalan menang atas alasan umum", () => {
  assert.equal(
    exitWarningReason({
      enabled: true,
      showAttract: false,
      locked: false,
      sessionRunning: true,
      hasSaved: false,
    }),
    "session",
  );
  assert.equal(
    exitWarningReason({
      enabled: true,
      showAttract: false,
      locked: false,
      sessionRunning: false,
      hasSaved: true,
    }),
    "session",
    "foto yang sudah diambil juga bisa hilang dari layar tamu",
  );
  assert.equal(
    exitWarningReason({
      enabled: true,
      showAttract: false,
      locked: false,
      sessionRunning: false,
      hasSaved: false,
    }),
    "kiosk",
  );
});

/** Bentuk konfigurasi tombol yang dipakai tes "hanya `true`". */
type KioskButtonsLike = { gallery: boolean; print: boolean; share: boolean };

test("bawaan kiosk menyalakan tombol cetak saja", () => {
  // Kontrak lintas modul: layar hasil membaca `KioskButtons`, dan bawaan itu
  // datang dari `kioskConfig`. Kalau salah satu berubah tanpa yang lain,
  // tombol tamu bisa diam-diam hilang — tes ini yang menahannya.
  assert.deepEqual(visibleResultActions(KIOSK_DEFAULT_CONFIG.buttons), ["print"]);
});
