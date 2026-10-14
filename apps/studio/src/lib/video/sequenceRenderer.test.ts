/**
 * Tes adapter animasi.
 *
 * Kanvasnya kanvas palsu yang **benar-benar memindahkan piksel**
 * (`lib/testing/fakeCanvas.ts`), jadi yang diuji bukan "drawImage dipanggil"
 * tapi "piksel frame benar-benar sampai ke kanvas, pada urutan yang benar".
 *
 * Yang dijaga: `containRect` tidak pernah mendistorsi gambar, latar digambar
 * penuh tiap frame (tidak ada jejak frame sebelumnya), dan **kegagalan
 * `captureStream` tidak membatalkan hasil** — tamu tetap menerima berkas.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeCanvas, createFakeSource, pixelAt, type FakeCanvas, type FakeSource } from "../testing/fakeCanvas.ts";
import { containRect, drawFrame, renderAnimation, type StreamableCanvas } from "./sequenceRenderer.ts";
import type { RecorderLike } from "./recorder.ts";

/** Kanvas palsu + `captureStream` opsional (meniru browser tanpa dukungan). */
function streamable(width: number, height: number, withStream = true): StreamableCanvas & FakeCanvas {
  const canvas = createFakeCanvas(width, height);
  const target = canvas as StreamableCanvas & FakeCanvas;
  if (withStream) {
    target.captureStream = () => ({}) as unknown as MediaStream;
  }
  return target;
}

