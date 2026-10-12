/**
 * Tes wake lock kiosk.
 *
 * Yang diperiksa: kapan layar benar-benar diminta tetap menyala, bahwa
 * penolakan browser tidak menjatuhkan apa pun, dan bahwa pelepasan otomatis
 * oleh browser dilaporkan ke pemanggil.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWakeLock, type WakeLockSentinelLike } from "./wakeLock.ts";

function fakeSentinel() {
  const listeners = new Map<string, Set<() => void>>();
  const sentinel: WakeLockSentinelLike = {
    released: false,
    release: async () => {
      sentinel.released = true;
      emit("release");
    },
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
  };

  const emit = (type: string): void => {
    for (const listener of listeners.get(type) ?? []) listener();
  };

  return { sentinel, emit };
}

test("tanpa API → unsupported, request tidak melempar", async () => {
  const lock = createWakeLock({});

  assert.equal(lock.state(), "unsupported");
  assert.equal(await lock.request(), "unsupported");
});

test("request berhasil → state on dan navigator dipanggil dengan 'screen'", async () => {
  const calls: string[] = [];
  const { sentinel } = fakeSentinel();

  const lock = createWakeLock({
    wakeLock: {
      request: async (type) => {
        calls.push(type);
        return sentinel;
      },
    },
  });

  assert.equal(lock.state(), "off");
  assert.equal(await lock.request(), "on");
  assert.deepEqual(calls, ["screen"]);
});

test("request berulang tidak meminta sentinel baru", async () => {
  let calls = 0;
  const { sentinel } = fakeSentinel();

  const lock = createWakeLock({
    wakeLock: {
      request: async () => {
        calls += 1;
        return sentinel;
      },
    },
  });

  await lock.request();
  await lock.request();
  await lock.request();

  assert.equal(calls, 1, "sentinel masih hidup → tidak minta ulang");
  assert.equal(lock.state(), "on");
});

test("penolakan browser → denied, bukan exception", async () => {
  const lock = createWakeLock({
    wakeLock: {
      request: async () => {
        throw new Error("NotAllowedError");
      },
    },
  });

  assert.equal(await lock.request(), "denied");
  assert.equal(lock.state(), "denied");
});

test("pelepasan otomatis oleh browser memicu onRelease dan state kembali off", async () => {
  const { sentinel, emit } = fakeSentinel();
  const lock = createWakeLock({ wakeLock: { request: async () => sentinel } });

  let released = 0;
  lock.onRelease(() => {
    released += 1;
  });

  await lock.request();
  sentinel.released = true;
  emit("release");

  assert.equal(released, 1);
  assert.equal(lock.state(), "off");
});

test("setelah dilepas browser, request berikutnya mengambil sentinel baru", async () => {
  const first = fakeSentinel();
  const second = fakeSentinel();
  let calls = 0;

  const lock = createWakeLock({
    wakeLock: {
      request: async () => {
        calls += 1;
        return calls === 1 ? first.sentinel : second.sentinel;
      },
    },
  });

  await lock.request();
  first.sentinel.released = true;
  first.emit("release");

  assert.equal(await lock.request(), "on");
  assert.equal(calls, 2);
});

test("release() melepas sentinel dan tidak melempar walau sudah dilepas", async () => {
  const { sentinel } = fakeSentinel();
  const lock = createWakeLock({ wakeLock: { request: async () => sentinel } });

  await lock.request();
  await lock.release();

  assert.equal(lock.state(), "off");
  assert.equal(sentinel.released, true);

  // Pelepasan kedua: sudah tidak ada sentinel, harus tenang.
  await lock.release();
  assert.equal(lock.state(), "off");
});

test("unsubscribe menghentikan notifikasi", async () => {
  const { sentinel, emit } = fakeSentinel();
  const lock = createWakeLock({ wakeLock: { request: async () => sentinel } });

  let released = 0;
  const unsubscribe = lock.onRelease(() => {
    released += 1;
  });

  await lock.request();
  unsubscribe();
  sentinel.released = true;
  emit("release");

  assert.equal(released, 0);
});
