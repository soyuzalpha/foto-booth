import test from "node:test";
import assert from "node:assert/strict";

import {
  describeAutoConnectReason,
  pickAutoConnectDevice,
  shouldAutoConnect,
} from "./autoConnect.ts";
import type { CameraDevice } from "../transports/types.ts";

function device(
  id: string,
  source: CameraDevice["source"],
  label = id,
): CameraDevice {
  return {
    id,
    label,
    source,
    classification: { source, score: 0, matched: [], confidence: "default" },
  };
}

test("device terakhir yang diingat menang atas yang lain", () => {
  const devices = [
    device("cam-a", "webcam"),
    device("card-1", "capture-card"),
    device("cam-b", "webcam"),
  ];
  const pick = pickAutoConnectDevice(devices, "cam-b");
  assert.equal(pick.deviceId, "cam-b");
  assert.equal(pick.reason, "remembered");
});

test("device yang diingat tapi sudah dicabut diabaikan, jatuh ke capture card", () => {
  const devices = [device("cam-a", "webcam"), device("card-1", "capture-card")];
  const pick = pickAutoConnectDevice(devices, "hilang");
  assert.equal(pick.deviceId, "card-1");
  assert.equal(pick.reason, "capture-card");
});

test("tanpa device yang diingat, capture card dipilih di atas webcam", () => {
  const devices = [device("cam-a", "webcam"), device("card-1", "capture-card")];
  const pick = pickAutoConnectDevice(devices, null);
  assert.equal(pick.deviceId, "card-1");
  assert.equal(pick.reason, "capture-card");
});

test("tanpa capture card, device pertama dipakai sebagai jaring terakhir", () => {
  const devices = [device("cam-a", "webcam"), device("cam-b", "webcam")];
  const pick = pickAutoConnectDevice(devices, null);
  assert.equal(pick.deviceId, "cam-a");
  assert.equal(pick.reason, "first");
});

test("daftar kosong menghasilkan null, bukan crash", () => {
  const pick = pickAutoConnectDevice([], "apa-saja");
  assert.equal(pick.deviceId, null);
  assert.equal(pick.reason, "none");
});

test("shouldAutoConnect tidak menyambung ulang kalau sudah ada device aktif", () => {
  const devices = [device("cam-a", "webcam")];
  assert.equal(
    shouldAutoConnect({ enabled: true, devices, currentDeviceId: "cam-a" }),
    false,
    "jangan rebut kamera yang sedang dipakai",
  );
  assert.equal(
    shouldAutoConnect({ enabled: true, devices, currentDeviceId: null }),
    true,
  );
});

test("shouldAutoConnect menghormati saklar mati dan daftar kosong", () => {
  const devices = [device("cam-a", "webcam")];
  assert.equal(shouldAutoConnect({ enabled: false, devices, currentDeviceId: null }), false);
  assert.equal(shouldAutoConnect({ enabled: true, devices: [], currentDeviceId: null }), false);
});

test("describeAutoConnectReason menerjemahkan tiap alasan", () => {
  assert.equal(describeAutoConnectReason("remembered"), "kamera terakhir");
  assert.equal(describeAutoConnectReason("capture-card"), "capture card");
  assert.equal(describeAutoConnectReason("first"), "kamera pertama");
  assert.equal(describeAutoConnectReason("none"), "tidak ada kamera");
});
