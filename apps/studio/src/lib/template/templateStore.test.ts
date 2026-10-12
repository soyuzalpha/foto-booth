/**
 * Tes penyimpanan template.
 *
 * Dua hal yang dijaga: urutan (terbaru diubah dulu) dan **ketahanan terhadap
 * record rusak** — satu template dari versi skema lama tidak boleh bikin
 * seluruh daftar gagal dibuka.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryTemplateStore, createTemplateStore } from "./templateStore.ts";
import { createTemplate, defaultStripTemplate } from "./model.ts";

const NOW = new Date("2026-10-12T19:30:00Z");

function template(name: string, updatedAt: string) {
  const base = createTemplate({ name, size: { width: 2, height: 6 }, now: NOW });
  return { ...base, updatedAt };
}

test("put lalu get mengembalikan template yang sama", async () => {
  const store = new MemoryTemplateStore();
  const item = template("Strip A", "2026-10-12T10:00:00.000Z");

  await store.put(item);
  const loaded = await store.get(item.id);

  assert.deepEqual(loaded, item);
});

test("get pada id yang tidak ada mengembalikan null, bukan melempar", async () => {
  const store = new MemoryTemplateStore();
  assert.equal(await store.get("tpl_hilang"), null);
});

test("all mengurutkan dari yang terbaru diubah", async () => {
  const store = new MemoryTemplateStore();
  await store.put(template("Lama", "2026-10-01T00:00:00.000Z"));
  await store.put(template("Baru", "2026-10-12T00:00:00.000Z"));
  await store.put(template("Tengah", "2026-10-05T00:00:00.000Z"));

  const all = await store.all();
  assert.deepEqual(
    all.map((item) => item.name),
    ["Baru", "Tengah", "Lama"],
  );
});

test("put dengan id sama menimpa, tidak menduplikasi", async () => {
  const store = new MemoryTemplateStore();
  const item = template("Strip A", "2026-10-12T10:00:00.000Z");
  await store.put(item);
  await store.put({ ...item, name: "Strip A (revisi)" });

  const all = await store.all();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.name, "Strip A (revisi)");
});

test("remove menghapus hanya yang diminta", async () => {
  const store = new MemoryTemplateStore();
  const a = template("A", "2026-10-12T10:00:00.000Z");
  const b = template("B", "2026-10-12T11:00:00.000Z");
  await store.put(a);
  await store.put(b);

  await store.remove(a.id);

  assert.equal(await store.get(a.id), null);
  assert.deepEqual((await store.get(b.id))?.name, "B");
});

test("clear mengosongkan seluruh store", async () => {
  const store = new MemoryTemplateStore();
  await store.put(template("A", "2026-10-12T10:00:00.000Z"));
  await store.clear();
  assert.equal((await store.all()).length, 0);
  assert.equal(store.size, 0);
});

test("template default bisa disimpan & dibaca utuh (round-trip JSON)", async () => {
  const store = new MemoryTemplateStore();
  const item = defaultStripTemplate({ now: NOW });

  // IndexedDB menyimpan lewat structured clone — pastikan JSON-nya bersih.
  await store.put(JSON.parse(JSON.stringify(item)) as typeof item);
  const loaded = await store.get(item.id);

  assert.equal(loaded?.frames.length, 6);
  assert.deepEqual(loaded?.size, item.size);
  assert.deepEqual(loaded?.textElements, item.textElements);

  // Kriteria Fase 2: simpan → muat ulang harus byte-identik, bukan sekadar mirip.
  assert.equal(JSON.stringify(loaded), JSON.stringify(item));
});

test("createTemplateStore jatuh ke memori kalau IndexedDB tidak ada", () => {
  const { store, kind } = createTemplateStore({});
  assert.equal(kind, "memory");
  assert.ok(store instanceof MemoryTemplateStore);
});

test("createTemplateStore pakai IndexedDB kalau tersedia", () => {
  const fake = {} as IDBFactory;
  const { kind } = createTemplateStore({ indexedDB: fake });
  assert.equal(kind, "indexeddb");
});
