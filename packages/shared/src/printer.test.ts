/**
 * Tes kemampuan printer & pemilihannya (Fase 12, #45/#80).
 *
 * Yang diuji di sini adalah **keputusan**, bukan daftar: printer mana yang
 * dipakai, dan kapan aplikasi harus menolak mencetak. Salah di sini tidak
 * terlihat di layar — lembar hanya tidak keluar, atau keluar di printer yang
 * salah, di tengah acara.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRINTER_DEFAULT_PREF,
  USB_PRINTER_CLASS,
  USB_VENDOR_CLASS,
  choosePrinter,
  classifyUsbPrinter,
  isPrinterStatus,
  isPrinterTransport,
  parsePrinterPreference,
  printerIsUsable,
  serializePrinterPreference,
  summarizePrinters,
  type PrinterInfo,
} from "./printer.ts";

function printer(over: Partial<PrinterInfo> = {}): PrinterInfo {
  return {
    id: "p1",
    name: "Printer 1",
    transport: "electron",
    isDefault: false,
    status: "ready",
    detail: null,
    ...over,
  };
}

test("pilihan operator menang atas printer bawaan sistem", () => {
  const printers = [
    printer({ id: "sys", name: "Sistem", isDefault: true }),
    printer({ id: "opsi", name: "Pilihan operator" }),
  ];

  assert.equal(choosePrinter(printers, "opsi")?.id, "opsi");
});

test("printer yang dipilih tapi sudah tidak ada → jatuh ke aturan bawaan, bukan null", () => {
  // Kiosk dipindah ke komputer lain: printer pilihan lama tidak ada di sini.
  // Menolak mencetak sama sekali akan lebih buruk daripada memakai bawaan.
  const printers = [printer({ id: "sys", isDefault: true }), printer({ id: "lain" })];
  assert.equal(choosePrinter(printers, "sudah-hilang")?.id, "sys");
});

test("badan pasti: tanpa printer sama sekali → null, bukan objek kosong", () => {
  assert.equal(choosePrinter([]), null);
  assert.equal(choosePrinter([], "apa saja"), null);
});

test("printer offline tidak dipilih kalau ada yang ready", () => {
  const printers = [
    printer({ id: "mati", isDefault: true, status: "offline" }),
    printer({ id: "hidup", status: "ready" }),
  ];
  assert.equal(choosePrinter(printers)?.id, "hidup");
});

test("kalau semua printer offline, satu tetap dikembalikan supaya operator bisa melihatnya", () => {
  // Membedakan "tidak ada printer" dari "printer ada tapi mati" itu penting:
  // pesan ke operatornya berbeda, dan yang kedua bisa diperbaiki di tempat.
  const printers = [printer({ id: "mati", status: "offline" })];
  const chosen = choosePrinter(printers);
  assert.equal(chosen?.id, "mati");
  assert.equal(printerIsUsable(chosen), false);
});

test("status yang tidak dilaporkan dianggap bisa dipakai, bukan mati", () => {
  // Electron di Linux sering tidak melaporkan status. Menganggapnya mati akan
  // mematikan auto-print di kiosk yang sebenarnya sehat.
  const printers = [printer({ status: "unknown" })];
  assert.equal(printerIsUsable(choosePrinter(printers)), true);
});

test("ringkasan menghitung siap/mati dan memilih transport terkaya", () => {
  const printers = [
    printer({ id: "a", transport: "browser", status: "ready" }),
    printer({ id: "b", transport: "electron", status: "ready" }),
    printer({ id: "c", transport: "webusb", status: "offline" }),
  ];

  const summary = summarizePrinters(printers);
  assert.equal(summary.total, 3);
  assert.equal(summary.ready, 2);
  assert.equal(summary.offline, 1);
  assert.equal(summary.transport, "electron");
  assert.match(summary.note, /2 dari 3/);
});

test("ringkasan tanpa printer memberi kalimat yang jujur, bukan angka 0 kosong", () => {
  const summary = summarizePrinters([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.transport, "none");
  assert.equal(summary.chosen, null);
  assert.match(summary.note, /Tidak ada printer/);
});

test("USB kelas 7 dikenali sebagai printer dengan yakin", () => {
  const guess = classifyUsbPrinter({ classCode: USB_PRINTER_CLASS });
  assert.equal(guess.isPrinter, true);
  assert.equal(guess.confident, true);
});

test("kelas printer di level interface juga dikenali (device class 0 = lihat interface)", () => {
  // Printer modern sering melaporkan device class 0 dan menaruh kelas
  // sebenarnya di interface. Melewatkan ini = printer umum tidak terdeteksi.
  const guess = classifyUsbPrinter({ classCode: 0, interfaceClass: USB_PRINTER_CLASS });
  assert.equal(guess.isPrinter, true);
  assert.equal(guess.confident, true);
});

test("printer dengan descriptor kosong dikenali dari nama, tapi ditandai tidak yakin", () => {
  const guess = classifyUsbPrinter({ classCode: 0, productName: "EPSON TM-T82 Receipt" });
  assert.equal(guess.isPrinter, true);
  assert.equal(guess.confident, false);
  assert.match(guess.reason, /nama produk/);
});

test("vendor-specific tanpa petunjuk nama TIDAK disebut printer", () => {
  // Menebak terlalu berani di sini membuat panel menjanjikan printer yang
  // ternyata keyboard. Lebih baik operator melihat "tidak pasti".
  const guess = classifyUsbPrinter({ classCode: USB_VENDOR_CLASS });
  assert.equal(guess.isPrinter, false);
  assert.equal(guess.confident, false);
});

test("perangkat non-printer tidak pernah dinyatakan printer", () => {
  for (const classCode of [1, 2, 3, 8, 9, 10, 0xfe]) {
    const guess = classifyUsbPrinter({ classCode, productName: "Generic Device" });
    assert.equal(guess.isPrinter, false, `kelas ${classCode} seharusnya bukan printer`);
  }
});

test("preferensi printer rusak → default, tidak melempar", () => {
  assert.deepEqual(parsePrinterPreference(null), PRINTER_DEFAULT_PREF);
  assert.deepEqual(parsePrinterPreference("{bukan json"), PRINTER_DEFAULT_PREF);
  assert.deepEqual(parsePrinterPreference("[]"), PRINTER_DEFAULT_PREF);
  assert.deepEqual(parsePrinterPreference('{"printerId":42}'), PRINTER_DEFAULT_PREF);
});

test("preferensi printer bolak-balik (serialize → parse) tidak berubah", () => {
  const pref = { printerId: "hp-01", silent: true };
  assert.deepEqual(parsePrinterPreference(serializePrinterPreference(pref)), pref);
});

test("guard tipe menolak nilai asing", () => {
  assert.equal(isPrinterTransport("electron"), true);
  assert.equal(isPrinterTransport("bluetooth"), false);
  assert.equal(isPrinterStatus("ready"), true);
  assert.equal(isPrinterStatus("jammed"), false);
});
