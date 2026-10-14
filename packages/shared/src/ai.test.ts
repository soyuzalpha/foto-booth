/**
 * Tes logika murni AI (Fase 8).
 *
 * Yang diuji bukan panggilan ke Gemini (itu urusan proxy & tes route), tapi
 * **keputusan** yang dipakai dua sisi sekaligus:
 *
 *   · prompt dibangun dari pilihan, jadi proxy bisa mereproduksi teks yang
 *     sama persis dari `task`/`style`/`custom` — kalau ini berbeda, operator
 *     melihat satu instruksi dan Gemini menerima instruksi lain;
 *   · kunci yang salah tempel ditolak sebelum menembak jaringan;
 *   · ukuran base64 dihitung tanpa mendekode (kalau salah, gambar kebesaran
 *     lolos ke memori, atau gambar sah justru ditolak);
 *   · jawaban Gemini tanpa gambar menghasilkan `null`, bukan lempar — foto asli
 *     harus tetap selamat.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_IMAGE_MIME_TYPES,
  AI_KEY_MIN_LENGTH,
  AI_MAX_PROMPT_CHARS,
  AI_STYLE_IDS,
  AI_TASK_IDS,
  AiProxyRequestSchema,
  aiUpstreamUrl,
  base64Bytes,
  buildAiPrompt,
  geminiBlockReason,
  isActionable,
  isAiImageMime,
  isAiStyleId,
  isAiTaskId,
  keyFingerprint,
  normalizeAiKey,
  normalizeCustomPrompt,
  parseGeminiImage,
} from "./ai.ts";

/* ---- Prompt -------------------------------------------------------- */

test("prompt menyebut gaya untuk setiap id non-custom", () => {
  for (const style of AI_STYLE_IDS) {
    if (style === "custom") continue;
    const prompt = buildAiPrompt("style", style);
    assert.ok(prompt.includes("Restyle this photo"), `${style}: tugas tidak disebut`);
    assert.ok(prompt.length > 60, `${style}: prompt terlalu pendek untuk berguna`);
  }
});

test("prompt selalu menjaga identitas subjek", () => {
  // Ini janji produk: gaya berubah, orangnya tidak. Kalau baris ini hilang,
  // tamu dapat foto orang lain.
  for (const task of AI_TASK_IDS) {
    for (const style of AI_STYLE_IDS) {
      const prompt = buildAiPrompt(task, style, "coba");
      assert.ok(prompt.includes("same face"), `${task}/${style}: penjaga identitas hilang`);
      assert.ok(prompt.includes("Do not add or remove anyone"), `${task}/${style}: larangan hilang`);
    }
  }
});

test("prompt gaya berbeda antar id", () => {
  const seen = new Set<string>();
  for (const style of AI_STYLE_IDS) {
    if (style === "custom") continue;
    const prompt = buildAiPrompt("style", style);
    assert.ok(!seen.has(prompt), `prompt gaya ${style} sama dengan gaya lain`);
    seen.add(prompt);
  }
});

test("custom tanpa teks jatuh ke 'gaya yang dijelaskan', bukan gaya kosong", () => {
  const prompt = buildAiPrompt("style", "custom");
  assert.ok(prompt.includes("described below"));
  assert.equal(isActionable("style", "custom", ""), false);
  assert.equal(isActionable("style", "custom", "  pastel  "), true);
  // Tugas lain tetap bisa jalan tanpa teks tambahan.
  assert.equal(isActionable("backdrop", "custom", ""), true);
  assert.equal(isActionable("enhance", "custom", ""), true);
});

test("instruksi operator dipangkas, disatukan, dan dibatasi", () => {
  assert.equal(normalizeCustomPrompt("  langit   senja \n hangat "), "langit senja hangat");
  assert.equal(normalizeCustomPrompt(undefined), "");
  assert.equal(normalizeCustomPrompt("x".repeat(999)).length, AI_MAX_PROMPT_CHARS);

  const prompt = buildAiPrompt("style", "anime", "dengan topi jerami");
  assert.ok(prompt.includes("dengan topi jerami"));
});

test("prompt tanpa instruksi tambahan tidak meninggalkan kalimat menggantung", () => {
  const prompt = buildAiPrompt("enhance", "anime");
  assert.ok(!prompt.includes("Extra direction"));
  assert.ok(!prompt.endsWith(" "));
});

/* ---- Kunci --------------------------------------------------------- */

test("kunci terlalu pendek / berisi spasi ditolak", () => {
  assert.equal(normalizeAiKey(""), null);
  assert.equal(normalizeAiKey(undefined), null);
  assert.equal(normalizeAiKey(42), null);
  assert.equal(normalizeAiKey("AIzaSy"), null);
  assert.equal(normalizeAiKey("AIzaSyD contoh dengan spasi panjang"), null);
  assert.equal(normalizeAiKey("AIzaSyD\ncontohpanjangsekali"), null);
  assert.equal(normalizeAiKey("x".repeat(AI_KEY_MIN_LENGTH - 1)), null);
});

