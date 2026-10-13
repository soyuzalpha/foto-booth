/**
 * Tes perencana filter.
 *
 * Ini "janji" Fase 6: pengaturan default tidak mengerjakan apa-apa (foto apa
 * adanya), dan tiap fitur yang dinyalakan menambah tahap yang tepat pada
 * urutan yang tepat.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { describePlan, resolveFilterPlan } from "./pipeline.ts";
import { DEFAULT_FILTER_SETTINGS, type FilterSettings } from "./types.ts";

function withSettings(patch: Partial<FilterSettings>): FilterSettings {
  return { ...DEFAULT_FILTER_SETTINGS, ...patch };
}

test("default → tanpa kerja sama sekali", () => {
  const plan = resolveFilterPlan(DEFAULT_FILTER_SETTINGS);
  assert.equal(plan.isIdentity, true);
  assert.deepEqual(plan.stages, []);
  assert.equal(plan.needsSegmenter, false);
  assert.equal(plan.needsFaceEnhance, false);
  assert.equal(describePlan(plan), "tanpa filter");
});

test("rotasi saja → satu tahap", () => {
  const plan = resolveFilterPlan(withSettings({ rotation: 90 }));
  assert.deepEqual(plan.stages, ["rotation"]);
  assert.equal(plan.isIdentity, false);
});

test("urutan tahap tetap: rotation → chromaKey → background → adjustments → faceEnhance", () => {
  const plan = resolveFilterPlan(
    withSettings({
      rotation: 270,
      chromaKey: { ...DEFAULT_FILTER_SETTINGS.chromaKey, enabled: true },
      background: { ...DEFAULT_FILTER_SETTINGS.background, mode: "color" },
      adjustments: { brightness: 10, contrast: -5, saturation: 0 },
      faceEnhance: true,
    }),
  );

  assert.deepEqual(plan.stages, [
    "rotation",
    "chromaKey",
    "background",
    "adjustments",
    "faceEnhance",
  ]);
  assert.equal(plan.needsChromaKey, true);
  assert.equal(plan.needsBackground, true);
  assert.equal(plan.needsFaceEnhance, true);
});

test("latar diganti tanpa chroma key → butuh segmenter", () => {
  const plan = resolveFilterPlan(
    withSettings({ background: { ...DEFAULT_FILTER_SETTINGS.background, mode: "blur" } }),
  );
  assert.equal(plan.needsBackground, true);
  assert.equal(plan.needsSegmenter, true);
});

test("chroma key aktif + latar diganti → mask dari chroma key, tanpa segmenter", () => {
  const plan = resolveFilterPlan(
    withSettings({
      chromaKey: { ...DEFAULT_FILTER_SETTINGS.chromaKey, enabled: true },
      background: { ...DEFAULT_FILTER_SETTINGS.background, mode: "ai" },
    }),
  );
  assert.equal(plan.needsSegmenter, false);
  assert.equal(plan.needsChromaKey, true);
});

test("adjustments netral tidak menambah tahap", () => {
  const plan = resolveFilterPlan(
    withSettings({ adjustments: { brightness: 0, contrast: 0, saturation: 0 } }),
  );
  assert.equal(plan.isIdentity, true);
});

test("satu penyesuaian kecil sudah cukup membatalkan identity", () => {
  const plan = resolveFilterPlan(withSettings({ adjustments: { brightness: 0, contrast: 0, saturation: 1 } }));
  assert.equal(plan.isIdentity, false);
  assert.deepEqual(plan.stages, ["adjustments"]);
});

test("quality preset ikut terbawa rencana", () => {
  const plan = resolveFilterPlan(withSettings({ quality: "maks" }));
  assert.equal(plan.quality, "maks");
});
