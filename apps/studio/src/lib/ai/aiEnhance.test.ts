/**
 * Tes adapter efek AI (Fase 8).
 *
 * Janji yang diuji di sini adalah janji yang melindungi foto tamu:
 *
 *   · **Gagal di mana pun → `{ ok: false }`, tidak pernah lempar.** Jalur ini
 *     dipanggil di tengah alur simpan; satu lemparan yang lolos berarti foto
 *     hilang dari antrian.
 *   · **Gambar kebesaran ditolak sebelum jaringan** — operator dapat pesan
 *     \"terlalu besar\", bukan 413 setelah mengunggah 12 MB.
 *   · **Prompt yang ditampilkan = prompt yang dikirim.** Keduanya lewat
 *     `buildAiPrompt` shared; kalau drift, operator melihat satu instruksi dan
 *     Gemini menerima instruksi lain.
 *   · **Hasil server yang tidak bisa dibaca bukan sukses.** Lebih baik gagal
 *     jelas daripada menyimpan blob kosong ke galeri tamu.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AI_MAX_INPUT_BYTES, buildAiPrompt } from "@foto-booth/shared";

import { applyAiEffect, browserAiImageDeps, isAiRequestReady, previewAiPrompt } from "./aiEnhance.ts";
import type { AiClient, AiGenerateResult } from "./aiClient.ts";

const REQUEST = { task: "style" as const, style: "anime" as const };

/** Deps palsu: encode/decode dalam memori, tanpa kanvas. */
function fakeDeps(overrides: Partial<Parameters<typeof applyAiEffect>[2]> = {}) {
  const deps = {
    encode: async (blob: Blob) => ({ dataUrl: `data:image/jpeg;base64,${await blob.text()}`, width: 800, height: 1200 }),
    decode: async (dataUrl: string) => ({
      blob: new Blob([dataUrl.split(",")[1] ?? ""], { type: "image/jpeg" }),
      width: 800,
      height: 1200,
    }),
    ...overrides,
  };
  return deps;
}

/** Klien palsu yang mengembalikan hasil tetap. */
function fakeClient(result: AiGenerateResult): { client: AiClient; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      async generate(input) {
        calls.push(input);
        return result;
      },
    },
  };
}

function photo(payload = "AAAA"): Blob {
  return new Blob([payload], { type: "image/jpeg" });
}

/* ---- Jalur bahagia ------------------------------------------------- */

test("efek berhasil → blob + prompt dari server", async () => {
  const { client, calls } = fakeClient({ ok: true, image: "HASIL", mimeType: "image/png", prompt: "prompt server" });
  const result = await applyAiEffect(photo(), REQUEST, fakeDeps(), client);

  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.prompt : null, "prompt server");
  assert.equal(result.ok === true ? result.width : 0, 800);
  assert.equal(await (result.ok === true ? result.blob : new Blob()).text(), "HASIL");

  const sent = calls[0] as { mimeType: string; image: string; custom?: string };
  assert.equal(sent.mimeType, "image/jpeg");
  assert.equal(sent.image, "AAAA");
  assert.ok(!("custom" in sent), "instruksi kosong tidak dikirim");
});

test("instruksi tambahan diteruskan apa adanya", async () => {
  const { client, calls } = fakeClient({ ok: true, image: "H", mimeType: "image/png", prompt: "p" });
  await applyAiEffect(photo(), { ...REQUEST, custom: "langit senja" }, fakeDeps(), client);
  assert.equal((calls[0] as { custom?: string }).custom, "langit senja");
});

test("prompt pratinjau = prompt yang dibangun shared", () => {
  assert.equal(previewAiPrompt(REQUEST), buildAiPrompt("style", "anime", ""));
  assert.equal(
    previewAiPrompt({ task: "enhance", style: "oil", custom: "tajamkan mata" }),
    buildAiPrompt("enhance", "oil", "tajamkan mata"),
  );
});

/* ---- Kegagalan ------------------------------------------------------ */