test("kunci yang wajar diterima apa adanya (tanpa spasi pinggir)", () => {
  const key = "AIzaSyD-abcdefghijklmnopqrstuvwxyz_0123";
  assert.equal(normalizeAiKey(`  ${key}  `), key);
  assert.equal(normalizeAiKey("x".repeat(AI_KEY_MIN_LENGTH)), "x".repeat(AI_KEY_MIN_LENGTH));
});

test("sidik jari stabil, berbeda antar kunci, dan tidak memuat kunci", () => {
  const key = "AIzaSyD-abcdefghijklmnopqrstuvwxyz_0123";
  const other = "AIzaSyD-abcdefghijklmnopqrstuvwxyz_0124";
  assert.equal(keyFingerprint(key), keyFingerprint(key));
  assert.notEqual(keyFingerprint(key), keyFingerprint(other));
  assert.ok(!keyFingerprint(key).includes(key));
  assert.match(keyFingerprint(key), /^k[0-9a-f]{8}$/);
});

/* ---- Ukuran -------------------------------------------------------- */

test("ukuran base64 dihitung tanpa mendekode", () => {
  assert.equal(base64Bytes(""), 0);
  // 3 byte → 4 karakter tanpa padding.
  assert.equal(base64Bytes("AAAA"), 3);
  // 1 byte → 2 karakter + "==".
  assert.equal(base64Bytes("AA=="), 1);
  // 2 byte → 3 karakter + "=".
  assert.equal(base64Bytes("AAA="), 2);
  // Spasi/baris baru dari formatter tidak menambah ukuran.
  assert.equal(base64Bytes("AA\nAA"), 3);
});

test("skema permintaan menerima bentuk yang sah dan menolak sisanya", () => {
  const ok = AiProxyRequestSchema.safeParse({
    task: "style",
    style: "anime",
    mimeType: "image/jpeg",
    image: "AAAA",
  });
  assert.equal(ok.success, true);

  const bad: unknown[] = [
    { task: "upscale", style: "anime", mimeType: "image/jpeg", image: "AAAA" },
    { task: "style", style: "vaporwave", mimeType: "image/jpeg", image: "AAAA" },
    { task: "style", style: "anime", mimeType: "video/mp4", image: "AAAA" },
    { task: "style", style: "anime", mimeType: "image/jpeg", image: "" },
    { task: "style", style: "anime", mimeType: "image/jpeg", image: "AAAA", custom: "x".repeat(AI_MAX_PROMPT_CHARS + 1) },
  ];
  for (const payload of bad) {
    assert.equal(AiProxyRequestSchema.safeParse(payload).success, false, JSON.stringify(payload));
  }
});

test("MIME yang didukung adalah gambar saja", () => {
  assert.deepEqual([...AI_IMAGE_MIME_TYPES], ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(isAiImageMime("image/jpeg"), true);
  assert.equal(isAiImageMime("image/gif"), false);
  assert.equal(isAiImageMime("video/mp4"), false);
});

test("id gaya & tugas yang tidak dikenal ditolak", () => {
  assert.equal(isAiStyleId("anime"), true);
  assert.equal(isAiStyleId("ANIME"), false);
  assert.equal(isAiTaskId("backdrop"), true);
  assert.equal(isAiTaskId(""), false);
});

test("URL upstream dikunci ke satu host (tidak bisa diarahkan klien)", () => {
  assert.equal(
    aiUpstreamUrl(),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
  );
});

/* ---- Jawaban Gemini ------------------------------------------------ */

test("gambar pertama diambil dari jawaban Gemini", () => {
  const parsed = parseGeminiImage({
    candidates: [
      { content: { parts: [{ text: "ini bukan gambar" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] } },
    ],
  });
  assert.deepEqual(parsed, { image: "AAAA", mimeType: "image/png" });
});

test("jawaban tanpa gambar → null, bukan lempar", () => {
  const empties: unknown[] = [
    null,
    "bukan objek",
    {},
    { candidates: [] },
    { candidates: [{ content: { parts: [{ text: "maaf" }] } }] },
    { candidates: [{ content: {} }] },
  ];
  for (const payload of empties) {
    assert.equal(parseGeminiImage(payload), null, JSON.stringify(payload));
  }
});

test("MIME tak dikenal dari model disimpan sebagai PNG", () => {
  const parsed = parseGeminiImage({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/avif", data: "AAAA" } }] } }],
  });
  assert.deepEqual(parsed, { image: "AAAA", mimeType: "image/png" });
});

test("alasan blokir dibaca supaya operator tahu kenapa kosong", () => {
  assert.equal(geminiBlockReason({ promptFeedback: { blockReason: "SAFETY" } }), "SAFETY");
  assert.equal(geminiBlockReason({ candidates: [{ finishReason: "IMAGE_SAFETY" }] }), "IMAGE_SAFETY");
  // `STOP` itu normal — bukan blokir.
  assert.equal(geminiBlockReason({ candidates: [{ finishReason: "STOP" }] }), null);
  assert.equal(geminiBlockReason({}), null);
});
