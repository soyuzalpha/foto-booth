/**
 * State editor template — reducer murni.
 *
 * Sengaja **tidak** menyentuh React atau Konva: seluruh perilaku editor
 * (geser, resize, rotate, undo/redo) diuji di Node dengan angka. Komponen
 * Konva cuma menerjemahkan pointer event jadi aksi di sini.
 *
 * Aturan undo yang dipakai: setiap aksi yang **mengubah template** mendorong
 * salinan sebelumnya ke `past`. Aksi yang cuma mengubah *pilihan* tidak —
 * kalau tidak, tombol undo jadi penuh langkah kosong dan tidak berguna.
 */

import type { Template, TemplateFrame, TemplateSticker, TemplateText } from "@foto-booth/shared";

import { clampBox, type Box } from "./layout.ts";
import { newId } from "./model.ts";

export const HISTORY_LIMIT = 50;

export type ElementKind = "frame" | "text" | "sticker";

export interface Selection {
  kind: ElementKind;
  id: string;
}

export interface EditorState {
  template: Template;
  selected: Selection | null;
  past: Template[];
  future: Template[];
  /** Naik setiap kali ada perubahan yang belum disimpan ke penyimpanan. */
  revision: number;
}

export type EditorAction =
  | { type: "select"; selection: Selection | null }
  | { type: "move"; dx: number; dy: number }
  | { type: "moveTo"; x: number; y: number }
  | { type: "resize"; box: Box }
  | { type: "transform"; box: Box; rotation: number }
  | { type: "rotate"; rotation: number }
  | { type: "addText"; text?: string }
  | { type: "addSticker"; src: string; width: number; height: number }
  | { type: "delete" }
  | { type: "updateText"; id: string; patch: Partial<TemplateText> }
  | { type: "updateFrame"; id: string; patch: Partial<TemplateFrame> }
  | { type: "updateSticker"; id: string; patch: Partial<TemplateSticker> }
  | { type: "setBackground"; background: Template["background"] }
  | { type: "rename"; name: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "markSaved" }
  | { type: "replace"; template: Template };

export function createEditorState(template: Template): EditorState {
  return { template, selected: null, past: [], future: [], revision: 0 };
}

export function canUndo(state: EditorState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: EditorState): boolean {
  return state.future.length > 0;
}

export function isDirty(state: EditorState): boolean {
  return state.revision > 0;
}

/** Elemen yang sedang dipilih, atau null. */
export function selectedElement(
  state: EditorState,
): TemplateFrame | TemplateText | TemplateSticker | null {
  const selection = state.selected;
  if (selection === null) return null;

  const list: (TemplateFrame | TemplateText | TemplateSticker)[] =
    selection.kind === "frame"
      ? state.template.frames
      : selection.kind === "text"
        ? state.template.textElements
        : state.template.stickers;

  return list.find((element) => element.id === selection.id) ?? null;
}

/** Semua elemen dalam urutan yang dipakai untuk uji-tumpang & hit-test. */
export function elementsOf(template: Template): (TemplateFrame | TemplateText | TemplateSticker)[] {
  return [...template.frames, ...template.stickers, ...template.textElements];
}

function withHistory(state: EditorState, template: Template): EditorState {
  return {
    template,
    selected: state.selected,
    past: [...state.past, state.template].slice(-HISTORY_LIMIT),
    future: [],
    revision: state.revision + 1,
  };
}