test("gagal encode → ok:false encode, klien tidak dipanggil", async () => {
  const { client, calls } = fakeClient({ ok: true, image: "H", mimeType: "image/png", prompt: "p" });
  const result = await applyAiEffect(
    photo(),
    REQUEST,
    fakeDeps({ encode: async () => null }),
    client,
  );
  assert.equal(result.ok === false ? result.reason : null, "encode");
  assert.equal(calls.length, 0);
});

test("encode yang melempar tidak lolos ke pemanggil", async () => {
  const { client } = fakeClient({ ok: true, image: "H", mimeType: "image/png", prompt: "p" });
  const result = await applyAiEffect(
    photo(),
    REQUEST,
    fakeDeps({
      encode: async () => {
        throw new Error("kanvas mati");
      },
    }),
    client,
  );
  assert.equal(result.ok === false ? result.reason : null, "encode");
});

test("gambar melebihi batas → too_large, tanpa memanggil klien", async () => {
  const { client, calls } = fakeClient({ ok: true, image: "H", mimeType: "image/png", prompt: "p" });
  const oversized = "A".repeat(Math.ceil((AI_MAX_INPUT_BYTES * 4) / 3) + 16);
  const result = await applyAiEffect(
    photo(),
    REQUEST,
    fakeDeps({ encode: async () => ({ dataUrl: `data:image/jpeg;base64,${oversized}`, width: 1, height: 1 }) }),
    client,
  );
  assert.equal(result.ok === false ? result.reason : null, "too_large");
  assert.equal(calls.length, 0);
});

test("kegagalan server diteruskan dengan reason-nya", async () => {
  for (const reason of ["rejected", "rate_limited", "network", "blocked", "no_image"] as const) {
    const { client } = fakeClient({ ok: false, reason, message: "pesan", status: 400, retryable: false });
    const result = await applyAiEffect(photo(), REQUEST, fakeDeps(), client);
    assert.equal(result.ok, false, reason);
    assert.equal(result.ok === false ? result.reason : null, reason);
    assert.equal(result.ok === false ? result.message : null, "pesan");
  }
});

test("hasil server yang tidak bisa dibaca → decode, bukan sukses", async () => {
  const { client } = fakeClient({ ok: true, image: "H", mimeType: "image/png", prompt: "p" });
  const result = await applyAiEffect(photo(), REQUEST, fakeDeps({ decode: async () => null }), client);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : null, "decode");
});

test("decode yang melempar tidak lolos ke pemanggil", async () => {
  const { client } = fakeClient({ ok: true, image: "H", mimeType: "image/png", prompt: "p" });
  const result = await applyAiEffect(
    photo(),
    REQUEST,
    fakeDeps({
      decode: async () => {
        throw new Error("gambar rusak");
      },
    }),
    client,
  );
  assert.equal(result.ok === false ? result.reason : null, "decode");
});

/* ---- Kesiapan ------------------------------------------------------- */

test("permintaan siap hanya kalau kunci ada dan instruksi masuk akal", () => {
  // Tanpa kunci, apa pun tidak siap.
  assert.equal(isAiRequestReady(REQUEST, false), false);
  assert.equal(isAiRequestReady(REQUEST, true), true);
  // Gaya `custom` tanpa teks tidak siap.
  assert.equal(isAiRequestReady({ task: "style", style: "custom" }, true), false);
  assert.equal(isAiRequestReady({ task: "style", style: "custom", custom: "  " }, true), false);
  assert.equal(isAiRequestReady({ task: "style", style: "custom", custom: "pastel" }, true), true);
  // Tugas lain tetap siap.
  assert.equal(isAiRequestReady({ task: "backdrop", style: "custom" }, true), true);
});

/* ---- Deps browser --------------------------------------------------- */

test("deps browser ada dan berbentuk yang diharapkan", () => {
  // Tidak bisa benar-benar meng-encode di Node (tidak ada `document`), tapi
  // bentuknya harus lengkap — salah ketik di sini akan jadi error runtime.
  const deps = browserAiImageDeps({} as unknown as Document);
  assert.equal(typeof deps.encode, "function");
  assert.equal(typeof deps.decode, "function");
});
