/**
 * Tes deteksi printer per runtime (Fase 12, #45/#80/#88).
 *
 * Yang paling berbahaya kalau salah: menjawab "tidak ada printer" di perangkat
 * yang bisa mencetak (operator berhenti mencari), atau menjawab "ready" pada
 * printer yang cuma tersambung kabelnya (kiosk mencetak ke tempat yang salah).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectPrinters,
  detectRuntime,
  mergePrinters,
  normalizeBridgePrinters,
  normalizeElectronStatus,
  normalizeUsbPrinters,
  virtualPrinterFor,
  type BridgePrinter,
  type DesktopBridge,
} from "./printerRuntime.ts";

test("status Electron: idle & sibuk sama-sama siap", () => {
  // Printer yang sedang mencetak bukan alasan menolak pekerjaan berikutnya.
  assert.equal(normalizeElectronStatus(1), "ready");
  assert.equal(normalizeElectronStatus(2), "ready");
});

test("status Electron: keadaan bermasalah jadi offline, 0 jadi unknown", () => {
  assert.equal(normalizeElectronStatus(3), "offline");
  assert.equal(normalizeElectronStatus(4), "offline");
  assert.equal(normalizeElectronStatus(5), "offline");
  assert.equal(normalizeElectronStatus(0), "unknown");
  assert.equal(normalizeElectronStatus(undefined), "unknown");
  assert.equal(normalizeElectronStatus(null), "unknown");
  assert.equal(normalizeElectronStatus(99), "unknown");
});

test("status Electron berupa teks juga diterima", () => {
  assert.equal(normalizeElectronStatus("idle"), "ready");
  assert.equal(normalizeElectronStatus("Printing"), "ready");
  assert.equal(normalizeElectronStatus("offline"), "offline");
  assert.equal(normalizeElectronStatus("Stopped"), "offline");
});

test("printer Electron tanpa nama dibuang, bukan jadi entri kosong", () => {
  // Data dari IPC bisa saja cacat — jangan sampai entri kosong muncul di panel.
  const bridge: BridgePrinter[] = [
    { name: "DNP DS-RX1", isDefault: true, status: 1 },
    { name: "", status: 1 },
    { status: 1 } as unknown as BridgePrinter,
  ];

  const printers = normalizeBridgePrinters(bridge);
  assert.equal(printers.length, 1);
  assert.equal(printers[0]?.id, "DNP DS-RX1");
  assert.equal(printers[0]?.isDefault, true);
  assert.equal(printers[0]?.transport, "electron");
});

test("nama tampilan dipakai kalau ada; kalau kosong jatuh ke nama sistem", () => {
  const printers = normalizeBridgePrinters([
    { name: "HP_Office", displayName: "Printer Depan", status: 1 },
    { name: "HP_Belakang", displayName: "", status: 1 },
  ]);
  assert.equal(printers[0]?.name, "Printer Depan");
  assert.equal(printers[1]?.name, "HP_Belakang");
});

test("WebUSB: perangkat kelas printer masuk, keyboard tidak", () => {
  const printers = normalizeUsbPrinters([
    { vendorId: 0x04b8, productId: 0x0005, deviceClass: 7, productName: "EPSON TM-T82" },
    { vendorId: 0x046d, productId: 0xc31c, deviceClass: 3, productName: "Keyboard K380" },
  ]);

  assert.equal(printers.length, 1);
  assert.equal(printers[0]?.id, "usb:04b8:0005");
  assert.equal(printers[0]?.transport, "webusb");
});

test("WebUSB: status selalu unknown — kabel tersambung bukan berarti siap cetak", () => {
  const printers = normalizeUsbPrinters([
    { vendorId: 0x04b8, productId: 0x0005, deviceClass: 7, productName: "Receipt Printer" },
  ]);
  assert.equal(printers[0]?.status, "unknown");
});

test("WebUSB: perangkat tanpa nama tetap punya label yang bisa dibaca", () => {
  const printers = normalizeUsbPrinters([
    { vendorId: 0x1a86, productId: 0x7523, deviceClass: 7, productName: null },
  ]);
  assert.equal(printers[0]?.name, "Perangkat USB 1a86:7523");
});

test("WebUSB: perangkat yang cuma cocok nama ditandai (dugaan)", () => {
  const printers = normalizeUsbPrinters([
    { vendorId: 0x0001, productId: 0x0002, deviceClass: 0, productName: "Zebra ZD220" },
  ]);
  assert.equal(printers.length, 1);
  assert.match(printers[0]?.detail ?? "", /dugaan/);
});

test("deteksi runtime memilih yang paling kaya", () => {
  assert.equal(
    detectRuntime({ hasDesktopBridge: true, hasUsb: true, isCapacitor: false, hasPrint: true }),
    "electron",
  );
  assert.equal(
    detectRuntime({ hasDesktopBridge: false, hasUsb: true, isCapacitor: false, hasPrint: true }),
    "webusb",
  );
  assert.equal(
    detectRuntime({ hasDesktopBridge: false, hasUsb: false, isCapacitor: false, hasPrint: true }),
    "browser",
  );
  assert.equal(
    detectRuntime({ hasDesktopBridge: false, hasUsb: false, isCapacitor: true, hasPrint: false }),
    "capacitor",
  );
  assert.equal(
    detectRuntime({ hasDesktopBridge: false, hasUsb: false, isCapacitor: false, hasPrint: false }),
    "none",
  );
});

test("merge: printer yang sama dari Electron & WebUSB tidak dobel", () => {
  const merged = mergePrinters([
    [
      {
        id: "EPSON TM-T82",
        name: "EPSON TM-T82",
        transport: "electron",
        isDefault: true,
        status: "ready",
        detail: null,
      },
    ],
    [
      {
        id: "usb:04b8:0005",
        name: "EPSON TM-T82",
        transport: "webusb",
        isDefault: false,
        status: "unknown",
        detail: null,
      },
    ],
  ]);

  assert.equal(merged.length, 1, "satu printer fisik = satu entri");
  assert.equal(merged[0]?.transport, "electron", "versi Electron menang: punya status sungguhan");
});

test("dua printer berbeda dengan nama tampilan sama tetap terpisah", () => {
  // Electron bisa melaporkan nama tampilan yang sama untuk dua perangkat
  // berbeda (mis. dua unit model identik). Menggabungkannya akan menyembunyikan
  // salah satu dari operator — dan operator mencetak ke yang salah.
  const merged = mergePrinters([
    [
      {
        id: "device-a",
        name: "Printer Lab",
        transport: "electron",
        isDefault: false,
        status: "ready",
        detail: null,
      },
      {
        id: "device-b",
        name: "Printer  Lab",
        transport: "electron",
        isDefault: false,
        status: "ready",
        detail: null,
      },
    ],
  ]);
  assert.equal(merged.length, 2, "id berbeda di transport sama = dua perangkat");
});

test("collect: Electron yang melempar tidak mengosongkan daftar WebUSB", async () => {
  const bridge: DesktopBridge = {
    getPrinters: async () => {
      throw new Error("jembatan mati");
    },
  };

  const result = await collectPrinters({
    bridge,
    listUsbDevices: async () => [
      { vendorId: 0x04b8, productId: 0x0005, deviceClass: 7, productName: "EPSON" },
    ],
  });

  assert.equal(result.printers.length, 1);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? "", /jembatan mati/);
});

test("collect: browser biasa dapat satu printer virtual, bukan daftar kosong", async () => {
  const result = await collectPrinters({ hasPrint: true });
  assert.equal(result.transport, "browser");
  assert.equal(result.printers.length, 1);
  assert.equal(result.printers[0]?.id, virtualPrinterFor("browser").id);
});

test("collect: runtime tanpa jalur cetak sama sekali → daftar kosong, jujur", async () => {
  const result = await collectPrinters({ hasPrint: false });
  assert.equal(result.transport, "none");
  assert.equal(result.printers.length, 0);
});

test("collect: Capacitor dapat printer virtual kalau tidak ada sumber lain", async () => {
  const result = await collectPrinters({ isCapacitor: true, hasPrint: true });
  assert.equal(result.printers.length, 1);
  assert.equal(result.printers[0]?.transport, "browser", "capitan didahulukan kalau print ada");
});

test("collect: USB tanpa izin (getDevices kosong) tidak menandai kegagalan", async () => {
  const result = await collectPrinters({ listUsbDevices: async () => [], hasPrint: true });
  assert.deepEqual(result.problems, []);
  assert.equal(result.transport, "webusb");
  assert.equal(result.printers.length, 0, "tanpa entri virtual: WebUSB ada tapi belum ada izin");
});
