/**
 * Object store S3-compatible (Garage di server sendiri) — SigV4 ditulis tangan.
 *
 * Kenapa tidak pakai `@aws-sdk/client-s3`: SDK-nya ~30 MB dependensi untuk tiga
 * operasi (PUT presigned, list, delete). SigV4 sudah stabil bertahun-tahun dan
 * cuma butuh `node:crypto`. Yang penting bukan hemat ukuran, tapi: **signature
 * yang salah gagal dengan `SignatureDoesNotMatch` tanpa menjelaskan bagian mana
 * yang salah** — jadi lebih mudah di-debug kalau kanonikalisasinya terlihat
 * sebagai kode biasa, bukan terkubur di dalam SDK.
 *
 * Yang dijaga:
 *   · **Path-style.** Garage melayani `http://host:3900/<bucket>/<key>`, bukan
 *     `<bucket>.host`. Kalau hostname virtual dipakai, `Host` header jadi beda
 *     dan signature ikut beda.
 *   · **`content-type` IKUT ditandatangani untuk PUT.** Ini jebakan klasik:
 *     URL presigned yang hanya menandatangani `host` akan ditolak
 *     `SignatureDoesNotMatch` kalau klien mengirim `Content-Type`. Karena kita
 *     yang menulis kliennya, kita tandatangani dua-duanya dan klien wajib
 *     mengirim header itu.
 *   · **`UNSIGNED-PAYLOAD` untuk PUT.** Saat menandatangani kita belum tahu
 *     isi berkasnya, jadi hash payload tidak bisa dihitung.
 *   · **Waktu disuntik.** Signature bergantung pada jam; tanpa `now`
 *     injectable, tes jadi bergantung waktu dinding.
 */

import { createHash, createHmac } from "node:crypto";

export interface S3Config {
  /** Tanpa trailing slash, mis. `http://127.0.0.1:3900`. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface PresignOptions {
  /** Detik. Maksimum yang diterima S3 = 604800 (7 hari). */
  expiresIn: number;
  now?: Date;
}

export interface PresignPutOptions extends PresignOptions {
  /** Wajib: header ini ikut ditandatangani. */
  contentType: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
/** SHA-256 dari string kosong — dipakai untuk GET/DELETE/LIST tanpa body. */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export class ObjectStoreError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "ObjectStoreError";
    this.status = status;
  }
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/** `20261012T133000Z` */
function amzDate(now: Date): string {
  return `${dateStamp(now)}T${now.toISOString().slice(11, 19).replace(/:/g, "")}Z`;
}

/** `20261012` */
function dateStamp(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Encode satu path S3: setiap segmen di-encode, `/` dibiarkan.
 *
 * `encodeURIComponent` tidak menyentuh `!'()*`, padahal AWS meminta karakter
 * itu di-encode. Key kita (base64url + `/` + `.`) tidak memuatnya, tapi fungsi
 * ini tetap benar untuk key sembarang.
 */
export function encodeS3Path(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

/** Query string kanonik: nama terurut, nilai di-encode (termasuk `/` → `%2F`). */
function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(params[name] ?? "")}`)
    .join("&");
}

function signingKey(config: S3Config, stamp: string): Buffer {
  const kDate = hmac(`AWS4${config.secretAccessKey}`, stamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

function scope(config: S3Config, stamp: string): string {
  return `${stamp}/${config.region}/${SERVICE}/aws4_request`;
}

/** Bentuk kanonik dari URL, dipakai dua-duanya (presign & header auth). */
interface CanonicalRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
}

function buildCanonicalRequest(request: CanonicalRequest): {
  canonicalRequest: string;
  signedHeaders: string;
} {
  const names = Object.keys(request.headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${(request.headers[name] ?? "").trim()}\n`)
    .join("");
  const signedHeaders = names.join(";");

  return {
    canonicalRequest: [
      request.method,
      request.path,
      canonicalQuery(request.query),
      canonicalHeaders,
      signedHeaders,
      request.payloadHash,
    ].join("\n"),
    signedHeaders,
  };
}

