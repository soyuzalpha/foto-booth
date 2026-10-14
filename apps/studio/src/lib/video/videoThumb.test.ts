/**
 * Tes thumbnail video — tanpa browser.
 *
 * Yang diuji di sini bukan "apakah gambarnya bagus" (itu tidak bisa diuji di
 * Node), tapi **keputusan** yang membuatnya tidak hitam dan tidak menggantung:
 * waktu cari menjauhi frame pembuka, sisi panjang dibatasi, dan setiap
 * kegagalan berakhir `null` alih-alih melempar.
 *
 * Dua hal soal tiruan di bawah yang perlu diperhatikan:
 *
 *   · **Event dipicu sinkron.** Browser sungguhan memicunya belakangan, tapi
 *     kalau tiruan ini juga menunda, urutan antara microtask tes dan microtask
 *     kode jadi tidak pasti dan tesnya menggantung. Sinkron = deterministik.
 *   · **Timer tidak pernah jalan sendiri.** `schedule` cuma menyimpan callback;
 *     tes yang memicunya lewat `flush()`. Jadi "metadata tidak datang" bisa
 *     diuji tanpa menunggu 5 detik.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  VIDEO_THUMB_MAX_EDGE,
  makeVideoThumb,
  thumbSeekTime,
  videoThumbSize,
  type ThumbCanvas,
  type ThumbVideoElement,
  type VideoThumbDeps,
} from "./videoThumb.ts";

/** Penjadwal palsu: callback disimpan sampai tes memicunya. */
function makeScheduler() {
  const pending = new Set<() => void>();
  return {
    schedule: (fn: () => void) => {
      pending.add(fn);
      return () => pending.delete(fn);
    },
    flush(): void {
      const all = [...pending];
      pending.clear();
      for (const fn of all) fn();
    },
    get pendingCount(): number {
      return pending.size;
    },
  };
}

/** Video palsu; event dipicu sinkron supaya urutannya pasti. */
function fakeVideo(options: { width?: number; height?: number; duration?: number } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const element = {
    src: "",
    muted: false,
    preload: "",
    duration: options.duration ?? 3,
    videoWidth: options.width ?? 1280,
    videoHeight: options.height ?? 720,
    readyState: 0,
    loadCount: 0,
    removed: false,
    /** Setelan dari tes: apakah `load()` memicu `loadedmetadata`. */
    emitsMetadata: true,
    /** Setelan dari tes: apakah set `currentTime` memicu `seeked`. */
    emitsSeeked: true,
    /** Nilai `currentTime` yang pernah diset — untuk diperiksa tes. */
    seekTimes: [] as number[],
    load() {
      element.loadCount += 1;
      element.readyState = 1;
      if (element.emitsMetadata) element.emit("loadedmetadata");
    },
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: string) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    remove() {
      element.removed = true;
    },
  };

  // `currentTime` sengaja accessor: browser memicu `seeked` setelah nilai
  // diset, dan tiruan ini harus menirunya — kalau tidak, jalur tunggu-seek
  // selalu berakhir di batas waktu dan tesnya menggantung.
  let time = 0;
  Object.defineProperty(element, "currentTime", {
    get: () => time,
    set: (value: number) => {
      time = value;
      element.seekTimes.push(value);
      if (element.emitsSeeked) element.emit("seeked");
    },
    configurable: true,
  });

  return element as unknown as ThumbVideoElement & typeof element;
}

/** Kanvas palsu: mencatat ukuran yang diminta, lalu mengembalikan blob JPEG. */
function fakeCanvas(): ThumbCanvas {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => undefined }),
    toBlob(callback) {
      callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
    },
  };
}

interface Harness {
  deps: VideoThumbDeps;
  video: ReturnType<typeof fakeVideo>;
  scheduler: ReturnType<typeof makeScheduler>;
  canvasSizes: [number, number][];
  revoked: string[];
  drawn: number;
}

function harness(overrides: Partial<VideoThumbDeps> = {}, videoOptions: Parameters<typeof fakeVideo>[0] = {}): Harness {
  const video = fakeVideo(videoOptions);
  const scheduler = makeScheduler();
  const canvasSizes: [number, number][] = [];
  const revoked: string[] = [];
  let drawn = 0;

  const deps: VideoThumbDeps = {
    createVideo: () => video,
    createCanvas: (width, height) => {
      canvasSizes.push([width, height]);
      return {
        ...fakeCanvas(),
        getContext: () => ({
          drawImage: () => {
            drawn += 1;
          },
        }),
      };
    },
    createObjectURL: () => "blob:fake",
    revokeObjectURL: (url) => {
      revoked.push(url);
    },
    schedule: scheduler.schedule,
    ...overrides,
  };

  return {
    deps,
    video,
    scheduler,
    canvasSizes,
    revoked,
    get drawn() {
      return drawn;
    },
  };
}

