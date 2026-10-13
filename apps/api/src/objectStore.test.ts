/**
 * Tes penandatanganan S3.
 *
 * Sebagian besar tes di sini adalah **tes karakterisasi**: nilainya diambil dari
 * implementasi yang sudah terbukti jalan melawan Garage sungguhan (lihat
 * `fb-s3-probe.mjs`). Gunanya bukan membuktikan rumusnya benar — itu dibuktikan
 * Garage — tapi menahan perubahan yang diam-diam mengubah signature, karena
 * `SignatureDoesNotMatch` tidak memberi tahu bagian mana yang berubah.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  authorizationHeader,
  deletePrefix,
  encodeS3Path,
  listKeys,
  presignGet,
  presignPut,
  s3ConfigFromEnv,
  ObjectStoreError,
  type S3Config,
} from "./objectStore.ts";

const CONFIG: S3Config = {
  endpoint: "http://127.0.0.1:3900",
  region: "garage",
  bucket: "foto-booth",
  accessKeyId: "GK1234567890abcdef",
  secretAccessKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

const NOW = new Date("2026-10-12T13:30:00.000Z");

test("encodeS3Path menjaga `/`, meng-encode spasi & `!`", () => {
  assert.equal(encodeS3Path("photos/ab12/p1.jpg"), "photos/ab12/p1.jpg");
  assert.equal(encodeS3Path("a b/c!d"), "a%20b/c%21d");
  assert.equal(encodeS3Path("x+y/z"), "x%2By/z");
});

test("presignPut: URL path-style, kanonik, signature stabil", () => {
  const url = presignPut(CONFIG, "photos/ab12/p1.jpg", {
    expiresIn: 900,
    contentType: "image/jpeg",
    now: NOW,
  });

  assert.equal(
    url,
    "http://127.0.0.1:3900/foto-booth/photos/ab12/p1.jpg" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=GK1234567890abcdef%2F20261012%2Fgarage%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20261012T133000Z" +
      "&X-Amz-Expires=900" +
      "&X-Amz-SignedHeaders=content-type%3Bhost" +
      "&X-Amz-Signature=c883702af1e7e252b0f513ff7c7403835ad7fff956e1de8b770882efdfac7cd6",
  );
});

test("presignGet: hanya `host` yang ditandatangani (tanpa content-type)", () => {
  const url = presignGet(CONFIG, "photos/ab12/p1.jpg", { expiresIn: 900, now: NOW });
  assert.ok(url.includes("X-Amz-SignedHeaders=host"));
  assert.ok(!url.includes("content-type"));
  assert.equal(
    url,
    "http://127.0.0.1:3900/foto-booth/photos/ab12/p1.jpg" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=GK1234567890abcdef%2F20261012%2Fgarage%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20261012T133000Z" +
      "&X-Amz-Expires=900" +
      "&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=31894816be6d60b2e3663f3e12787ffb0237bdaf1cb155f073d0a40639a421d7",
  );
});

test("authorizationHeader: urutan SignedHeaders terurut & signature stabil", () => {
  const header = authorizationHeader(
    CONFIG,
    "GET",
    "/foto-booth",
    { "list-type": "2", prefix: "photos/ab12/", "max-keys": "1000" },
    NOW,
  );
  assert.equal(
    header,
    "AWS4-HMAC-SHA256 Credential=GK1234567890abcdef/20261012/garage/s3/aws4_request, " +
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
      "Signature=b29c3a96793040da5e55669870a36622246bd3b8ccca1856ee62facb92e5e9f0",
  );
});

test("signature bergantung pada key, isi, dan waktu", () => {
  const a = presignPut(CONFIG, "photos/ab12/a.jpg", { expiresIn: 900, contentType: "image/jpeg", now: NOW });
  const b = presignPut(CONFIG, "photos/ab12/b.jpg", { expiresIn: 900, contentType: "image/jpeg", now: NOW });
  const c = presignPut(CONFIG, "photos/ab12/a.jpg", { expiresIn: 900, contentType: "image/png", now: NOW });
  const d = presignPut(CONFIG, "photos/ab12/a.jpg", {
    expiresIn: 900,
    contentType: "image/jpeg",
    now: new Date(NOW.getTime() + 1000),
  });

  const sig = (url: string) => url.slice(url.indexOf("&X-Amz-Signature=") + 17);
  assert.notEqual(sig(a), sig(b), "key beda → signature beda");
  assert.notEqual(sig(a), sig(c), "content-type beda → signature beda");
  assert.notEqual(sig(a), sig(d), "waktu beda → signature beda");
  assert.match(sig(a), /^[0-9a-f]{64}$/);
});

test("rahasia yang beda → signature beda (kunci signing benar-benar dipakai)", () => {
  const other = { ...CONFIG, secretAccessKey: "f".repeat(64) };
  const a = presignPut(CONFIG, "photos/ab12/a.jpg", { expiresIn: 900, contentType: "image/jpeg", now: NOW });
  const b = presignPut(other, "photos/ab12/a.jpg", { expiresIn: 900, contentType: "image/jpeg", now: NOW });
  assert.notEqual(a, b);
});

/* ---- Operasi server-side dengan `fetch` palsu ---------------------- */

