/**
 * Tes reducer editor.
 *
 * Yang diuji angka: posisi setelah geser (termasuk clamp di tepi), ukuran
 * minimum setelah resize, dan aturan undo — pilihan tidak boleh mengotori
 * riwayat.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultStripTemplate } from "./model.ts";
import {
  canRedo,
  canUndo,
  createEditorState,
  editorReducer,
  selectedElement,
  type EditorAction,
  type EditorState,
} from "./editorState.ts";

const NOW = new Date("2026-10-12T19:30:00Z");

function fresh(): EditorState {
  const template = defaultStripTemplate({ count: 2, now: NOW });
  return createEditorState(template);
}

function apply(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

function frameId(state: EditorState, index: number): string {
  return state.template.frames[index]!.id;
}

test("select tidak masuk riwayat undo", () => {
  const state = apply(fresh(), { type: "select", selection: { kind: "frame", id: "frame_x" } });
  assert.equal(canUndo(state), false, "memilih bukan perubahan template");
});

test("move menggeser elemen terpilih sesuai delta", () => {
  let state = fresh();
  const id = frameId(state, 0);
  state = apply(state, { type: "select", selection: { kind: "frame", id } }, { type: "move", dx: 20, dy: 30 });

  const element = selectedElement(state);
  assert.ok(element !== null);
  assert.equal(element.x, 36 + 20);
  assert.equal(element.y, 36 + 30);
});

test("move tidak bisa mendorong elemen keluar canvas", () => {
  let state = fresh();
  const id = frameId(state, 0);
  state = apply(state, { type: "select", selection: { kind: "frame", id } }, { type: "move", dx: -9999, dy: -9999 });

  const element = selectedElement(state);
  assert.ok(element !== null);
  assert.equal(element.x, 0);
  assert.equal(element.y, 0);
});

test("move tanpa pilihan tidak mengubah apa pun", () => {
  const state = fresh();
  const moved = editorReducer(state, { type: "move", dx: 10, dy: 10 });
  assert.equal(moved, state, "harus mengembalikan state yang sama persis");
});

test("resize menghormati ukuran minimum", () => {
  let state = fresh();
  const id = frameId(state, 0);
  state = apply(
    state,
    { type: "select", selection: { kind: "frame", id } },
    { type: "resize", box: { x: 36, y: 36, width: 2, height: 3 } },
  );

  const element = selectedElement(state);
  assert.ok(element !== null);
  assert.equal(element.width, 24);
  assert.equal(element.height, 24);
});

test("rotate menyimpan sudut apa adanya", () => {
  let state = fresh();
  const id = frameId(state, 0);
  state = apply(
    state,
    { type: "select", selection: { kind: "frame", id } },
    { type: "rotate", rotation: 17.5 },
  );

  assert.equal(selectedElement(state)?.rotation, 17.5);
});

test("addText menambah elemen dan langsung memilihnya", () => {
  const state = editorReducer(fresh(), { type: "addText" });

  assert.equal(state.template.textElements.length, 3, "2 bawaan + 1 baru");
  assert.equal(state.selected?.kind, "text");

  const element = selectedElement(state);
  assert.ok(element !== null && "text" in element);
  assert.equal(element.text, "Teks baru");
});

test("delete menghapus elemen terpilih dan mengosongkan pilihan", () => {
  let state = fresh();
  const id = frameId(state, 0);
  state = apply(state, { type: "select", selection: { kind: "frame", id } }, { type: "delete" });

  assert.equal(state.template.frames.length, 1);
  assert.equal(state.selected, null);
  assert.ok(!state.template.frames.some((frame) => frame.id === id));
});

test("undo mengembalikan template sebelumnya", () => {
  let state = fresh();
  const id = frameId(state, 0);
  const before = state.template.frames[0]!.x;

  state = apply(state, { type: "select", selection: { kind: "frame", id } }, { type: "move", dx: 20, dy: 0 });
  assert.equal(state.template.frames[0]!.x, before + 20);
  assert.equal(canUndo(state), true);

  state = editorReducer(state, { type: "undo" });
  assert.equal(state.template.frames[0]!.x, before);
  assert.equal(canRedo(state), true);
});

test("redo mengulang perubahan yang di-undo", () => {
  let state = fresh();
  const id = frameId(state, 0);

  state = apply(state, { type: "select", selection: { kind: "frame", id } }, { type: "move", dx: 20, dy: 0 });
  state = editorReducer(state, { type: "undo" });
  state = editorReducer(state, { type: "redo" });

  assert.equal(state.template.frames[0]!.x, 56);
});

test("perubahan baru membuang riwayat redo", () => {
  let state = fresh();
  const id = frameId(state, 0);

  state = apply(state, { type: "select", selection: { kind: "frame", id } }, { type: "move", dx: 50, dy: 0 });
  state = editorReducer(state, { type: "undo" });
  state = editorReducer(state, { type: "move", dx: 5, dy: 5 });

  assert.equal(canRedo(state), false, "cabang lama harus hilang");
});

test("undo pada riwayat kosong tidak melempar", () => {
  const state = fresh();
  assert.equal(editorReducer(state, { type: "undo" }), state);
  assert.equal(editorReducer(state, { type: "redo" }), state);
});

test("rename kosong diabaikan, rename berisi tersimpan", () => {
  const state = fresh();
  assert.equal(editorReducer(state, { type: "rename", name: "   " }), state);

  const renamed = editorReducer(state, { type: "rename", name: "  Strip Wisuda  " });
  assert.equal(renamed.template.name, "Strip Wisuda");
});

test("replace membuang riwayat dan pilihan", () => {
  let state = fresh();
  const id = frameId(state, 0);
  state = apply(state, { type: "select", selection: { kind: "frame", id } }, { type: "move", dx: 50, dy: 0 });

  const other = defaultStripTemplate({ name: "Lain", count: 3, now: NOW });
  const replaced = editorReducer(state, { type: "replace", template: other });

  assert.equal(replaced.template.name, "Lain");
  assert.equal(replaced.selected, null);
  assert.equal(canUndo(replaced), false);
  assert.equal(replaced.revision, 0);
});

test("updateText hanya mengubah elemen yang dituju", () => {
  const state = fresh();
  const target = state.template.textElements[0]!;
  const other = state.template.textElements[1]!;

  const updated = editorReducer(state, { type: "updateText", id: target.id, patch: { text: "{custom}" } });

  assert.equal(updated.template.textElements[0]?.text, "{custom}");
  assert.equal(updated.template.textElements[1]?.text, other.text);
});

test("setBackground mengubah latar dan masuk riwayat", () => {
  const state = fresh();
  const updated = editorReducer(state, {
    type: "setBackground",
    background: { type: "color", value: "#111111", hasVignette: true },
  });

  assert.equal(updated.template.background.value, "#111111");
  assert.equal(updated.template.background.hasVignette, true);
  assert.equal(canUndo(updated), true);
});

test("riwayat dibatasi HISTORY_LIMIT langkah", () => {
  let state = fresh();
  const id = frameId(state, 0);
  state = editorReducer(state, { type: "select", selection: { kind: "frame", id } });

  for (let index = 0; index < 80; index += 1) {
    state = editorReducer(state, { type: "move", dx: 1, dy: 0 });
  }

  assert.ok(state.past.length <= 50, `riwayat ${state.past.length} harus ≤ 50`);
});
