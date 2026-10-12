/**
 * Tes fullscreen kiosk.
 *
 * Browser asli tidak ada di tes, jadi yang diperiksa adalah **keputusan**:
 * kapan controller menolak masuk, apa yang dilaporkan saat API tidak ada, dan
 * bahwa listener dipanggil saat status berubah dari luar (mis. Esc).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createFullscreenController,
  readFullscreenState,
  resolveFullscreenTarget,
  type FullscreenState,
  type FullscreenTarget,
} from "./fullscreen.ts";

/** Target palsu yang bisa dipaksa menerima atau menolak permintaan. */
function fakeTarget(options: { allow?: boolean; supported?: boolean } = {}) {
  const allow = options.allow ?? true;
  const supported = options.supported ?? true;
  const listeners = new Map<string, Set<() => void>>();

  const target = {
    fullscreenElement: null as Element | null,
    requestFullscreen: supported
      ? async () => {
          if (!allow) throw new Error("NotAllowedError");
          target.fullscreenElement = {} as Element;
          emit("fullscreenchange");
        }
      : undefined,
    exitFullscreen: supported
      ? async () => {
          target.fullscreenElement = null;
          emit("fullscreenchange");
        }
      : undefined,
    addEventListener: (type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
  };

  const emit = (type: string): void => {
    for (const listener of listeners.get(type) ?? []) listener();
  };

  return { target: target as unknown as FullscreenTarget, emit, raw: target };
}

test("readFullscreenState melaporkan unsupported saat API tidak ada", () => {
  assert.equal(readFullscreenState(null), "unsupported");
  assert.equal(readFullscreenState({} as FullscreenTarget), "unsupported");
});

test("readFullscreenState mengikuti fullscreenElement", () => {
  assert.equal(readFullscreenState({ requestFullscreen: async () => {} }), "off");
  assert.equal(
    readFullscreenState({ requestFullscreen: async () => {}, fullscreenElement: {} as Element }),
    "on",
  );
});

test("enter() masuk fullscreen dan melaporkan status on", async () => {
  const { target, raw } = fakeTarget();
  const controller = createFullscreenController(target);

  assert.equal(controller.state(), "off");
  assert.equal(await controller.enter(), true);
  assert.equal(raw.fullscreenElement !== null, true);
  assert.equal(controller.state(), "on");
});

test("enter() mengembalikan false saat browser menolak (bukan gesture pengguna)", async () => {
  const { target } = fakeTarget({ allow: false });
  const controller = createFullscreenController(target);

  assert.equal(await controller.enter(), false);
  assert.equal(controller.state(), "off");
});

test("enter() pada lingkungan tanpa API mengembalikan false, tidak melempar", async () => {
  const controller = createFullscreenController(null);

  assert.equal(await controller.enter(), false);
  assert.equal(await controller.exit(), false);
  assert.equal(controller.state(), "unsupported");
});

test("enter() saat sudah fullscreen tidak memanggil API lagi", async () => {
  let calls = 0;
  const target = {
    fullscreenElement: {} as Element,
    requestFullscreen: async () => {
      calls += 1;
    },
  } as unknown as FullscreenTarget;

  const controller = createFullscreenController(target);
  assert.equal(await controller.enter(), true);
  assert.equal(calls, 0);
});

test("exit() keluar dari fullscreen", async () => {
  const { target, raw } = fakeTarget();
  const controller = createFullscreenController(target);

  await controller.enter();
  assert.equal(await controller.exit(), true);
  assert.equal(raw.fullscreenElement, null);
  assert.equal(controller.state(), "off");
});

test("subscribe dipanggil saat status berubah dari luar (tombol Esc)", async () => {
  const { target, emit, raw } = fakeTarget();
  const controller = createFullscreenController(target);

  const seen: FullscreenState[] = [];
  const unsubscribe = controller.subscribe((state) => seen.push(state));

  await controller.enter();
  assert.deepEqual(seen, ["on"]);

  // Pengguna menekan Esc: browser mengubah DOM, lalu mengirim event.
  raw.fullscreenElement = null;
  emit("fullscreenchange");
  assert.deepEqual(seen, ["on", "off"]);

  unsubscribe();
  raw.fullscreenElement = {} as Element;
  emit("fullscreenchange");
  assert.deepEqual(seen, ["on", "off"], "setelah unsubscribe tidak ada lagi");
});

test("perubahan yang tidak mengubah status tidak memicu listener", async () => {
  const { target, emit } = fakeTarget();
  const controller = createFullscreenController(target);

  let count = 0;
  controller.subscribe(() => {
    count += 1;
  });

  emit("fullscreenchange");
  assert.equal(count, 0, "status tetap off → tidak ada notifikasi");
});

test("toggle() membalik status", async () => {
  const { target } = fakeTarget();
  const controller = createFullscreenController(target);

  assert.equal(await controller.toggle(), true);
  assert.equal(controller.state(), "on");
  assert.equal(await controller.toggle(), true);
  assert.equal(controller.state(), "off");
});

/**
 * Regresi: `requestFullscreen()` hidup di `Element`, bukan `Document`. Versi
 * pertama kiosk memakai `document` sebagai target sehingga di Chromium
 * (`document.requestFullscreen === undefined`) fullscreen selamanya dilaporkan
 * "tidak didukung" dan tidak pernah masuk. Tes ini mengunci bentuk DOM yang
 * benar.
 */
test("resolveFullscreenTarget memakai requestFullscreen dari elemen, bukan document", () => {
  const element = { requestFullscreen: async () => {} };
  const documentLike = {
    documentElement: element,
    exitFullscreen: async () => {},
    fullscreenElement: null as Element | null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const original = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = documentLike;

  try {
    const target = resolveFullscreenTarget();

    assert.notEqual(target, null, "adapter harus terbentuk dari documentElement");
    assert.equal(readFullscreenState(target), "off", "harus 'off', bukan 'unsupported'");
  } finally {
    if (original === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = original;
  }
});

test("resolveFullscreenTarget null saat document tidak punya documentElement yang bisa fullscreen", () => {
  const original = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { documentElement: {} };

  try {
    assert.equal(resolveFullscreenTarget(), null);
  } finally {
    if (original === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = original;
  }
});