function fakeFetch(routes: Record<string, { status: number; body: string }>) {
  const calls: { url: string; method: string; authorization: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url: String(url),
      method,
      authorization: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ""),
    });
    const found = routes[method];
    if (found === undefined) return new Response("not found", { status: 404 });
    return new Response(found.body, { status: found.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

test("listKeys mem-parse XML dan mendekode entity", async () => {
  const { fetchImpl, calls } = fakeFetch({
    GET: {
      status: 200,
      body: "<ListBucketResult><IsTruncated>false</IsTruncated>" +
        "<Contents><Key>photos/ab12/a&amp;b.jpg</Key></Contents>" +
        "<Contents><Key>photos/ab12/c.jpg</Key></Contents></ListBucketResult>",
    },
  });

  const keys = await listKeys(CONFIG, "photos/ab12/", { fetch: fetchImpl, now: () => NOW });
  assert.deepEqual(keys, ["photos/ab12/a&b.jpg", "photos/ab12/c.jpg"]);
  assert.ok(calls[0]?.url.includes("list-type=2"));
  assert.ok(calls[0]?.url.includes("prefix=photos%2Fab12%2F"), "prefix di-encode di query");
  assert.ok(calls[0]?.authorization.startsWith("AWS4-HMAC-SHA256 Credential="));
});

test("listKeys mengikuti NextContinuationToken sampai halaman terakhir", async () => {
  let page = 0;
  const fetchImpl = (async (url: string | URL) => {
    page += 1;
    const u = String(url);
    if (page === 1) {
      assert.ok(!u.includes("continuation-token"));
      return new Response(
        "<ListBucketResult><IsTruncated>true</IsTruncated>" +
          "<Contents><Key>photos/a/1.jpg</Key></Contents>" +
          "<NextContinuationToken>tok/1+2</NextContinuationToken></ListBucketResult>",
        { status: 200 },
      );
    }
    assert.ok(u.includes("continuation-token=tok%2F1%2B2"), "token di-encode");
    return new Response(
      "<ListBucketResult><IsTruncated>false</IsTruncated>" +
        "<Contents><Key>photos/a/2.jpg</Key></Contents></ListBucketResult>",
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;

  const keys = await listKeys(CONFIG, "photos/a/", { fetch: fetchImpl, now: () => NOW });
  assert.deepEqual(keys, ["photos/a/1.jpg", "photos/a/2.jpg"]);
  assert.equal(page, 2);
});

test("deletePrefix menghapus tiap key hasil list", async () => {
  const deleted: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === "GET") {
      return new Response(
        "<ListBucketResult><IsTruncated>false</IsTruncated>" +
          "<Contents><Key>thumbs/x/1.jpg</Key></Contents>" +
          "<Contents><Key>thumbs/x/2.jpg</Key></Contents></ListBucketResult>",
        { status: 200 },
      );
    }
    deleted.push(decodeURIComponent(String(url).split("/foto-booth/")[1] ?? ""));
    // 200 dengan body kosong — `new Response` menolak body pada 204.
    return new Response(null, { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  const removed = await deletePrefix(CONFIG, "thumbs/x/", { fetch: fetchImpl, now: () => NOW });
  assert.equal(removed, 2);
  assert.deepEqual(deleted, ["thumbs/x/1.jpg", "thumbs/x/2.jpg"]);
});

test("balasan S3 non-2xx jadi ObjectStoreError dengan status aslinya", async () => {
  const fetchImpl = (async () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })) as unknown as typeof globalThis.fetch;
  await assert.rejects(
    () => listKeys(CONFIG, "photos/", { fetch: fetchImpl, now: () => NOW }),
    (error: unknown) => {
      assert.ok(error instanceof ObjectStoreError);
      assert.equal(error.status, 403);
      assert.match(error.message, /AccessDenied/);
      return true;
    },
  );
});

/* ---- Konfigurasi dari environment -------------------------------- */

test("s3ConfigFromEnv melempar nama variabel yang kurang, bukan diam-diam kosong", () => {
  assert.throws(
    () => s3ConfigFromEnv({ S3_ENDPOINT: "http://x", S3_REGION: "garage" } as NodeJS.ProcessEnv),
    /S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/,
  );
});

test("s3ConfigFromEnv membuang trailing slash endpoint", () => {
  const config = s3ConfigFromEnv({
    S3_ENDPOINT: "http://127.0.0.1:3900/",
    S3_REGION: "garage",
    S3_BUCKET: "foto-booth",
    S3_ACCESS_KEY_ID: "k",
    S3_SECRET_ACCESS_KEY: "s",
  } as NodeJS.ProcessEnv);
  assert.equal(config.endpoint, "http://127.0.0.1:3900");
});
