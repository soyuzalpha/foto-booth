/**
 * Tes pembungkus `MediaRecorder`.
 *
 * Yang dijaga: `stop()` **selalu** mengembalikan `Blob` (tidak pernah melempar),
 * data yang sudah terkumpul tidak dibuang kalau perekam error, batas durasi
 * benar-benar menghentikan rekaman tanpa bantuan UI, dan `stop()` ganda aman.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createVideoRecorder,
  type RecorderDeps,
  type RecorderLike,
  type RecorderOptions,
} from "./recorder.ts";

const STREAM = {} as unknown as MediaStream;

/** Perekam palsu yang bisa disuruh error / stop dari tes. */
function fakeRecorder(): RecorderLike & {
  started: number[];
  stopCalls: number;
  emitData(size: number): void;
  emitError(): void;
  options: RecorderOptions | null;
} {
  let state = "inactive";
  const self = {
    get state(): string {
      return state;
    },
    started: [] as number[],
    stopCalls: 0,
    options: null as RecorderOptions | null,
    ondataavailable: null as ((event: { data: Blob }) => void) | null,
    onstop: null as ((event?: unknown) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    start(timesliceMs?: number) {
      state = "recording";
      self.started.push(timesliceMs ?? 0);
    },
    stop() {
      self.stopCalls += 1;
      state = "inactive";
      self.onstop?.();
    },
    emitData(size: number) {
      self.ondataavailable?.({ data: new Blob([new Uint8Array(size)], { type: "video/webm" }) });
    },
    emitError() {
      self.onerror?.(new Error("device hilang"));
    },
  };
  return self;
}

/** Deps dengan penjadwal palsu supaya batas durasi bisa diuji tanpa timer nyata. */
function depsFor(recorder: RecorderLike): { deps: RecorderDeps; fire(): void; pending(): number } {
  const scheduled: { fn: () => void; ms: number }[] = [];
  const deps: RecorderDeps = {
    createRecorder: (_stream, options) => {
      if ("options" in recorder) (recorder as unknown as { options: RecorderOptions | null }).options = options;
      return recorder;
    },
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return () => {
        const index = scheduled.findIndex((entry) => entry.fn === fn);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
  };

  return {
    deps,
    fire() {
      const entry = scheduled.shift();
      entry?.fn();
    },
    pending: () => scheduled.length,
  };
}

test("stop() tanpa start() mengembalikan Blob kosong, bukan error", async () => {
  const recorder = createVideoRecorder({ createRecorder: () => fakeRecorder() }, {
    stream: STREAM,
    mimeType: "video/mp4",
    bitrateBps: 1_000_000,
    audioBitrateBps: 0,
  });

  const blob = await recorder.stop();
  assert.ok(blob instanceof Blob);
  assert.equal(blob.size, 0);
});

test("rekaman normal: chunk terkumpul & digabung jadi satu Blob", async () => {
  const fake = fakeRecorder();
  const { deps } = depsFor(fake);
  const recorder = createVideoRecorder(deps, {
    stream: STREAM,
    mimeType: "video/mp4",
    bitrateBps: 2_000_000,
    audioBitrateBps: 0,
  });

  recorder.start();
  assert.equal(recorder.recording, true);
  fake.emitData(100);
  fake.emitData(50);
  assert.equal(recorder.chunkCount, 2);

  const blob = await recorder.stop();
  assert.equal(blob.size, 150);
  assert.equal(blob.type, "video/mp4");
  assert.equal(recorder.recording, false);
});

test("start() idempoten: panggilan kedua tidak membuat perekam baru", () => {
  const fake = fakeRecorder();
  let created = 0;
  const deps: RecorderDeps = {
    createRecorder: () => {
      created += 1;
      return fake;
    },
  };
  const recorder = createVideoRecorder(deps, {
    stream: STREAM,
    mimeType: null,
    bitrateBps: 1,
    audioBitrateBps: 0,
  });

  recorder.start();
  recorder.start();
  assert.equal(created, 1);
});

test("audio dimatikan → tidak ada audioBitsPerSecond yang diminta", () => {
  const fake = fakeRecorder();
  const { deps } = depsFor(fake);
  const recorder = createVideoRecorder(deps, {
    stream: STREAM,
    mimeType: null,
    bitrateBps: 1_000,
    audioBitrateBps: 0,
  });

  recorder.start();
  assert.equal(fake.options?.audioBitsPerSecond, undefined);
  assert.equal(fake.options?.videoBitsPerSecond, 1_000);
});

test("audio dinyalakan → audioBitsPerSecond diteruskan", () => {
  const fake = fakeRecorder();
  const { deps } = depsFor(fake);
  const recorder = createVideoRecorder(deps, {
    stream: STREAM,
    mimeType: null,
    bitrateBps: 1_000,
    audioBitrateBps: 128_000,
  });

  recorder.start();
  assert.equal(fake.options?.audioBitsPerSecond, 128_000);
});

test("createRecorder yang melempar tidak menjalar ke pemanggil", async () => {
  const recorder = createVideoRecorder(
    {
      createRecorder: () => {
        throw new Error("format ditolak");
      },
    },
    { stream: STREAM, mimeType: "video/aneh", bitrateBps: 1, audioBitrateBps: 0 },
  );

  assert.doesNotThrow(() => recorder.start());
  assert.equal(recorder.recording, false);
  const blob = await recorder.stop();
  assert.equal(blob.size, 0);
});

test("perekam error: hasil yang sudah ada tetap dikembalikan", async () => {
  const fake = fakeRecorder();
  const { deps } = depsFor(fake);
  const recorder = createVideoRecorder(deps, {
    stream: STREAM,
    mimeType: null,
    bitrateBps: 1,
    audioBitrateBps: 0,
  });

  recorder.start();
  fake.emitData(80);

  const pending = recorder.stop();
  fake.emitError();
  const blob = await pending;

  assert.equal(blob.size, 80, "data yang sudah terkumpul tidak dibuang");
});

test("batas durasi menghentikan rekaman sendiri", async () => {
  const fake = fakeRecorder();
  const { deps, fire, pending } = depsFor(fake);
  const recorder = createVideoRecorder(deps, {
    stream: STREAM,
    mimeType: null,
    bitrateBps: 1,
    audioBitrateBps: 0,
    maxDurationMs: 5_000,
  });

  recorder.start();
  fake.emitData(10);
  assert.equal(pending(), 1, "batas durasi dijadwalkan");

  fire();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fake.stopCalls, 1, "perekam dihentikan oleh batas durasi");
});

test("stop() dua kali tidak melempar & tidak menggandakan data", async () => {
  const fake = fakeRecorder();
  const { deps } = depsFor(fake);
  const recorder = createVideoRecorder(deps, {
    stream: STREAM,
    mimeType: null,
    bitrateBps: 1,
    audioBitrateBps: 0,
  });

  recorder.start();
  fake.emitData(30);

  const first = recorder.stop();
  const second = recorder.stop();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.size, 30);
  assert.equal(b.size, 30, "pemanggil kedua mendapat hasil yang sama");
  assert.equal(fake.stopCalls, 1);
});

test("timeslice diteruskan ke perekam", () => {
  const fake = fakeRecorder();
  const { deps } = depsFor(fake);
  const recorder = createVideoRecorder(deps, {
    stream: STREAM,
    mimeType: null,
    bitrateBps: 1,
    audioBitrateBps: 0,
    timesliceMs: 1_000,
  });

  recorder.start();
  assert.deepEqual(fake.started, [1_000]);
});

test("tanpa timeslice, start() dipanggil tanpa argumen", () => {
  const fake = fakeRecorder();
  const { deps } = depsFor(fake);
  const recorder = createVideoRecorder(deps, {
    stream: STREAM,
    mimeType: null,
    bitrateBps: 1,
    audioBitrateBps: 0,
  });

  recorder.start();
  assert.deepEqual(fake.started, [0]);
});
