/**
 * Tes model template.
 *
 * Yang dijaga di sini: **template tidak pernah beredar tanpa divalidasi.**
 * Data dari IndexedDB atau impor berkas bisa dari versi lama, jadi setiap
 * jalur masuk harus lewat `validateTemplate` — dan yang tidak valid harus
 * muncul sebagai pesan, bukan exception mentah atau layar putih.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { templatePixelSize } from "@foto-booth/shared";

import {
  TemplateValidationError,
  cloneTemplate,
  createTemplate,
  defaultStripTemplate,
  framesBySlot,
  nextSlot,
  normalizeTemplate,
  presetById,
  touchTemplate,
  validateTemplate,
} from "./model.ts";

const NOW = new Date("2026-10-12T19:30:00Z");

test("createTemplate mengisi default yang konsisten", () => {
  const template = createTemplate({
    name: "Strip uji",
    size: { width: 2, height: 6 },
    now: NOW,
  });

  assert.equal(template.size.dpi, 300);
  assert.deepEqual(template.frames, []);
  assert.deepEqual(template.textElements, []);
  assert.deepEqual(template.stickers, []);
  assert.equal(template.background.type, "color");
  assert.equal(template.createdAt, NOW.toISOString());
  assert.equal(template.updatedAt, NOW.toISOString());
  assert.match(template.id, /^tpl_/);
});

test("createTemplate menolak dpi di bawah 300", () => {
  assert.throws(
    () => createTemplate({ name: "x", size: { width: 2, height: 6, dpi: 72 } }),
    TemplateValidationError,
  );
});

test("validateTemplate melaporkan masalah per-field, bukan melempar", () => {
  const result = validateTemplate({ id: "", name: "", size: { width: -1, height: 6 } });
  assert.equal(result.ok, false);
  if (result.ok) return;

  const joined = result.errors.join("\n");
  assert.match(joined, /name/);
  assert.match(joined, /size\.width/);
});

test("normalizeTemplate melempar dengan daftar masalah yang bisa dibaca", () => {
  try {
    normalizeTemplate({ id: "tpl_1", name: "" });
    assert.fail("seharusnya melempar");
  } catch (error) {
    assert.ok(error instanceof TemplateValidationError);
    assert.ok(error.issues.length > 0);
    assert.match(error.message, /Template tidak valid/);
  }
});

test("template default 2×6: 6 frame, canvas 600×1800, teks bertoken", () => {
  const template = defaultStripTemplate({ now: NOW });
  const pixels = templatePixelSize(template.size);

  assert.deepEqual(pixels, { width: 600, height: 1800 });
  assert.equal(template.frames.length, 6);
  assert.deepEqual(
    template.frames.map((frame) => frame.slot),
    [0, 1, 2, 3, 4, 5],
  );

  const texts = template.textElements.map((element) => element.text);
  assert.ok(texts.includes("{event}"), `teks harus punya token event, dapat: ${texts.join(" | ")}`);
  assert.ok(texts.some((text) => text.includes("{date}") && text.includes("{time}")));
});

test("template default: semua frame muat di canvas", () => {
  const template = defaultStripTemplate({ now: NOW });
  const pixels = templatePixelSize(template.size);

  for (const frame of template.frames) {
    assert.ok(frame.x >= 0 && frame.y >= 0);
    assert.ok(frame.x + frame.width <= pixels.width, `frame ${frame.slot} terlalu lebar`);
    assert.ok(frame.y + frame.height <= pixels.height, `frame ${frame.slot} terlalu tinggi`);
  }
});

test("presetById menemukan preset dan null kalau tidak ada", () => {
  assert.deepEqual(presetById("2x6"), { width: 2, height: 6, name: "2×6 in — strip" });
  assert.equal(presetById("nggak-ada"), null);
});

test("nextSlot memberi slot kosong pertama", () => {
  const template = defaultStripTemplate({ now: NOW });
  assert.equal(nextSlot(template), 6);

  const withHole = {
    ...template,
    frames: template.frames.filter((frame) => frame.slot !== 2),
  };
  assert.equal(nextSlot(withHole), 2, "slot 2 yang kosong harus dipakai ulang");
});

test("framesBySlot menaruh undefined di slot bolong", () => {
  const template = defaultStripTemplate({ count: 3, now: NOW });
  const withHole = { ...template, frames: template.frames.filter((frame) => frame.slot !== 1) };
  const slots = framesBySlot(withHole);

  assert.equal(slots.length, 3);
  assert.equal(slots[1], undefined);
  assert.equal(slots[2]?.slot, 2);
});

test("cloneTemplate menghasilkan salinan lepas", () => {
  const template = defaultStripTemplate({ now: NOW });
  const copy = cloneTemplate(template);
  copy.frames[0]!.x = 9999;
  assert.notEqual(template.frames[0]!.x, 9999);
});

test("touchTemplate memperbarui updatedAt tanpa mengubah createdAt", () => {
  const template = defaultStripTemplate({ now: NOW });
  const later = touchTemplate(template, new Date("2026-10-13T00:00:00Z"));
  assert.equal(later.createdAt, NOW.toISOString());
  assert.equal(later.updatedAt, "2026-10-13T00:00:00.000Z");
});
