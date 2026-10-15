/**
 * Tes cetak hasil kiosk (#51).
 *
 * Yang dijaga: rute cetak dipilih sesuai runtime, dan **tidak ada** jalur yang
 * membuat tombol cetak melempar ke komponen React — layar tamu tidak boleh mati
 * hanya karena printer bermasalah.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RESULT_PRINT_TITLE, printResultPhoto, type ResultPrintDeps } from "./resultPrint.ts";
import type { DesktopBridge } from "../print/printerRuntime.ts";

const IMAGE = "data:image/jpeg;base64,AAAA";

interface Recorded {
  html: string;
  deviceName: string | null | undefined;
  silent: boolean | undefined;
}

/** Jembatan palsu yang mencatat permintaan cetak dan bisa disuruh gagal/melempar. */
function bridge(options: { ok?: boolean; reason?: string; throws?: boolean } = {}): {
  bridge: DesktopBridge;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];

  return {
    calls,
    bridge: {
      getPrinters: async () => [],
      printHtml: async (input) => {
        calls.push({
          html: input.html,
          deviceName: input.deviceName,
          silent: input.silent,
        });
        if (options.throws === true) throw new Error("IPC putus");
        return options.ok === false
          ? { ok: false, reason: options.reason ?? "printer sibuk" }
          : { ok: true };
      },
    },
  };
}

function deps(overrides: Partial<ResultPrintDeps> = {}): ResultPrintDeps {
  return {
    bridge: null,
    transport: null,
    deviceName: null,
    silent: false,
    printBrowser: null,
    ...overrides,
  };
}

test("jalur desktop dipakai saat printer bernama dipilih di shell Electron", async () => {
  const fake = bridge();

  const outcome = await printResultPhoto(
    IMAGE,
    deps({
      bridge: fake.bridge,
      transport: "electron",
      deviceName: "DNP DS-RX1",
      silent: true,
    }),
  );

  assert.deepEqual(outcome, { ok: true, route: "desktop" });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.deviceName, "DNP DS-RX1");
  assert.equal(fake.calls[0]?.silent, true, "kiosk tidak boleh memunculkan dialog");
  assert.ok(fake.calls[0]?.html.includes(IMAGE), "gambar ditanam, bukan dirujuk");
  assert.ok(fake.calls[0]?.html.includes(RESULT_PRINT_TITLE));
});

test("kegagalan printer diteruskan sebagai pesan, bukan dilempar", async () => {
  const fake = bridge({ ok: false, reason: "kertas habis" });

  const outcome = await printResultPhoto(
    IMAGE,
    deps({ bridge: fake.bridge, transport: "electron", deviceName: "DNP DS-RX1" }),
  );

  assert.deepEqual(outcome, { ok: false, message: "kertas habis" });
});

test("jembatan yang melempar tidak menjatuhkan layar tamu", async () => {
  const fake = bridge({ throws: true });

  const outcome = await printResultPhoto(
    IMAGE,
    deps({ bridge: fake.bridge, transport: "electron", deviceName: "DNP DS-RX1" }),
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.message, "IPC putus");
});

test("di web jalur browser yang dipakai", async () => {
  const printed: string[] = [];

  const outcome = await printResultPhoto(
    IMAGE,
    deps({
      printBrowser: async (url) => {
        printed.push(url);
      },
    }),
  );

  assert.deepEqual(outcome, { ok: true, route: "browser" });
  assert.deepEqual(printed, [IMAGE]);
});

test("jembatan ada tapi transportnya bukan Electron → jalur browser", async () => {
  const fake = bridge();
  let browserCalls = 0;

  const outcome = await printResultPhoto(
    IMAGE,
    deps({
      bridge: fake.bridge,
      transport: "webusb",
      deviceName: "DNP DS-RX1",
      printBrowser: async () => {
        browserCalls += 1;
      },
    }),
  );

  assert.deepEqual(outcome, { ok: true, route: "browser" });
  assert.equal(fake.calls.length, 0, "printer webusb bukan jalur printHtml");
  assert.equal(browserCalls, 1);
});

test("printer belum dipilih di Electron jatuh ke jalur browser, bukan gagal", async () => {
  const fake = bridge();
  let browserCalls = 0;

  const outcome = await printResultPhoto(
    IMAGE,
    deps({
      bridge: fake.bridge,
      transport: "electron",
      deviceName: null,
      printBrowser: async () => {
        browserCalls += 1;
      },
    }),
  );

  assert.deepEqual(outcome, { ok: true, route: "browser" });
  assert.equal(fake.calls.length, 0);
  assert.equal(browserCalls, 1);
});

test("gambar yang belum siap dilaporkan jujur, bukan dianggap gagal cetak", async () => {
  const outcome = await printResultPhoto(null, deps({ printBrowser: async () => undefined }));

  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.message, "gambar hasil sesi belum siap");
});

test("tanpa jalur cetak sama sekali, hasilnya gagal yang jelas", async () => {
  const outcome = await printResultPhoto(IMAGE, deps());

  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.message, "tidak ada jalur cetak di lingkungan ini");
});
