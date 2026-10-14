/**
 * Tes jembatan klip → jalur simpan.
 *
 * Yang dijaga: **klip tanpa byte tidak pernah masuk antrian** (operator tidak
 * boleh melihat "1 tersimpan" untuk berkas kosong), **tipe konten yang tidak
 * dikenal API ditolak di sini** (bukan baru ketahuan saat upload gagal), dan
 * **poster yang gagal tidak menyeret klipnya** — tamu tetap pulang bawa video.
 *
 * `decodeFrames` juga diuji di sini: foto yang rusak **dilewati**, bukan
 * menggagalkan seluruh animasi, dan nomor urut mengikuti posisi asli supaya
 * urutan tamu tidak tertukar.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { VideoClip } from "./videoSession.ts";
import { asUploadContentType, clipToIntake, decodeFrames, describeClip } from "./videoIntake.ts";

function clip(patch: Partial<VideoClip> = {}): VideoClip {
  return {
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "video/webm" }),
    width: 1280,
    height: 720,
    durationSec: 4.5,
    extension: "webm",
    contentType: "video/webm",
    filename: "video-000.webm",
    index: 0,
    ...patch,
  };
}

test("asUploadContentType menerima yang dikenal API dan menolak sisanya", () => {
  assert.equal(asUploadContentType("video/webm"), "video/webm");
  assert.equal(asUploadContentType("video/mp4"), "video/mp4");
  assert.equal(asUploadContentType("image/png"), "image/png");
  assert.equal(asUploadContentType("video/x-matroska"), null);
  assert.equal(asUploadContentType(""), null);
});

test("klip kosong tidak pernah masuk antrian", async () => {
  const photo = await clipToIntake(clip({ blob: new Blob([], { type: "video/webm" }) }));
  assert.equal(photo, null);
});

test("tipe konten tak dikenal ditolak sebelum sampai upload", async () => {
  const photo = await clipToIntake(clip({ contentType: "video/x-matroska" }));
  assert.equal(photo, null);
});

test("poster yang gagal tidak menggagalkan klip", async () => {
  const photo = await clipToIntake(clip(), {
    makeThumb: async () => {
      throw new Error("codec tidak ada");
    },
  });

  assert.notEqual(photo, null);
  assert.equal(photo?.thumb, null);
  assert.equal(photo?.contentType, "video/webm");
  assert.equal(photo?.filename, "video-000.webm");
});

test("poster yang berhasil ikut terbawa", async () => {
  const poster = new Blob([new Uint8Array([9])], { type: "image/webp" });
  const photo = await clipToIntake(clip(), { makeThumb: async () => poster });

  assert.equal(photo?.thumb, poster);
  assert.equal(photo?.width, 1280);
  assert.equal(photo?.height, 720);
});

test("nomor urut: opsi menang, kalau tidak ada pakai nomor klip", async () => {
  const fromClip = await clipToIntake(clip({ index: 3 }));
  assert.equal(fromClip?.index, 3);

  const overridden = await clipToIntake(clip({ index: 3 }), { index: 7 });
  assert.equal(overridden?.index, 7);
});

test("decodeFrames melewati foto rusak dan menjaga nomor urut asli", async () => {
  const blobs = [
    new Blob([new Uint8Array([1])]),
    new Blob([new Uint8Array([2])]),
    new Blob([new Uint8Array([3])]),
  ];

  const frames = await decodeFrames(blobs, async (blob) => {
    // Foto kedua rusak: dekoder mengembalikan `null`.
    if (blob.size === 1 && blob === blobs[1]) return null;
    return { image: { tag: "bitmap" }, width: 100, height: 50 };
  });

  assert.deepEqual(
    frames.map((frame) => frame.index),
    [0, 2],
  );
  assert.equal(frames[0]?.width, 100);
  assert.equal(frames[1]?.height, 50);
});

test("decodeFrames tidak melempar kalau dekoder melempar", async () => {
  const frames = await decodeFrames([new Blob([new Uint8Array([1])])], async () => {
    throw new Error("dekode gagal");
  });

  assert.deepEqual(frames, []);
});

test("decodeFrames membuang dimensi nol (bukan frame yang bisa digambar)", async () => {
  const frames = await decodeFrames([new Blob([new Uint8Array([1])])], async () => ({
    image: {},
    width: 0,
    height: 720,
  }));

  assert.deepEqual(frames, []);
});

test("describeClip memuat nama, dimensi, durasi, dan ukuran", () => {
  const summary = describeClip(clip({ durationSec: 2.04 }));
  assert.match(summary, /video-000\.webm/);
  assert.match(summary, /1280×720/);
  assert.match(summary, /2 dtk/);
  assert.match(summary, /MB/);
});