/** Bandingkan angka pecahan tanpa tersandung representasi biner. */
function closeTo(actual: number, expected: number, epsilon = 1e-9): boolean {
  return Math.abs(actual - expected) <= epsilon;
}

test("thumbSeekTime melewati frame pembuka, bukan mengambil detik ke-0", () => {
  assert.equal(thumbSeekTime(15), 1);
  assert.ok(closeTo(thumbSeekTime(2), 0.2));
  assert.equal(thumbSeekTime(0), 0);
  assert.equal(thumbSeekTime(Number.NaN), 0);
  assert.equal(thumbSeekTime(-4), 0);
});

test("videoThumbSize membatasi sisi panjang dan menjaga rasio", () => {
  assert.deepEqual(videoThumbSize(1280, 720, 512), { width: 512, height: 288 });
  assert.deepEqual(videoThumbSize(480, 360, 512), { width: 480, height: 360 });
  assert.deepEqual(videoThumbSize(0, 0), { width: 0, height: 0 });
});

test("makeVideoThumb menghasilkan blob JPEG, di-mute, dan melepas elemen + URL", async () => {
  const h = harness();
  const blob = await makeVideoThumb(new Blob([new Uint8Array([9])], { type: "video/mp4" }), h.deps);

  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, "image/jpeg");
  assert.equal(h.video.muted, true, "video harus di-mute supaya browser mau memuatnya");
  assert.equal(h.video.removed, true);
  assert.deepEqual(h.revoked, ["blob:fake"]);
  assert.deepEqual(h.canvasSizes, [[512, 288]]);
  assert.equal(h.drawn, 1, "frame digambar tepat sekali");
});

test("makeVideoThumb mencari ke waktu > 0 supaya tidak mengambil frame pembuka", async () => {
  const h = harness();
  const blob = await makeVideoThumb(new Blob([new Uint8Array([1])]), h.deps);
  assert.ok(blob instanceof Blob);
  assert.equal(h.video.seekTimes.length, 1);
  assert.ok(closeTo(h.video.seekTimes[0]!, 0.3), "durasi 3 detik → cari ke 0,3 detik");
});

/**
 * Dorong event loop sampai `promise` selesai, sambil meletuskan timer palsu.
 *
 * Perlu karena `makeVideoThumb` menjadwalkan batas waktunya **setelah** beberapa
 * `await` — jadi `flush()` yang dipanggil terlalu cepat tidak menemukan apa pun
 * dan tesnya menggantung. Batas putaran membuatnya berhenti walau ada bug.
 */
async function drain<T>(promise: Promise<T>, scheduler: ReturnType<typeof makeScheduler>, rounds = 20): Promise<T> {
  let settled = false;
  const tracked = promise.then((value) => {
    settled = true;
    return value;
  });
  for (let i = 0; i < rounds && !settled; i += 1) {
    await Promise.resolve();
    scheduler.flush();
  }
  return tracked;
}

test("makeVideoThumb tetap menggambar walau `seeked` tidak pernah datang", async () => {
  const h = harness();
  h.video.emitsSeeked = false;

  // Tanpa `seeked` kita tetap menggambar frame yang ada — lebih baik daripada
  // tidak ada thumbnail sama sekali.
  const blob = await drain(makeVideoThumb(new Blob([new Uint8Array([1])]), h.deps), h.scheduler);
  assert.ok(blob instanceof Blob);
  assert.deepEqual(h.canvasSizes, [[512, 288]]);
});

test("makeVideoThumb mengembalikan null kalau metadata tidak pernah siap (timeout)", async () => {
  const h = harness();
  h.video.emitsMetadata = false;

  const blob = await drain(makeVideoThumb(new Blob([new Uint8Array([1])]), h.deps, VIDEO_THUMB_MAX_EDGE), h.scheduler);

  assert.equal(blob, null);
  assert.equal(h.video.removed, true, "elemen tetap dibersihkan walau gagal");
  assert.deepEqual(h.revoked, ["blob:fake"], "URL objek tetap dicabut walau gagal");
  assert.equal(h.drawn, 0, "tidak menggambar apa pun saat gagal");
});

test("makeVideoThumb mengembalikan null kalau video tidak punya dimensi", async () => {
  const h = harness({}, { width: 0, height: 0 });
  assert.equal(await makeVideoThumb(new Blob([new Uint8Array([1])]), h.deps), null);
  assert.equal(h.drawn, 0);
});

test("makeVideoThumb mengembalikan null kalau kanvas tidak bisa dibuat", async () => {
  const h = harness({
    createCanvas: () => {
      throw new Error("canvas habis");
    },
  });
  assert.equal(await makeVideoThumb(new Blob([new Uint8Array([1])]), h.deps), null);
});

test("makeVideoThumb tidak melempar walau `createObjectURL` gagal", async () => {
  const h = harness({
    createObjectURL: () => {
      throw new Error("tidak ada URL");
    },
  });
  assert.equal(await makeVideoThumb(new Blob([new Uint8Array([1])]), h.deps), null);
});
