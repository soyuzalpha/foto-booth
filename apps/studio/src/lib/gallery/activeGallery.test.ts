/**
 * Tes galeri aktif.
 *
 * Kiosk melayani **satu acara pada satu waktu**, dan pilihan itu disimpan di
 * perangkat supaya refresh di tengah acara tidak melupakan tujuan upload.
 *
 * Yang diuji:
 *
 *   · **Galeri kedaluwarsa diperlakukan sebagai tidak ada** — TTL 30 hari
 *     berarti galeri lama masih ada di daftar API sampai cleanup jalan;
 *     mengarahkan upload ke situ hanya menghasilkan 404 beruntun.
 *   · **Penyimpanan rusak tidak melempar**, sama seperti sesi operator.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVE_GALLERY_KEY,
  activeFromSummary,
  clearActiveGallery,
  isGalleryExpired,
  loadActiveGallery,
  parseActiveGallery,
  saveActiveGallery,
  type ActiveGallery,
} from "./activeGallery.ts";
import type { StorageLike } from "../session/operatorSession.ts";

const NOW = new Date("2026-01-01T00:00:00Z");
const LATER = "2026-01-20T00:00:00.000Z";
const EARLIER = "2025-12-31T00:00:00.000Z";

function fakeStorage(options: { failOn?: "get" | "set" | "remove" } = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key) {
      if (options.failOn === "get") throw new Error("SecurityError");
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (options.failOn === "set") throw new Error("QuotaExceededError");
      data.set(key, value);
    },
    removeItem(key) {
      if (options.failOn === "remove") throw new Error("SecurityError");
      data.delete(key);
    },
  };
}

function gallery(overrides: Partial<ActiveGallery> = {}): ActiveGallery {
  return {
    id: "gal-1",
    hash: "AbCd1234",
    url: "https://foto.soyuz.my.id/a/AbCd1234",
    label: "Pernikahan Asep & Nia",
    expiresAt: LATER,
    ...overrides,
  };
}

test("parseActiveGallery menolak entri tanpa id/hash/kedaluwarsa", () => {
  assert.equal(parseActiveGallery(null), null);
  assert.equal(parseActiveGallery({ ...gallery(), id: "" }), null);
  assert.equal(parseActiveGallery({ ...gallery(), hash: undefined }), null);
  assert.equal(parseActiveGallery({ ...gallery(), expiresAt: "kemarin" }), null);
});

test("parseActiveGallery mengisi url dan label yang hilang dengan string kosong", () => {
  const parsed = parseActiveGallery({ id: "gal-1", hash: "h1", expiresAt: LATER });
  assert.deepEqual(parsed, { id: "gal-1", hash: "h1", url: "", label: "", expiresAt: LATER });
});

test("galeri yang berakhir tepat sekarang sudah dianggap kedaluwarsa", () => {
  assert.equal(isGalleryExpired(gallery({ expiresAt: NOW.toISOString() }), NOW), true);
  assert.equal(isGalleryExpired(gallery(), NOW), false);
});

test("loadActiveGallery membuang galeri kedaluwarsa DARI penyimpanan", () => {
  const storage = fakeStorage();
  storage.data.set(ACTIVE_GALLERY_KEY, JSON.stringify(gallery({ expiresAt: EARLIER })));

  assert.equal(loadActiveGallery(NOW, storage), null);
  assert.equal(storage.data.has(ACTIVE_GALLERY_KEY), false);
});

test("loadActiveGallery mengembalikan pilihan yang masih berlaku", () => {
  const storage = fakeStorage();
  const saved = gallery();
  storage.data.set(ACTIVE_GALLERY_KEY, JSON.stringify(saved));

  assert.deepEqual(loadActiveGallery(NOW, storage), saved);
});

test("loadActiveGallery aman untuk JSON rusak dan penyimpanan rusak", () => {
  const broken = fakeStorage();
  broken.data.set(ACTIVE_GALLERY_KEY, "bukan json");

  assert.equal(loadActiveGallery(NOW, broken), null);
  assert.equal(loadActiveGallery(NOW, fakeStorage({ failOn: "get" })), null);
  assert.equal(loadActiveGallery(NOW, null), null);
});

test("saveActiveGallery melaporkan kegagalan, bukan melempar", () => {
  assert.equal(saveActiveGallery(gallery(), fakeStorage()), true);
  assert.equal(saveActiveGallery(gallery(), fakeStorage({ failOn: "set" })), false);
  assert.equal(saveActiveGallery(gallery(), null), false);
});

test("clearActiveGallery tidak melempar walau penyimpanan rusak", () => {
  assert.doesNotThrow(() => clearActiveGallery(fakeStorage({ failOn: "remove" })));
  assert.doesNotThrow(() => clearActiveGallery(null));
});

test("activeFromSummary memakai URL publik yang dihitung server", () => {
  // URL tidak disusun ulang di klien: origin yang dipakai saat memilih bisa
  // berbeda dari origin yang sedang dibuka operator.
  const active = activeFromSummary(
    { id: "gal-9", hash: "Zz9", expiresAt: LATER, url: "https://foto.soyuz.my.id/a/Zz9" },
    "Ulang tahun",
  );

  assert.deepEqual(active, {
    id: "gal-9",
    hash: "Zz9",
    url: "https://foto.soyuz.my.id/a/Zz9",
    label: "Ulang tahun",
    expiresAt: LATER,
  });
});

test("save lalu load memberi hasil yang sama persis", () => {
  const storage = fakeStorage();
  const saved = gallery();

  saveActiveGallery(saved, storage);

  assert.deepEqual(loadActiveGallery(NOW, storage), saved);
});
