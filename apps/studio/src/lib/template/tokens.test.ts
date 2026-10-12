/**
 * Tes nilai token.
 *
 * `now` selalu disuntik — kalau tes bergantung jam dinding, hasilnya berubah
 * tiap tengah malam dan orang berhenti mempercayai suite-nya.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractTokens } from "@foto-booth/shared";

import { previewTokenValues, renderText, resolveTokenValues } from "./tokens.ts";

const NOW = new Date("2026-10-12T19:30:00Z");

test("resolveTokenValues memformat tanggal & jam dari jam yang disuntik", () => {
  const values = resolveTokenValues({ eventName: "Pesta", now: NOW, locale: "id-ID" });
  assert.equal(values.event, "Pesta");
  assert.match(values.date ?? "", /2026/);
  assert.match(values.time ?? "", /^\d{2}[.:]\d{2}$/);
});

test("locale tidak dikenal tidak menggagalkan compose", () => {
  const values = resolveTokenValues({ now: NOW, locale: "xx-YY" });
  assert.ok((values.date ?? "").length > 0);
  assert.ok((values.time ?? "").length > 0);
});

test("renderText mengganti semua token dalam satu kalimat", () => {
  const text = renderText("{event} · {date}", { eventName: "Wisuda", now: NOW });
  const remaining = extractTokens(text);
  assert.deepEqual(remaining, [], `masih ada token tersisa: ${text}`);
  assert.match(text, /^Wisuda · /);
});

test("token tanpa nilai jadi kosong, bukan dibiarkan", () => {
  assert.equal(renderText("[{custom}]", { now: NOW }), "[]");
});

test("nilai pratinjau tidak kosong supaya editor tidak terlihat rusak", () => {
  const values = previewTokenValues(NOW);
  assert.ok((values.event ?? "").length > 0);
  assert.ok((values.date ?? "").length > 0);
  assert.ok((values.time ?? "").length > 0);
});

test("jam default = jam sekarang kalau tidak disuntik", () => {
  const values = resolveTokenValues({});
  assert.ok((values.date ?? "").length > 0);
});
