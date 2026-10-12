/**
 * Tes guard gesture kiosk.
 *
 * Fokus: gesture yang memang harus ditolak ditolak, dan yang tidak boleh
 * diganggu (scroll, klik biasa) tetap lolos.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createGestureGuard, type GuardEvent, type GuardTarget } from "./gestureGuard.ts";

/** Target palsu yang merekam listener dan bisa "mengirim" event. */
function fakeTarget() {
  const listeners = new Map<string, Set<(event: GuardEvent) => void>>();

  const target: GuardTarget = {
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
  };

  const fire = (type: string, event: Record<string, unknown> = {}): { prevented: boolean } => {
    let prevented = false;
    const full = {
      type,
      cancelable: true,
      preventDefault: () => {
        prevented = true;
      },
      ...event,
    } as GuardEvent;

    for (const listener of listeners.get(type) ?? []) listener(full);
    return { prevented };
  };

  return { target, fire, listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0) };
}

test("menu konteks ditolak", () => {
  const { target, fire } = fakeTarget();
  createGestureGuard(target);

  assert.equal(fire("contextmenu").prevented, true);
});

test("zoom lewat ctrl+scroll ditolak, scroll biasa lolos", () => {
  const { target, fire } = fakeTarget();
  createGestureGuard(target);

  assert.equal(fire("wheel", { ctrlKey: true }).prevented, true);
  assert.equal(fire("wheel", { metaKey: true }).prevented, true);
  assert.equal(fire("wheel").prevented, false, "scroll normal harus jalan");
});

test("zoom lewat keyboard (ctrl +/-/0) ditolak, tombol biasa lolos", () => {
  const { target, fire } = fakeTarget();
  createGestureGuard(target);

  const key = (value: string, ctrlKey = true): boolean =>
    fire("keydown", { ctrlKey, key: value }).prevented;

  assert.equal(key("+"), true);
  assert.equal(key("-"), true);
  assert.equal(key("="), true);
  assert.equal(key("0"), true);
  assert.equal(key("a"), false, "ctrl+a bukan zoom");
  assert.equal(key("+", false), false, "tanpa modifier bukan zoom");
});

test("pinch dua jari ditolak, satu jari lolos", () => {
  const { target, fire } = fakeTarget();
  createGestureGuard(target);

  const touchmove = (touches: unknown[]): boolean =>
    fire("touchmove", { touches }).prevented;

  assert.equal(touchmove([{}, {}]), true);
  assert.equal(touchmove([{}]), false, "satu jari = scroll");
});

test("swipe-back dari tepi ditolak, dari tengah lolos", () => {
  const { target, fire } = fakeTarget();
  createGestureGuard(target);

  const touchstart = (clientX: number, innerWidth = 1024): boolean =>
    fire("touchstart", { touches: [{ clientX }], view: { innerWidth } }).prevented;

  assert.equal(touchstart(5), true, "tepi kiri");
  assert.equal(touchstart(1020), true, "tepi kanan");
  assert.equal(touchstart(512), false, "tengah layar");
});

test("event yang tidak cancelable tidak dipaksa preventDefault", () => {
  const { target, fire } = fakeTarget();
  createGestureGuard(target);

  assert.equal(fire("contextmenu", { cancelable: false }).prevented, false);
});

test("opsi bisa mematikan guard per jenis", () => {
  const { target, fire } = fakeTarget();
  const guard = createGestureGuard(target, { blockContextMenu: false, blockZoom: false });

  assert.equal(fire("contextmenu").prevented, false);
  assert.equal(fire("wheel", { ctrlKey: true }).prevented, false);
  assert.equal(guard.types.includes("contextmenu"), false);
  assert.equal(guard.types.includes("wheel"), false);
  assert.equal(guard.types.includes("touchstart"), true, "swipe-back tetap aktif");
});

test("onBlocked melaporkan jenis event yang dicegah", () => {
  const { target, fire } = fakeTarget();
  const blocked: string[] = [];
  createGestureGuard(target, { onBlocked: (type) => blocked.push(type) });

  fire("contextmenu");
  fire("wheel", { ctrlKey: true });
  fire("wheel");

  assert.deepEqual(blocked, ["contextmenu", "wheel"]);
});

test("dispose melepas semua listener", () => {
  const { target, fire, listenerCount } = fakeTarget();
  const guard = createGestureGuard(target);

  assert.equal(listenerCount() > 0, true);
  guard.dispose();
  assert.equal(listenerCount(), 0);
  assert.equal(fire("contextmenu").prevented, false, "setelah dispose tidak mencegat");
});

test("tanpa target (SSR) guard tetap aman dipakai", () => {
  const guard = createGestureGuard(null);

  assert.deepEqual(guard.types, []);
  guard.dispose();
});