function signatureFor(
  config: S3Config,
  canonicalRequest: string,
  date: Date,
): { signature: string; scopeValue: string; amzDateValue: string } {
  const stamp = dateStamp(date);
  const amz = amzDate(date);
  const scopeValue = scope(config, stamp);
  const stringToSign = [ALGORITHM, amz, scopeValue, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(config, stamp), stringToSign).toString("hex");
  return { signature, scopeValue, amzDateValue: amz };
}

/** URL path-style lengkap: `/bucket/key`. */
function objectPath(config: S3Config, key: string): string {
  return `/${encodeS3Path(config.bucket)}/${encodeS3Path(key)}`;
}

/** URL presigned untuk `PUT` — studio upload langsung ke bucket, lewat API nol byte. */
export function presignPut(config: S3Config, key: string, options: PresignPutOptions): string {
  const now = options.now ?? new Date();
  const path = objectPath(config, key);
  const host = new URL(config.endpoint).host;
  const stamp = dateStamp(now);
  const scopeValue = scope(config, stamp);
  const amz = amzDate(now);

  const query: Record<string, string> = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${config.accessKeyId}/${scopeValue}`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(options.expiresIn),
    "X-Amz-SignedHeaders": "content-type;host",
  };

  const { canonicalRequest } = buildCanonicalRequest({
    method: "PUT",
    path,
    query,
    headers: { "content-type": options.contentType, host },
    payloadHash: UNSIGNED_PAYLOAD,
  });

  const { signature } = signatureFor(config, canonicalRequest, now);
  return `${config.endpoint}${path}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

/** URL presigned untuk `GET` — dipakai kalau berkas perlu link sementara. */
export function presignGet(config: S3Config, key: string, options: PresignOptions): string {
  const now = options.now ?? new Date();
  const path = objectPath(config, key);
  const host = new URL(config.endpoint).host;
  const stamp = dateStamp(now);
  const scopeValue = scope(config, stamp);
  const amz = amzDate(now);

  const query: Record<string, string> = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${config.accessKeyId}/${scopeValue}`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(options.expiresIn),
    "X-Amz-SignedHeaders": "host",
  };

  const { canonicalRequest } = buildCanonicalRequest({
    method: "GET",
    path,
    query,
    headers: { host },
    payloadHash: UNSIGNED_PAYLOAD,
  });

  const { signature } = signatureFor(config, canonicalRequest, now);
  return `${config.endpoint}${path}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

/** Header `Authorization` untuk operasi server-side (list/delete/head). */
export function authorizationHeader(
  config: S3Config,
  method: string,
  path: string,
  query: Record<string, string>,
  now: Date,
): string {
  const host = new URL(config.endpoint).host;
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method,
    path,
    query,
    headers: { host, "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": amzDate(now) },
    payloadHash: EMPTY_SHA256,
  });

  const { signature, scopeValue } = signatureFor(config, canonicalRequest, now);
  return `${ALGORITHM} Credential=${config.accessKeyId}/${scopeValue}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** GET/DELETE ke S3 dengan header auth. `fetch` injectable buat tes. */
export interface S3Deps {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

async function s3Request(
  config: S3Config,
  method: string,
  path: string,
  query: Record<string, string>,
  deps: S3Deps,
): Promise<string> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = (deps.now ?? (() => new Date()))();
  const host = new URL(config.endpoint).host;
  const url = `${config.endpoint}${path}${Object.keys(query).length > 0 ? `?${canonicalQuery(query)}` : ""}`;

  const response = await doFetch(url, {
    method,
    headers: {
      authorization: authorizationHeader(config, method, path, query, now),
      host,
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": amzDate(now),
    },
  });

  const body = await response.text();
  if (!response.ok) {
    throw new ObjectStoreError(
      `S3 ${method} ${path} gagal (${response.status}): ${body.slice(0, 300)}`,
      response.status,
    );
  }
  return body;
}

/** Hapus satu objek. Menghapus objek yang tidak ada tetap sukses (idempoten). */
export async function deleteObject(config: S3Config, key: string, deps: S3Deps = {}): Promise<void> {
  await s3Request(config, "DELETE", objectPath(config, key), {}, deps);
}

/**
 * GET satu objek dan kembalikan alirannya.
 *
 * Sengaja **tidak** memakai `s3Request`: yang itu membaca seluruh body jadi
 * string, dan foto 25 MB yang jadi string UTF-8 akan rusak (byte non-UTF-8
 * diganti U+FFFD). Di sini body diteruskan apa adanya.
 *
 * `contentType`/`contentLength` dikembalikan supaya pemanggil bisa meneruskan
 * header yang benar ke tamu tanpa menebak dari ekstensi key.
 */
export async function getObject(
  config: S3Config,
  key: string,
  deps: S3Deps = {},
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; contentLength: number | null }> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = (deps.now ?? (() => new Date()))();
  const host = new URL(config.endpoint).host;
  const path = objectPath(config, key);

  const response = await doFetch(`${config.endpoint}${path}`, {
    method: "GET",
    headers: {
      authorization: authorizationHeader(config, "GET", path, {}, now),
      host,
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": amzDate(now),
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ObjectStoreError(
      `S3 GET ${path} gagal (${response.status}): ${detail.slice(0, 300)}`,
      response.status,
    );
  }

  if (response.body === null) {
    throw new ObjectStoreError(`S3 GET ${path} tidak mengembalikan body`, 502);
  }

  const length = response.headers.get("content-length");
  return {
    body: response.body,
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    contentLength: length === null ? null : Number(length),
  };
}

/** Balikkan entitas XML minimal supaya `&amp;` di nama key tidak merusak parsing. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Semua key di bawah `prefix`, diikuti `NextContinuationToken` sampai habis.
 *
 * Dipakai job TTL: hapus galeri kedaluwarsa = hapus SEMUA objek di prefix
 * albumnya. Tanpa paginasi, galeri dengan >1000 objek akan menyisakan sampah
 * yang tidak pernah terhapus.
 */
export async function listKeys(config: S3Config, prefix: string, deps: S3Deps = {}): Promise<string[]> {
  const keys: string[] = [];
  let token: string | null = null;

  do {
    const query: Record<string, string> = {
      "list-type": "2",
      prefix,
      "max-keys": "1000",
    };
    if (token !== null) query["continuation-token"] = token;

    const body = await s3Request(config, "GET", `/${encodeS3Path(config.bucket)}`, query, deps);

    for (const match of body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      keys.push(decodeXmlEntities(match[1] ?? ""));
    }

    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(body);
    const next = body.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
    token = truncated && next ? decodeXmlEntities(next[1] ?? "") : null;
  } while (token !== null);

  return keys;
}

/** Hapus semua objek di bawah `prefix`; mengembalikan jumlah yang dihapus. */
export async function deletePrefix(
  config: S3Config,
  prefix: string,
  deps: S3Deps = {},
): Promise<number> {
  const keys = await listKeys(config, prefix, deps);
  for (const key of keys) await deleteObject(config, key, deps);
  return keys.length;
}

/** Baca konfigurasi dari environment; melempar kalau ada yang kosong. */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config {
  const required = {
    S3_ENDPOINT: env.S3_ENDPOINT,
    S3_REGION: env.S3_REGION,
    S3_BUCKET: env.S3_BUCKET,
    S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => value === undefined || value === "")
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new ObjectStoreError(`env S3 belum lengkap: ${missing.join(", ")}`, 500);
  }

  return {
    endpoint: (required.S3_ENDPOINT ?? "").replace(/\/$/, ""),
    region: required.S3_REGION ?? "",
    bucket: required.S3_BUCKET ?? "",
    accessKeyId: required.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: required.S3_SECRET_ACCESS_KEY ?? "",
  };
}
