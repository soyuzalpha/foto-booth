/**
 * Tes pemuat starter bawaan (Fase 3, FEATURE-MATRIX §B39).
 *
 * Yang diuji adalah bagian **murni**: mengubah blob JSON jadi template, dan
 * menyusun daftar dari cache. Bukan React-nya.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultStripTemplate } from "../template/model.ts";
import { MemoryContentCache } from "./contentCache.ts";
import { loadStarters, parseStarter } from "./useStarterTemplates.ts";

const STARTER = defaultStripTemplate({ name: "Strip Klasik 2×6" });

function jsonBlob(value: unknown): Blob {
  return new Blob([JSON.stringify(value)], { type: "application/json" });
}

test("parseStarter mengubah blob JSON jadi template valid", async () => {
  const parsed = await parseStarter("starter-strip-2x6", "Strip Klasik 2×6", jsonBlob(STARTER));

  assert.ok(parsed !== null);
  assert.equal(parsed.id, "starter-strip-2x6");
  assert.equal(parsed.name, "Strip Klasik 2×6");
  assert.equal(parsed.template.frames.length, 6);
  assert.equal(parsed.template.size.width, 2);
});

test("parseStarter mengembalikan null untuk JSON rusak, bukan melempar", async () => {
  const broken = new Blob(["bukan json"], { type: "application/json" });
  assert.equal(await parseStarter("x", "X", broken), null);

  const wrongShape = jsonBlob({ id: "x", name: "X" });
  assert.equal(await parseStarter("x", "X", wrongShape), null);
});

test("loadStarters membaca katalog + blob dari cache, urut katalog", async () => {
  const cache = new MemoryContentCache();
  await cache.putCatalog({
    kind: "starters",
    syncedAt: "2026-10-12T00:00:00.000Z",
    items: [
      { id: "s1", kind: "starters", name: "Satu", url: "/content/starters/s1.json", tags: [] },
      { id: "s2", kind: "starters", name: "Dua", url: "/content/starters/s2.json", tags: [] },
    ],
  });
  await cache.putAsset("/content/starters/s1.json", jsonBlob(STARTER));
  await cache.putAsset("/content/starters/s2.json", jsonBlob({ ...STARTER, id: "s2" }));

  const starters = await loadStarters(cache);

  assert.deepEqual(
    starters.map((item) => item.id),
    ["s1", "s2"],
  );
  assert.deepEqual(
    starters.map((item) => item.name),
    ["Satu", "Dua"],
  );
});

test("loadStarters melewati item yang blob-nya tidak ada, sisanya tetap tampil", async () => {
  const cache = new MemoryContentCache();
  await cache.putCatalog({
    kind: "starters",
    syncedAt: "2026-10-12T00:00:00.000Z",
    items: [
      { id: "ada", kind: "starters", name: "Ada", url: "/content/starters/ada.json", tags: [] },
      { id: "hilang", kind: "starters", name: "Hilang", url: "/content/starters/hilang.json", tags: [] },
    ],
  });
  await cache.putAsset("/content/starters/ada.json", jsonBlob(STARTER));

  const starters = await loadStarters(cache, async () => null);

  assert.deepEqual(
    starters.map((item) => item.id),
    ["ada"],
  );
});

test("loadStarters kosong kalau katalog starter belum pernah tersinkron", async () => {
  assert.deepEqual(await loadStarters(new MemoryContentCache()), []);
});

test("loadStarters memakai loader jaringan kalau blob tidak ada di cache", async () => {
  const cache = new MemoryContentCache();
  await cache.putCatalog({
    kind: "starters",
    syncedAt: "2026-10-12T00:00:00.000Z",
    items: [{ id: "s1", kind: "starters", name: "Satu", url: "/content/starters/s1.json", tags: [] }],
  });

  const asked: string[] = [];
  const starters = await loadStarters(cache, async (url) => {
    asked.push(url);
    return jsonBlob(STARTER);
  });

  assert.deepEqual(asked, ["/content/starters/s1.json"]);
  assert.equal(starters.length, 1);
});
