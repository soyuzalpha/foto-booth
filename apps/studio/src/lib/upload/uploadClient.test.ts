/**
 * Tes klien HTTP upload.
 *
 * Aturan Fase 5 yang diuji di sini, dan alasan masing-masing penting:
 *
 *   · **PUT ke bucket TIDAK memakai header auth.** Tanda tangannya ada di
 *     query string. Menambahkan `Authorization` membuat bucket melihat dua
 *     skema auth sekaligus dan menolak dengan tanda tangan tidak cocok —
 *     gejala yang menyesatkan ("URL-nya salah") padahal header-nya.
 *   · **Balasan upload-url divalidasi skema.** Balasan yang cacat harus jadi
 *     error jelas di sini, bukan `undefined` yang meledak di runner.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHttpUploadClient, UploadHttpError } from "./uploadClient.ts";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function recordingFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SIGNED = {
  photoId: "p1",
  uploadUrl: "https://bucket/asli?sig=abc",
  thumbUploadUrl: "https://bucket/thumb?sig=def",
  key: "photos/gal-1/p1.jpg",
  thumbKey: "thumbs/gal-1/p1.jpg",
  expiresAt: "2026-01-01T00:15:00.000Z",
};

test("signUpload memakai token operator dan mengembalikan balasan yang tervalidasi", async () => {
  const { fetch, calls } = recordingFetch(() => json(SIGNED));
  const client = createHttpUploadClient({ token: "tok-123", fetch });

  const result = await client.signUpload("gal-1", {
    contentType: "image/jpeg",
    bytes: 1000,
    width: 1920,
    height: 1080,
  });

  assert.deepEqual(result, SIGNED);
  assert.equal(calls[0]?.url, "/v1/galleries/gal-1/upload-url");
  assert.equal(calls[0]?.init?.method, "POST");
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer tok-123");
});

test("signUpload melempar UploadHttpError memakai pesan dari API", async () => {
  const { fetch } = recordingFetch(() => json({ message: "galeri tidak ada" }, 404));
  const client = createHttpUploadClient({ token: "tok", fetch });

  await assert.rejects(
    () => client.signUpload("gal-1", { contentType: "image/jpeg", bytes: 1, width: 1, height: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof UploadHttpError);
      assert.equal(error.status, 404);
      assert.equal(error.message, "galeri tidak ada");
      return true;
    },
  );
});

test("signUpload menolak balasan yang tidak dikenali skema", async () => {
  const { fetch } = recordingFetch(() => json({ photoId: "p1" }));
  const client = createHttpUploadClient({ token: "tok", fetch });

  await assert.rejects(
    () => client.signUpload("gal-1", { contentType: "image/jpeg", bytes: 1, width: 1, height: 1 }),
    /tidak dikenali/,
  );
});

test("putBytes TIDAK mengirim header Authorization", async () => {
  const { fetch, calls } = recordingFetch(() => new Response(null, { status: 200 }));
  const client = createHttpUploadClient({ token: "tok-rahasia", fetch });

  await client.putBytes("https://bucket/asli?sig=abc", new Blob(["x"]), "image/jpeg");

  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["content-type"], "image/jpeg");
  assert.equal(calls[0]?.init?.method, "PUT");
});

test("putBytes melempar saat bucket menolak (mis. tanda tangan kedaluwarsa)", async () => {
  const { fetch } = recordingFetch(() => new Response("AccessDenied", { status: 403 }));
  const client = createHttpUploadClient({ token: "tok", fetch });

  await assert.rejects(
    () => client.putBytes("https://bucket/asli", new Blob(["x"]), "image/jpeg"),
    (error: unknown) => {
      assert.ok(error instanceof UploadHttpError);
      assert.equal(error.status, 403);
      // Balasan bukan JSON → pakai status, bukan body mentah.
      assert.equal(error.message, "HTTP 403");
      return true;
    },
  );
});

test("registerPhoto mengirim body yang tervalidasi skema", async () => {
  const { fetch, calls } = recordingFetch(() =>
    json({
      id: "p1",
      galleryId: "gal-1",
      key: "k",
      thumbKey: "tk",
      width: 1920,
      height: 1080,
      bytes: 1000,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  const client = createHttpUploadClient({ token: "tok", fetch });

  await client.registerPhoto("gal-1", {
    photoId: "p1",
    key: "photos/gal-1/p1.jpg",
    thumbKey: "thumbs/gal-1/p1.jpg",
    width: 1920,
    height: 1080,
    bytes: 1000,
  });

  assert.equal(calls[0]?.url, "/v1/galleries/gal-1/photos");
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(body.photoId, "p1");
  assert.equal(body.key, "photos/gal-1/p1.jpg");
});

test("baseUrl dipakai untuk request ke API, tapi tidak untuk URL bucket", async () => {
  const { fetch, calls } = recordingFetch((url) =>
    url.startsWith("https://bucket") ? new Response(null, { status: 200 }) : json(SIGNED),
  );
  const client = createHttpUploadClient({ token: "tok", baseUrl: "https://api.foto.test", fetch });

  await client.signUpload("gal-1", { contentType: "image/jpeg", bytes: 1, width: 1, height: 1 });
  await client.putBytes("https://bucket/asli", new Blob(["x"]), "image/jpeg");

  assert.equal(calls[0]?.url, "https://api.foto.test/v1/galleries/gal-1/upload-url");
  assert.equal(calls[1]?.url, "https://bucket/asli");
});
