/**
 * Rute model AI statis: `/models/*`.
 *
 * Model besar (GFPGAN ONNX ~340 MB) **tidak ikut git** — melebihi batas 100 MB
 * per berkas GitHub. Ia duduk di `$STORAGE_DIR/models/` (di luar repo) dan
 * disajikan read-only di sini; studio mengunduhnya **sekali**, menyimpannya di
 * Cache Storage, lalu bekerja offline.
 *
 * Dua hal yang mudah salah dan karena itu dijaga eksplisit:
 *
 *   1. **Path traversal.** Rute ini menerima nama berkas dari URL. `GET
 *      /models/../../etc/passwd` harus ditolak, bukan dilayani. Nama divalidasi
 *      karakter-per-karakter, lalu hasil `resolve()` dicek benar-benar berada di
 *      dalam `MODELS_DIR` — dua lapis, karena satu lapis gampang bocor.
 *   2. **Bukan direktori.** Permintaan ke folder (atau berkas yang tidak ada)
 *      dijawab 404, bukan stream kosong atau error 500.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import type { FastifyInstance } from "fastify";

import { MODELS_DIR } from "../paths.ts";

/** Prefix publik rute ini (di luar `/v1` — ini berkas statis, bukan API JSON). */
export const MODELS_PREFIX = "/models/";

/** Tipe konten per ekstensi. Semua model biner; default `octet-stream`. */
const CONTENT_TYPES: Record<string, string> = {
  ".onnx": "application/octet-stream",
  ".tflite": "application/octet-stream",
  ".task": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Ekstensi yang boleh muncul di daftar & dilayani. */
const ALLOWED_EXTENSIONS = new Set(Object.keys(CONTENT_TYPES));

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Apakah nama relatif ini aman untuk dilayani.
 *
 * Menolak: kosong, `..`, garis miring pembuka, backslash, byte NUL, dan
 * karakter di luar `[A-Za-z0-9._/-]`. Sisanya lolos ke pemeriksaan kedua
 * (`resolveModelPath`) yang memastikan hasilnya benar-benar di dalam root.
 */
export function isSafeModelName(name: string): boolean {
  if (name.length === 0 || name.length > 256) return false;
  if (name.includes("\0") || name.includes("\\")) return false;
  if (name.startsWith("/") || name.startsWith(".")) return false;
  if (name.includes("..")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

/**
 * Petakan nama relatif → path absolut, atau `null` kalau tidak aman.
 *
 * Pemeriksaan kedua: `resolve()` lalu pastikan path-nya masih di bawah
 * `MODELS_DIR`. Ini menangkap kasus yang lolos regex (mis. lewat symlink teks
 * aneh) sebelum menyentuh disk.
 */
export function resolveModelPath(name: string): string | null {
  if (!isSafeModelName(name)) return null;

  const root = resolve(MODELS_DIR);
  const full = resolve(root, name);
  if (full === root) return null;
  if (!full.startsWith(root + sep)) return null;
  return full;
}

interface ModelEntry {
  name: string;
  size: number;
  url: string;
}

/** Daftar model yang tersedia (satu tingkat, hanya ekstensi yang dikenal). */
export async function listModels(): Promise<ModelEntry[]> {
  let names: string[];
  try {
    const entries = await readdir(MODELS_DIR, { withFileTypes: true });
    names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    // Folder belum ada → bukan error; kiosk yang belum punya model besar
    // memang begitu sampai operator menaruh berkasnya.
    return [];
  }

  const models: ModelEntry[] = [];
  for (const name of names) {
    if (!ALLOWED_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    const path = resolveModelPath(name);
    if (path === null) continue;
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      models.push({ name, size: info.size, url: `${MODELS_PREFIX}${name}` });
    } catch {
      // Berkas hilang antara readdir & stat — lewati saja.
    }
  }

  return models.sort((a, b) => a.name.localeCompare(b.name));
}

export async function modelRoutes(app: FastifyInstance): Promise<void> {
  /** Daftar model — dipakai studio untuk tahu apa yang perlu di-cache. */
  app.get("/models", async () => ({ models: await listModels() }));

  /**
   * Berkas model. `*` menangkap sisa path (termasuk subfolder) sehingga
   * validasi bisa memberi pesan yang tepat, bukan 404 buta.
   */
  app.get<{ Params: { "*": string } }>("/models/*", async (request, reply) => {
    const name = request.params["*"] ?? "";

    const path = resolveModelPath(name);
    if (path === null) {
      return reply.status(400).send({
        error: "bad_request",
        message: "Nama berkas model tidak valid.",
        statusCode: 400,
      });
    }

    let info;
    try {
      info = await stat(path);
    } catch {
      return reply.status(404).send({
        error: "not_found",
        message: `Model tidak ditemukan: ${name}`,
        statusCode: 404,
      });
    }

    if (!info.isFile()) {
      return reply.status(404).send({
        error: "not_found",
        message: `Bukan berkas: ${name}`,
        statusCode: 404,
      });
    }

    // Model tidak pernah berubah setelah diunggah → boleh di-cache lama.
    // `immutable` membuat browser (dan Cache Storage) tidak repot revalidasi.
    reply.header("content-type", contentTypeFor(name));
    reply.header("content-length", String(info.size));
    reply.header("cache-control", "public, max-age=31536000, immutable");
    return reply.send(createReadStream(path));
  });
}
