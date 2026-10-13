import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Rute `/models/*` — dua janji yang diuji di sini:
 *
 *   1. berkas model disajikan apa adanya dengan tipe & panjang yang benar;
 *   2. **path traversal ditolak** (`/models/../../etc/passwd` bukan bocor).
 *
 * `MODELS_DIR` dibaca `paths.ts` saat impor, jadi env diset **sebelum** modul
 * dimuat — karena itu impornya dinamis. `node --test` menjalankan tiap berkas
 * di proses terpisah, jadi tidak ada tes lain yang keburu memuat `paths.ts`.
 */

const root = await mkdtemp(join(tmpdir(), "fb-models-"));
process.env.MODELS_DIR = root;

await mkdir(join(root, "sub"), { recursive: true });
await writeFile(join(root, "gfpgan.onnx"), Buffer.alloc(2048, 7));
await writeFile(join(root, "selfie-segmenter.task"), Buffer.from("model-bytes"));
await writeFile(join(root, "notes.md"), Buffer.from("bukan model"));

const { isSafeModelName, resolveModelPath, contentTypeFor, listModels, MODELS_PREFIX } = await import(
  "./models.ts"
);
const { makeHarness } = await import("../testing.ts");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("isSafeModelName menerima nama wajar & menolak traversal", () => {
  assert.equal(isSafeModelName("gfpgan.onnx"), true);
  assert.equal(isSafeModelName("sub/model.bin"), true);

  for (const bad of [
    "",
    "../etc/passwd",
    "..%2f..%2fetc",
    "/etc/passwd",
    "sub/../../etc/passwd",
    "a\\b",
    "nul\0byte",
    ".hidden",
    "spasi nama.onnx",
  ]) {
    assert.equal(isSafeModelName(bad), false, `harus ditolak: ${JSON.stringify(bad)}`);
  }
});

test("resolveModelPath menjaga hasil tetap di dalam MODELS_DIR", () => {
  const ok = resolveModelPath("gfpgan.onnx");
  assert.ok(ok !== null && ok.startsWith(root), "berkas aman harus di dalam root");

  assert.equal(resolveModelPath("../etc/passwd"), null);
  assert.equal(resolveModelPath("/etc/passwd"), null);
  assert.equal(resolveModelPath("sub/../../secret"), null);
});

test("contentTypeFor memetakan ekstensi model", () => {
  assert.equal(contentTypeFor("m.onnx"), "application/octet-stream");
  assert.equal(contentTypeFor("m.wasm"), "application/wasm");
  assert.equal(contentTypeFor("m.json"), "application/json; charset=utf-8");
  assert.equal(contentTypeFor("m.apa-saja"), "application/octet-stream");
});

test("listModels hanya menampilkan ekstensi yang dikenal, dengan ukuran & url", async () => {
  const models = await listModels();
  const names = models.map((m) => m.name);
  assert.deepEqual(names, ["gfpgan.onnx", "selfie-segmenter.task"], "notes.md harus disaring");

  const onnx = models.find((m) => m.name === "gfpgan.onnx");
  assert.ok(onnx);
  assert.equal(onnx.size, 2048);
  assert.equal(onnx.url, `${MODELS_PREFIX}gfpgan.onnx`);
});

test("GET /models mengembalikan daftar model", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "GET", url: "/models" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { models: { name: string }[] };
    assert.deepEqual(
      body.models.map((m) => m.name),
      ["gfpgan.onnx", "selfie-segmenter.task"],
    );
  } finally {
    await h.close();
  }
});

test("GET /models/<file> menyajikan berkas apa adanya", async () => {
  const h = await makeHarness();
  try {
    const res = await h.app.inject({ method: "GET", url: "/models/selfie-segmenter.task" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/octet-stream");
    assert.equal(res.headers["content-length"], "11");
    assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(res.body, "model-bytes");
  } finally {
    await h.close();
  }
});

test("path traversal ditolak (400), bukan dilayani", async () => {
  const h = await makeHarness();
  try {
    for (const url of [
      "/models/../../etc/passwd",
      "/models/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/models/..%2f..%2fetc%2fpasswd",
    ]) {
      const res = await h.app.inject({ method: "GET", url });
      assert.ok(
        res.statusCode === 400 || res.statusCode === 404,
        `${url} → ${res.statusCode}, harus 400/404`,
      );
      assert.ok(!res.body.includes("root:"), `${url} membocorkan /etc/passwd`);
    }
  } finally {
    await h.close();
  }
});

test("berkas tidak ada & direktori → 404", async () => {
  const h = await makeHarness();
  try {
    const missing = await h.app.inject({ method: "GET", url: "/models/hilang.onnx" });
    assert.equal(missing.statusCode, 404);

    const dir = await h.app.inject({ method: "GET", url: "/models/sub" });
    assert.equal(dir.statusCode, 404);
  } finally {
    await h.close();
  }
});
