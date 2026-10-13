import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTENT_KINDS, ContentItemSchema } from "@foto-booth/shared";

import { makeHarness } from "../testing.ts";
import { catalogFor } from "./content.ts";

/**
 * Katalog konten yang dibundel — kontrak yang dipakai sync offline studio.
 *
 * Yang diuji di sini sengaja berupa **bentuk data**, bukan HTML: kalau item
 * katalog tidak lolos `ContentItemSchema`, studio akan membuangnya diam-diam
 * dan pengguna cuma melihat katalog kosong tanpa error.
 */

test("setiap kategori punya item, dan semuanya lolos ContentItemSchema", () => {
  for (const kind of CONTENT_KINDS) {
    const items = catalogFor(kind);
    assert.ok(items.length > 0, `kategori ${kind} kosong`);

    for (const item of items) {
      const parsed = ContentItemSchema.safeParse(item);
      assert.ok(parsed.success, `${kind}/${item.id} tidak valid: ${parsed.error?.message}`);
      assert.equal(item.kind, kind, `${kind}/${item.id} kind tidak cocok`);
    }
  }
});

test("URL item menunjuk ke berkas statis di /content/<kind>/", () => {
  for (const kind of CONTENT_KINDS) {
    for (const item of catalogFor(kind)) {
      assert.ok(
        item.url.startsWith(`/content/${kind}/`),
        `${item.id} url tidak di /content/${kind}/: ${item.url}`,
      );
      assert.ok(item.url.endsWith(".svg") || item.url.endsWith(".json"), item.url);
    }
  }
});

test("id item unik di seluruh katalog", () => {
  const ids = CONTENT_KINDS.flatMap((kind) => catalogFor(kind).map((item) => item.id));
  assert.equal(new Set(ids).size, ids.length, `id duplikat: ${ids.join(", ")}`);
});

test("sticker & frame membawa dimensi supaya editor bisa menaruhnya tanpa fetch", () => {
  for (const kind of ["stickers", "frames"] as const) {
    for (const item of catalogFor(kind)) {
      assert.equal(typeof item.width, "number", `${item.id} tanpa width`);
      assert.equal(typeof item.height, "number", `${item.id} tanpa height`);
    }
  }
});

test("GET /v1/content/<kind> mengembalikan katalog yang sama", async () => {
  const h = await makeHarness();
  const { app } = h;
  try {
    for (const kind of CONTENT_KINDS) {
      const res = await app.inject({ method: "GET", url: `/v1/content/${kind}` });
      assert.equal(res.statusCode, 200);

      const body = res.json() as { kind: string; items: unknown[] };
      assert.equal(body.kind, kind);
      assert.equal(body.items.length, catalogFor(kind).length);
    }
  } finally {
    await h.close();
  }
});

test("kategori tidak dikenal → 404", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "GET", url: "/v1/content/nope" });
    assert.equal(res.statusCode, 404);
  } finally {
    await h.close();
  }
});