/** Terapkan perubahan pada elemen terpilih; abaikan kalau tidak ada yang dipilih. */
function patchSelected(
  state: EditorState,
  patch: (element: TemplateFrame | TemplateText | TemplateSticker, pixels: { width: number; height: number }) => TemplateFrame | TemplateText | TemplateSticker | null,
): EditorState {
  const selection = state.selected;
  if (selection === null) return state;

  const pixels = {
    width: Math.round(state.template.size.width * state.template.size.dpi),
    height: Math.round(state.template.size.height * state.template.size.dpi),
  };

  const current = selectedElement(state);
  if (current === null) return state;

  const updated = patch(current, pixels);
  if (updated === null) return state;

  const next = { ...state.template, frames: [...state.template.frames], textElements: [...state.template.textElements], stickers: [...state.template.stickers] };

  const replaceIn = <T extends { id: string }>(list: T[], item: T): T[] =>
    list.map((entry) => (entry.id === item.id ? item : entry));

  if (selection.kind === "frame") {
    next.frames = replaceIn(next.frames, updated as TemplateFrame);
  } else if (selection.kind === "text") {
    next.textElements = replaceIn(next.textElements, updated as TemplateText);
  } else {
    next.stickers = replaceIn(next.stickers, updated as TemplateSticker);
  }

  return withHistory(state, next);
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "select":
      return { ...state, selected: action.selection };

    case "move":
      return patchSelected(state, (element, pixels) => {
        const box = clampBox(
          { x: element.x + action.dx, y: element.y + action.dy, width: element.width, height: element.height },
          pixels,
        );
        return { ...element, x: box.x, y: box.y };
      });

    case "moveTo":
      return patchSelected(state, (element, pixels) => {
        const box = clampBox(
          { x: action.x, y: action.y, width: element.width, height: element.height },
          pixels,
        );
        return { ...element, x: box.x, y: box.y };
      });

    case "resize": {
      // Rotasi diabaikan saat resize: Konva mengirim kotak sudah-rotasi, dan
      // menerapkan koreksi sudut di sini bikin elemen "melompat".
      const minSize = 24;
      const width = Math.max(minSize, action.box.width);
      const height = Math.max(minSize, action.box.height);
      return patchSelected(state, (element, pixels) => {
        const box = clampBox({ ...action.box, width, height }, pixels);
        return { ...element, x: box.x, y: box.y, width: box.width, height: box.height };
      });
    }

    case "rotate":
      return patchSelected(state, (element) => ({ ...element, rotation: action.rotation }));

    case "transform":
      // Konva mengirim kotak + sudut sekaligus saat tuas transform dipakai.
      // Digabung di satu aksi supaya satu tarikan tuas = satu langkah undo.
      return patchSelected(state, (element, pixels) => {
        const minSize = 24;
        const box = clampBox(
          {
            ...action.box,
            width: Math.max(minSize, action.box.width),
            height: Math.max(minSize, action.box.height),
          },
          pixels,
        );
        return {
          ...element,
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          rotation: action.rotation,
        };
      });

    case "addText": {
      const text = action.text ?? "Teks baru";
      const element: TemplateText = {
        id: newId("text"),
        text,
        x: 40,
        y: 40,
        width: 400,
        height: 70,
        fontSize: 44,
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#0a0a0a",
        strokeWidth: 0,
        align: "center",
        rotation: 0,
      };
      const next = { ...state.template, textElements: [...state.template.textElements, element] };
      const added = withHistory(state, next);
      return { ...added, selected: { kind: "text", id: element.id } };
    }

    case "addSticker": {
      const element: TemplateSticker = {
        id: newId("sticker"),
        src: action.src,
        x: 40,
        y: 40,
        width: action.width,
        height: action.height,
        rotation: 0,
      };
      const next = { ...state.template, stickers: [...state.template.stickers, element] };
      const added = withHistory(state, next);
      return { ...added, selected: { kind: "sticker", id: element.id } };
    }

    case "delete": {
      const selection = state.selected;
      if (selection === null) return state;

      const next = {
        ...state.template,
        frames: selection.kind === "frame" ? state.template.frames.filter((f) => f.id !== selection.id) : state.template.frames,
        textElements:
          selection.kind === "text"
            ? state.template.textElements.filter((t) => t.id !== selection.id)
            : state.template.textElements,
        stickers:
          selection.kind === "sticker"
            ? state.template.stickers.filter((s) => s.id !== selection.id)
            : state.template.stickers,
      };

      const removed = withHistory(state, next);
      return { ...removed, selected: null };
    }

    case "updateText": {
      const next = {
        ...state.template,
        textElements: state.template.textElements.map((element) =>
          element.id === action.id ? { ...element, ...action.patch } : element,
        ),
      };
      return withHistory(state, next);
    }

    case "updateFrame": {
      const next = {
        ...state.template,
        frames: state.template.frames.map((element) =>
          element.id === action.id ? { ...element, ...action.patch } : element,
        ),
      };
      return withHistory(state, next);
    }

    case "updateSticker": {
      const next = {
        ...state.template,
        stickers: state.template.stickers.map((element) =>
          element.id === action.id ? { ...element, ...action.patch } : element,
        ),
      };
      return withHistory(state, next);
    }

    case "setBackground":
      return withHistory(state, { ...state.template, background: action.background });

    case "rename": {
      const name = action.name.trim();
      if (name === "") return state;
      return withHistory(state, { ...state.template, name });
    }

    case "undo": {
      const previous = state.past.at(-1);
      if (previous === undefined) return state;
      return {
        template: previous,
        selected: state.selected,
        past: state.past.slice(0, -1),
        future: [state.template, ...state.future].slice(0, HISTORY_LIMIT),
        revision: state.revision + 1,
      };
    }

    case "redo": {
      const next = state.future[0];
      if (next === undefined) return state;
      return {
        template: next,
        selected: state.selected,
        past: [...state.past, state.template].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        revision: state.revision + 1,
      };
    }

    case "markSaved":
      return markSaved(state);

    case "replace":
      return createEditorState(action.template);
  }
}

/** Tandai revisi sudah disimpan (dipakai setelah `put` ke penyimpanan). */
export function markSaved(state: EditorState): EditorState {
  return { ...state, revision: 0 };
}
