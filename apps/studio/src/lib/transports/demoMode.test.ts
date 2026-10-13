/**
 * Tes `demoSpecs` — janji yang dijaga di sini: mode demo hanya aktif kalau
 * diminta, dan perangkat yang dikembalikan sesuai permintaan.
 *
 * Yang mudah salah dan karena itu diuji: `?fake` tanpa nilai (URLSearchParams
 * mengembalikan `""`, bukan `null`) tetap harus berarti "pakai mode demo".
 * Kalau kasus itu terlewat, tautan `?fake` yang ditulis di komentar aplikasi
 * justru tidak melakukan apa-apa.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { demoSpecs, DEMO_PARAM } from "./demoMode.ts";
import { FAKE_CAPTURE_CARD, FAKE_DEVICES, FAKE_WEBCAM } from "./fakeTransport.ts";

test("tanpa parameter, mode demo tidak diminta", () => {
  assert.equal(demoSpecs(""), null);
  assert.equal(demoSpecs("?locale=en"), null);
  // Nama parameter lain yang mirip tidak boleh ikut memicu.
  assert.equal(demoSpecs("?fakecam=webcam"), null);
});

test("nama parameter query yang dipakai adalah `fake`", () => {
  assert.equal(DEMO_PARAM, "fake");
});

test("?fake=webcam hanya memakai webcam palsu", () => {
  assert.deepEqual(demoSpecs("?fake=webcam"), [FAKE_WEBCAM]);
});

test("?fake=capture-card dan alias hdmi memakai capture card palsu", () => {
  assert.deepEqual(demoSpecs("?fake=capture-card"), [FAKE_CAPTURE_CARD]);
  assert.deepEqual(demoSpecs("?fake=hdmi"), [FAKE_CAPTURE_CARD]);
});

test("nilai besar/kecil huruf dan spasi tidak mengubah arti", () => {
  assert.deepEqual(demoSpecs("?fake=WebCam"), [FAKE_WEBCAM]);
  assert.deepEqual(demoSpecs("?fake=%20capture-card%20"), [FAKE_CAPTURE_CARD]);
});

test("?fake tanpa nilai tetap berarti mode demo, dan memakai semua perangkat", () => {
  assert.deepEqual(demoSpecs("?fake"), FAKE_DEVICES);
  assert.deepEqual(demoSpecs("?fake="), FAKE_DEVICES);
});

test("nilai tak dikenal jatuh ke semua perangkat palsu, bukan diabaikan", () => {
  assert.deepEqual(demoSpecs("?fake=1"), FAKE_DEVICES);
  assert.deepEqual(demoSpecs("?fake=all"), FAKE_DEVICES);
  assert.deepEqual(demoSpecs("?fake=kamera-hantu"), FAKE_DEVICES);
});

test("parameter lain di sekitar `fake` tidak mengganggu", () => {
  assert.deepEqual(demoSpecs("?a=1&fake=webcam&b=2"), [FAKE_WEBCAM]);
  assert.deepEqual(demoSpecs("?fake=webcam&fake=capture-card"), [FAKE_WEBCAM]);
});

test("search tanpa tanda tanya juga diterima", () => {
  assert.deepEqual(demoSpecs("fake=webcam"), [FAKE_WEBCAM]);
});