/** Perekam palsu yang mencatat opsi dan bisa dipicu `onstop`. */
function fakeRecorder(): RecorderLike & { options: Record<string, unknown> | null; stopCalls: number } {
  let state = "inactive";
  const self = {
    get state(): string {
      return state;
    },
    options: null as Record<string, unknown> | null,
    stopCalls: 0,
    ondataavailable: null as ((event: { data: Blob }) => void) | null,
    onstop: null as ((event?: unknown) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    start() {
      state = "recording";
    },
    stop() {
      self.stopCalls += 1;
      state = "inactive";
      self.onstop?.();
    },
  };
  return self;
}

/**
 * Frame uji dengan **kanal merah berbeda** — dipakai tes untuk mengenali frame
 * mana yang benar-benar digambar (kanal biru/hijau bisa sama-sama 0).
 */
const FRAMES = [frameWith(10), frameWith(20)];
const THIRD = frameWith(30);

function frameWith(marker: number): FakeSource {
  return createFakeSource(2, 2, () => [marker, 0, 0, 255]);
}

/** Penanda frame: kanal merah sumber yang terakhir digambar. */
function markerOf(image: unknown): number {
  return (image as { pixels?: Uint8ClampedArray }).pixels?.[0] ?? -1;
}

test("containRect menjaga rasio & memusatkan gambar", () => {
  // Gambar 4:1 di kanvas 1:1 → lebar penuh, tinggi seperempat, di tengah.
  assert.deepEqual(containRect(400, 100, 200, 200), { x: 0, y: 75, width: 200, height: 50 });
  // Gambar 1:1 di kanvas 2:1 → tinggi penuh.
  assert.deepEqual(containRect(100, 100, 200, 100), { x: 50, y: 0, width: 100, height: 100 });
});

test("containRect tidak pernah melebihi kanvas", () => {
  const rect = containRect(1920, 1080, 640, 480);
  assert.ok(rect.width <= 640 && rect.height <= 480);
  assert.ok(rect.x >= 0 && rect.y >= 0);
});

test("containRect menahan ukuran gambar nol tanpa NaN", () => {
  const rect = containRect(0, 0, 100, 100);
  for (const value of Object.values(rect)) assert.ok(Number.isFinite(value));
});

test("drawFrame menggambar latar penuh lalu frame di tengah", () => {
  const canvas = streamable(4, 4);
  const frame = frameWith(10);

  assert.equal(drawFrame(canvas, frame, "#000000", { width: 4, height: 4 }), true);
  // Frame 2×2 di kanvas 4×4 → rect 4×4 (diperbesar), jadi tiap piksel frame.
  assert.deepEqual(pixelAt(canvas, 2, 2), [10, 0, 0, 255]);
});

test("drawFrame menempatkan gambar lebar di tengah tanpa distorsi", () => {
  const canvas = streamable(4, 4);
  const wide = createFakeSource(4, 2, () => [10, 0, 0, 255]);

  // Gambar 4:2 di kanvas 4×4 → tinggi separuh, dipusatkan (baris 1–2).
  assert.equal(drawFrame(canvas, wide, "#000000", { width: 4, height: 4 }), true);
  assert.deepEqual(pixelAt(canvas, 1, 0), [0, 0, 0, 255], "baris atas tetap latar");
  assert.deepEqual(pixelAt(canvas, 1, 1), [10, 0, 0, 255], "baris tengah terisi");
  assert.deepEqual(pixelAt(canvas, 1, 3), [0, 0, 0, 255], "baris bawah tetap latar");
});

test("drawFrame menggambar ulang latar tiap kali (tidak ada jejak frame lama)", () => {
  const canvas = streamable(4, 4);
  const solid = createFakeSource(4, 4, () => [10, 0, 0, 255]);
  // Frame kedua sepenuhnya transparan: kalau latar tidak digambar ulang,
  // piksel merah frame pertama akan tertinggal dan tampak sebagai "jejak".
  const clear = createFakeSource(2, 2, () => [0, 0, 0, 0]);

  drawFrame(canvas, solid, "#000000", { width: 4, height: 4 });
  assert.deepEqual(pixelAt(canvas, 0, 0), [10, 0, 0, 255]);

  drawFrame(canvas, clear, "#000000", { width: 4, height: 4 });
  assert.deepEqual(pixelAt(canvas, 0, 0), [0, 0, 0, 255], "latar harus digambar ulang");
  assert.deepEqual(pixelAt(canvas, 3, 3), [0, 0, 0, 255]);
});

test("drawFrame mengembalikan false kalau kanvas tidak punya konteks", () => {
  const broken = { width: 2, height: 2, getContext: () => null } as unknown as StreamableCanvas;
  assert.equal(drawFrame(broken, FRAMES[0], "#000", { width: 2, height: 2 }), false);
});

test("renderAnimation menggambar tiap langkah timeline berurutan", async () => {
  const recorder = fakeRecorder();
  const drawn: number[] = [];
  const waits: number[] = [];

  const result = await renderAnimation(
    {
      createCanvas: (width, height) => {
        const canvas = streamable(width, height);
        const original = canvas.context.drawImage.bind(canvas.context);
        canvas.context.drawImage = (image, ...rest) => {
          drawn.push(markerOf(image));
          original(image, ...rest);
        };
        return canvas;
      },
      createRecorder: (_stream, options) => {
        recorder.options = options as Record<string, unknown>;
        return recorder;
      },
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
    {
      kind: "slideshow",
      frames: FRAMES,
      width: 4,
      height: 4,
      fps: 30,
      bitrateBps: 1_000_000,
      frameMs: 500,
      mimeType: "video/webm",
    },
  );

  assert.deepEqual(drawn, [10, 20], "frame digambar sesuai urutan slideshow");
  assert.deepEqual(waits, [500, 500], "tiap frame ditahan sesuai lama tampil");
  assert.equal(result.drawn, 2);
  assert.equal(result.steps.length, 2);
  assert.equal(recorder.options?.videoBitsPerSecond, 1_000_000);
  assert.equal(recorder.options?.mimeType, "video/webm");
  assert.equal(recorder.stopCalls, 1, "perekam dihentikan di akhir");
});

test("renderAnimation boomerang mengulang urutan ping-pong", async () => {
  const drawn: number[] = [];
  await renderAnimation(
    {
      createCanvas: (width, height) => {
        const canvas = streamable(width, height);
        const original = canvas.context.drawImage.bind(canvas.context);
        canvas.context.drawImage = (image, ...rest) => {
          drawn.push(markerOf(image));
          original(image, ...rest);
        };
        return canvas;
      },
      createRecorder: () => fakeRecorder(),
      wait: () => Promise.resolve(),
    },
    {
      kind: "boomerang",
      frames: [...FRAMES, THIRD],
      width: 4,
      height: 4,
      fps: 30,
      bitrateBps: 1,
      frameMs: 100,
      mimeType: null,
    },
  );

  assert.deepEqual(drawn, [10, 20, 30, 20], "boomerang: maju lalu mundur tanpa mengulang ujung");
});

test("kanvas tanpa captureStream tetap menghasilkan Blob (degradasi anggun)", async () => {
  const result = await renderAnimation(
    {
      createCanvas: (width, height) => streamable(width, height, false),
      createRecorder: () => {
        throw new Error("tidak boleh dipanggil");
      },
      wait: () => Promise.resolve(),
    },
    {
      kind: "slideshow",
      frames: FRAMES,
      width: 4,
      height: 4,
      fps: 30,
      bitrateBps: 1,
      frameMs: 100,
      mimeType: null,
    },
  );

  assert.ok(result.blob instanceof Blob);
  assert.equal(result.drawn, 2, "frame tetap digambar walau tidak bisa direkam");
});

test("foto yang gagal didekode (null) dilewati tanpa menjatuhkan render", async () => {
  const result = await renderAnimation(
    {
      createCanvas: (width, height) => streamable(width, height),
      createRecorder: () => fakeRecorder(),
      wait: () => Promise.resolve(),
    },
    {
      kind: "slideshow",
      // Dua langkah timeline; yang kedua gagal didekode.
      frames: [FRAMES[0], null, THIRD],
      width: 4,
      height: 4,
      fps: 30,
      bitrateBps: 1,
      frameMs: 100,
      mimeType: null,
    },
  );

  assert.equal(result.steps.length, 3, "timeline tetap utuh");
  assert.equal(result.drawn, 2, "hanya foto yang berhasil didekode yang digambar");
});

test("daftar foto kosong tidak melempar", async () => {
  const result = await renderAnimation(
    {
      createCanvas: (width, height) => streamable(width, height),
      createRecorder: () => fakeRecorder(),
      wait: () => Promise.resolve(),
    },
    { kind: "slideshow", frames: [], width: 4, height: 4, fps: 30, bitrateBps: 1, frameMs: 100, mimeType: null },
  );

  assert.equal(result.drawn, 0);
  assert.deepEqual(result.steps, []);
  assert.ok(result.blob instanceof Blob);
});
