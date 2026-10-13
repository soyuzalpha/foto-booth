/**
 * Tes tata letak key bucket.
 *
 * Yang dijaga di sini bukan "string-nya benar" tapi **dua sisi menghitung hal
 * yang sama**. Kalau API dan studio berbeda soal key, upload sukses tapi foto
 * tidak ketemu — dan tidak ada error di mana pun. Jadi key di-assert literal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  albumPrefixes,
  extForMime,
  keyBelongsToAlbum,
  mimeForExt,
  ogKey,
  photoKey,
  thumbKey,
} from "./storage.ts";

test("key foto = photos/<hash>/<id>.<ext>", () => {
  assert.equal(photoKey("ab12", "p1", "image/jpeg"), "photos/ab12/p1.jpg");
  assert.equal(photoKey("ab12", "p1", "image/png"), "photos/ab12/p1.png");
  assert.equal(photoKey("ab12", "p1", "image/webp"), "photos/ab12/p1.webp");
});

test("thumb sejajar dengan foto, cuma beda prefix", () => {
  assert.equal(thumbKey("ab12", "p1", "image/jpeg"), "thumbs/ab12/p1.jpg");
});

test("MIME tak dikenal → bin, tidak pernah ditebak", () => {
  assert.equal(extForMime("image/gif"), "bin");
  assert.equal(extForMime("application/octet-stream"), "bin");
  assert.equal(extForMime("IMAGE/JPEG"), "jpg", "huruf besar tetap cocok");
});

test("kebalikan ekstensi→MIME konsisten dengan MIME→ekstensi", () => {
  for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
    assert.equal(mimeForExt(extForMime(mime)), mime);
  }
  assert.equal(mimeForExt("gif"), "application/octet-stream");
});

test("og satu berkas per album", () => {
  assert.equal(ogKey("ab12"), "og/ab12.png");
});

test("prefix album mencakup foto, thumb, dan og", () => {
  assert.deepEqual(albumPrefixes("ab12"), [
    "photos/ab12/",
    "thumbs/ab12/",
    "og/ab12.png",
  ]);
});

test("key album lain ditolak — klien tidak bisa mendaftarkan objek orang lain", () => {
  assert.equal(keyBelongsToAlbum("photos/ab12/p1.jpg", "ab12"), true);
  assert.equal(keyBelongsToAlbum("thumbs/ab12/p1.jpg", "ab12"), true);
  // Prefix tetangga yang mirip: `ab120` BUKAN `ab12`.
  assert.equal(keyBelongsToAlbum("photos/ab120/p1.jpg", "ab12"), false);
  assert.equal(keyBelongsToAlbum("photos/zz99/p1.jpg", "ab12"), false);
  // Path traversal & prefix asing.
  assert.equal(keyBelongsToAlbum("photos/ab12/../../etc/passwd", "ab12"), false, "`..` ditolak");
  assert.equal(keyBelongsToAlbum("photos/ab12/\u0000x", "ab12"), false, "karakter kontrol ditolak");
  assert.equal(keyBelongsToAlbum("og/ab12.png", "ab12"), false, "og bukan berkas yang didaftarkan klien");
  assert.equal(keyBelongsToAlbum("photos/ab12", "ab12"), false, "tanpa slash = bukan anak album");
});
