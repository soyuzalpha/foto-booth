/**
 * Tes sesi rekam video.
 *
 * Yang dijaga: **tanpa format yang didukung, sesi menolak mulai** (UI tidak
 * pernah bilang "merekam" untuk rekaman yang tidak akan menghasilkan berkas),
 * rencana dibekukan saat `start()` (mengubah setelan di tengah tidak mengubah
 * klip yang sedang jalan), dan `stop()` selalu memberi klip — mungkin kosong.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RecorderLike } from "./recorder.ts";
import type { VideoSessionDeps } from "./videoSession.ts";
import { clipHasContent, createVideoSession } from "./videoSession.ts";
import { DEFAULT_VIDEO_SETTINGS, type VideoSettings } from "./types.ts";

const STREAM = {} as unknown as MediaStream;
const SUPPORT_ALL = (): boolean => true;
const SUPPORT_NONE = (): boolean => false;

function fakeRecorder(): RecorderLike & { stopCalls: number; emitData(size: number): void } {
  let state = "inactive";
  const self = {
    get state(): string {
      return state;
    },
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
    emitData(size: number) {
      self.ondataavailable?.({ data: new Blob([new Uint8Array(size)], { type: "video/mp4" }) });
    },
  };
  return self;
}

function deps(recorder = fakeRecorder()): VideoSessionDeps & { recorder: typeof recorder } {
  return { createRecorder: () => recorder, recorder };
}

function settings(overrides: Partial<VideoSettings> = {}): VideoSettings {
  return { ...DEFAULT_VIDEO_SETTINGS, ...overrides };
}

test("tanpa format yang didukung, plan() null dan start() menolak", () => {
  const session = createVideoSession(deps(), {
    settings: settings(),
    stream: STREAM,
    isSupported: SUPPORT_NONE,
  });

  assert.equal(session.plan(), null);
  assert.equal(session.start(), false);
  assert.equal(session.recording, false);
});

test("tanpa stream (kamera tidak ada), start() menolak", () => {
  const session = createVideoSession(deps(), {
    settings: settings(),
    stream: null,
    isSupported: SUPPORT_ALL,
  });

  assert.equal(session.start(), false);
  assert.equal(session.plan()?.extension, "mp4", "rencananya sendiri tetap sah");
});

test("start() lalu stop() menghasilkan klip dengan metadata rencana", async () => {
  const fake = fakeRecorder();
  const session = createVideoSession(deps(fake), {
    settings: settings({ resolution: "1080p" }),
    stream: STREAM,
    isSupported: SUPPORT_ALL,
    index: 1,
    sourceDurationSec: 4,
  });

  assert.equal(session.start(), true);
  assert.equal(session.recording, true);
  fake.emitData(64);

  const clip = await session.stop();
  assert.ok(clip !== null);
  assert.equal(clip.width, 1920);
  assert.equal(clip.height, 1080);
  assert.equal(clip.durationSec, 4);
  assert.equal(clip.extension, "mp4");
  assert.equal(clip.contentType, "video/mp4");
  assert.equal(clip.filename, "video-02.mp4", "nomor urut ikut index");
  assert.equal(clip.index, 1);
  assert.equal(clip.blob.size, 64);
  assert.equal(clipHasContent(clip), true);
});

test("stop() tanpa start() mengembalikan null", async () => {
  const session = createVideoSession(deps(), {
    settings: settings(),
    stream: STREAM,
    isSupported: SUPPORT_ALL,
  });

  assert.equal(await session.stop(), null);
});

test("start() dua kali diabaikan (satu klip per sesi)", () => {
  const fake = fakeRecorder();
  let created = 0;
  const session = createVideoSession(
    {
      createRecorder: () => {
        created += 1;
        return fake;
      },
    },
    { settings: settings(), stream: STREAM, isSupported: SUPPORT_ALL },
  );

  assert.equal(session.start(), true);
  assert.equal(session.start(), false);
  assert.equal(created, 1);
});

test("rencana dibekukan saat start: setelan yang berubah tidak mengubah klip", async () => {
  const fake = fakeRecorder();
  const session = createVideoSession(deps(fake), {
    settings: settings({ resolution: "720p" }),
    stream: STREAM,
    isSupported: SUPPORT_ALL,
  });

  const before = session.plan();
  assert.equal(before?.width, 1280);

  // Operator mengubah resolusi setelah mulai — klip tetap 720p.
  const clip = await (session.start(), session.stop());
  assert.equal(clip?.width, 1280);
});

test("slow-mo memanjangkan durasi klip yang dilaporkan", async () => {
  const session = createVideoSession(deps(), {
    settings: settings({ slowMo: 0.5 }),
    stream: STREAM,
    isSupported: SUPPORT_ALL,
    sourceDurationSec: 6,
  });

  session.start();
  const clip = await session.stop();
  assert.equal(clip?.durationSec, 12);
});

test("klip kosong ditandai tidak berisi", async () => {
  const session = createVideoSession(deps(), {
    settings: settings(),
    stream: STREAM,
    isSupported: SUPPORT_ALL,
  });

  session.start();
  const clip = await session.stop();
  assert.ok(clip !== null);
  assert.equal(clipHasContent(clip), false);
});
