/**
 * Tes jembatan `Frame[]` → `IntakePhoto`.
 *
 * Dua janji:
 *
 *   1. **Urutan ditentukan `shotIndex`, bukan urutan array.** Kalau urutannya
 *      bergeser, tamu melihat halaman galeri dengan urutan tertukar — bug yang
 *      tidak kelihatan sampai ada yang membandingkan dengan cetakannya.
 *   2. **Thumbnail boleh gagal sendiri.** Tanpa canvas (jsdom, browser tua),
 *      `makeThumb` mengembalikan `null`; foto besarnya tetap harus ikut.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Frame } from "../transports/types.ts";
import { CAPTURE_CONTENT_TYPE, captureFilename, framesToIntake } from "./composedToIntake.ts";

function frame(shotIndex: number, overrides: Partial<Frame> = {}): Frame {
  return {
    id: `frame-${shotIndex}`,
    blob: new Blob([`foto-${shotIndex}`], { type: "image/jpeg" }),
    width: 4000,
    height: 3000,
    shotIndex,
    capturedAt: 1_700_000_000_000,
    source: "webcam",
    strategy: "image-capture",
    ...overrides,
  };
}

test("captureFilename mengurutkan berkas dengan benar sampai dua digit", () => {
  // `10.jpg` harus datang setelah `9.jpg`, bukan setelah `1.jpg`.
  assert.equal(captureFilename(0), "01.jpg");
  assert.equal(captureFilename(9), "10.jpg");
  assert.equal(captureFilename(10), "11.jpg");
  assert.equal(captureFilename(0, "png"), "01.png");
});

test("framesToIntake mengurutkan berdasarkan shotIndex, bukan urutan array", async () => {
  const photos = await framesToIntake([frame(2), frame(0), frame(1)]);

  assert.deepEqual(photos.map((p) => p.index), [0, 1, 2]);
  assert.deepEqual(photos.map((p) => p.filename), ["01.jpg", "02.jpg", "03.jpg"]);
});

test("framesToIntake membawa metadatanya apa adanya", async () => {
  const [photo] = await framesToIntake([frame(0, { width: 6000, height: 4000 })]);

  assert.equal(photo?.width, 6000);
  assert.equal(photo?.height, 4000);
  assert.equal(photo?.contentType, CAPTURE_CONTENT_TYPE);
  assert.equal(photo?.contentType, "image/jpeg");
  assert.equal(await photo?.blob.text(), "foto-0");
});

test("tanpa pembuat thumbnail, thumb-nya null — bukan kegagalan", async () => {
  const [photo] = await framesToIntake([frame(0)]);
  assert.equal(photo?.thumb, null);
});

test("thumbnail yang gagal tidak menggagalkan fotonya", async () => {
  const photos = await framesToIntake([frame(0), frame(1)], {
    makeThumb: async () => {
      throw new Error("canvas tidak ada");
    },
  });

  assert.equal(photos.length, 2);
  assert.deepEqual(photos.map((p) => p.thumb), [null, null]);
  assert.equal(await photos[0]?.blob.text(), "foto-0");
});

test("thumbnail yang berhasil dipakai, dan hanya untuk frame itu", async () => {
  const photos = await framesToIntake([frame(0), frame(1)], {
    // Hanya frame pertama yang "berhasil" dibuatkan thumbnail.
    makeThumb: async (blob) => ((await blob.text()) === "foto-0" ? new Blob(["kecil"]) : null),
  });

  assert.equal(await photos[0]?.thumb?.text(), "kecil");
  assert.equal(photos[1]?.thumb, null);
});

test("daftar kosong menghasilkan daftar kosong", async () => {
  assert.deepEqual(await framesToIntake([]), []);
});

// ── filter (Fase 6) ───────────────────────────────────────────────────────

test("process dipakai untuk mengganti byte & dimensi foto", async () => {
  const [photo] = await framesToIntake([frame(0, { width: 4000, height: 3000 })], {
    // Rotasi 90°: lebar/tinggi bertukar.
    process: async () => ({ blob: new Blob(["terfilter"]), width: 3000, height: 4000 }),
  });

  assert.equal(await photo?.blob.text(), "terfilter");
  assert.equal(photo?.width, 3000);
  assert.equal(photo?.height, 4000);
});

test("process yang mengembalikan null tidak mengubah foto", async () => {
  const [photo] = await framesToIntake([frame(0)], { process: async () => null });

  assert.equal(await photo?.blob.text(), "foto-0");
  assert.equal(photo?.width, 4000);
});

test("process yang melempar tidak menggagalkan foto — blob asli dipakai", async () => {
  const photos = await framesToIntake([frame(0), frame(1)], {
    process: async () => {
      throw new Error("decode gagal");
    },
  });

  assert.equal(photos.length, 2);
  assert.equal(await photos[0]?.blob.text(), "foto-0");
  assert.equal(await photos[1]?.blob.text(), "foto-1");
});

test("process yang mengembalikan blob kosong diabaikan", async () => {
  const [photo] = await framesToIntake([frame(0)], {
    process: async () => ({ blob: new Blob([]), width: 10, height: 10 }),
  });

  assert.equal(await photo?.blob.text(), "foto-0");
  assert.equal(photo?.width, 4000);
});

test("thumbnail dibuat dari hasil filter, bukan dari foto mentah", async () => {
  let thumbSource = "";
  await framesToIntake([frame(0)], {
    process: async () => ({ blob: new Blob(["terfilter"]), width: 100, height: 100 }),
    makeThumb: async (blob) => {
      thumbSource = await blob.text();
      return new Blob(["thumb"]);
    },
  });

  assert.equal(thumbSource, "terfilter");
});
