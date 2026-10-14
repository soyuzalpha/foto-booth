/**
 * AI (Fase 8) — logika murni bersama studio & API.
 *
 * Fase 8 sengaja **BYOK**: yang punya kunci Gemini adalah operator, bukan kita.
 * Konsekuensinya ada di sini: yang perlu dijanjikan bersama bukan "cara
 * memanggil Gemini", melainkan **bentuk permintaan, batasnya, dan promptnya** —
 * supaya studio dan proxy tidak pernah berbeda pendapat soal apa yang sah.
 *
 * Tiga hal yang gampang salah dan karena itu diputuskan sekali di sini:
 *
 *   1. **Prompt itu keputusan bersama.** Studio menampilkan promptnya ke
 *      operator (biar tahu apa yang akan terjadi), proxy membangun ulang prompt
 *      dari `task`/`style`/`custom` yang dikirim — jadi teks yang benar-benar
 *      dipakai Gemini tidak bisa dipalsukan klien, dan tidak ada dua versi teks
 *      yang bisa drift. Karena itu yang dikirim ke server adalah **pilihan**,
 *      bukan kalimat jadi.
 *   2. **Batas ukuran dalam byte, bukan karakter.** Base64 membengkak ~4/3, dan
 *      `Buffer`/`TextEncoder` tidak selalu ada di kedua sisi — jadi ukuran
 *      dihitung dari panjang base64 tanpa mendekode apa pun (`base64Bytes`).
 *   3. **Kunci tidak pernah jadi bagian dari data.** Yang tersimpan di
 *      pengaturan hanyalah kunci itu sendiri; ia tidak pernah ikut di body
 *      permintaan (header khusus), tidak pernah masuk log, dan tidak pernah
 *      dikembalikan. `keyFingerprint` ada supaya pembatas laju punya kunci
 *      bucket tanpa menyimpan kunci aslinya.
 *
 * Semua di modul ini murni: tanpa DOM, tanpa jaringan, tanpa `process`.
 */

import { z } from "zod";

/** Semua rute AI di-prefix ini (proxy BYOK). */
export const AI_PREFIX = "/v1/ai";

/** Endpoint proxy satu-satunya. Tidak ada parameter URL dari klien. */
export const AI_GEMINI_PATH = `${AI_PREFIX}/gemini`;

/** Header tempat kunci operator dikirim. **Bukan** body, bukan query. */
export const AI_KEY_HEADER = "x-gemini-key";

/**
 * Model gambar Gemini.
 *
 * Dipilih yang bisa **menyunting gambar yang dikirim** (bukan cuma membuat dari
 * teks): seluruh Fase 8 bekerja pada foto tamu, bukan pada prompt kosong.
 */
export const AI_MODEL = "gemini-2.5-flash-image";

/** Endpoint upstream. Dikunci di sini supaya proxy tidak bisa diarahkan (SSRF). */
export const AI_UPSTREAM_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function aiUpstreamUrl(model: string = AI_MODEL): string {
  return `${AI_UPSTREAM_BASE}/${model}:generateContent`;
}

/* ------------------------------------------------------------------ *
 * Gaya & tugas
 * ------------------------------------------------------------------ */

/**
 * Id gaya. Sama persis dengan `FEATURE-MATRIX.md` §B baris #25
 * (anime/3D/comic/watercolor/oil/custom) — label yang dibaca operator datang
 * dari locale UI, bukan dari sini.
 */
export const AI_STYLE_IDS = ["anime", "3d", "comic", "watercolor", "oil", "custom"] as const;
export type AiStyleId = (typeof AI_STYLE_IDS)[number];

export function isAiStyleId(value: string): value is AiStyleId {
  return (AI_STYLE_IDS as readonly string[]).includes(value);
}

/**
 * Tugas AI yang didukung.
 *
 * `style` & `enhance` & `backdrop` & `remix` semuanya memakai jalur yang sama
 * (kirim gambar + instruksi, terima gambar) — yang berbeda hanya instruksinya.
 * Itu sebabnya tidak ada empat endpoint: satu proxy, empat prompt.
 */
export const AI_TASK_IDS = ["style", "enhance", "backdrop", "remix"] as const;
export type AiTaskId = (typeof AI_TASK_IDS)[number];

export function isAiTaskId(value: string): value is AiTaskId {
  return (AI_TASK_IDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Batas
 * ------------------------------------------------------------------ */

/**
 * Batas gambar masuk (byte biner, sebelum base64).
 *
 * 8 MB: foto studio keluar dari kanvas pada kualitas JPEG tinggi (~1–3 MB),
 * jadi batas ini tidak pernah menghalangi alur normal — ia menghalangi klien
 * yang salah kirim (mis. video) atau sengaja mengirim bom.
 */
export const AI_MAX_INPUT_BYTES = 8 * 1024 * 1024;

/** Batas gambar keluar (byte biner). Model mengembalikan PNG/JPEG ~1–4 MB. */
export const AI_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

/** Batas instruksi tambahan dari operator. */
export const AI_MAX_PROMPT_CHARS = 600;

/**
 * Batas waktu satu panggilan ke Gemini (ms).
 *
 * Kiosk tidak boleh menggantung: kalau model tidak menjawab dalam 45 detik,
 * foto asli dipakai. Lebih baik kehilangan efek daripada kehilangan tamu.
 */
export const AI_TIMEOUT_MS = 45_000;

/**
 * Panjang minimum kunci Gemini yang masuk akal.
 *
 * Kunci Gemini asli ~39 karakter berawalan `AIza`. Ambang 20 karakter ada
 * untuk menangkap salah tempel (terpotong, atau yang tertempel justru nama
 * proyek) — bukan untuk memvalidasi format yang bisa berubah.
 */
export const AI_KEY_MIN_LENGTH = 20;

/** MIME yang boleh masuk ke pipeline. Video tidak pernah ke AI. */
export const AI_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AiImageMimeType = (typeof AI_IMAGE_MIME_TYPES)[number];

export function isAiImageMime(value: string): value is AiImageMimeType {
  return (AI_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/** Berapa permintaan AI boleh lewat per kunci per menit (proxy). */
export const AI_RATE_LIMIT = 12;
export const AI_RATE_WINDOW_MS = 60_000;

/* ------------------------------------------------------------------ *
 * Base64 tanpa Buffer
 * ------------------------------------------------------------------ */

/**
 * Ukuran biner dari panjang base64, tanpa mendekode.
 *
 * Dipakai untuk menolak gambar kebesaran **sebelum** mengalokasikan buffernya.
 * `=` di ujung mengurangi 1–2 byte; rumus ini tepat untuk base64 standar
 * maupun base64url.
 */
export function base64Bytes(encoded: string): number {
  const clean = encoded.replace(/[\s=]/g, "");
  return Math.floor((clean.length * 3) / 4);
}

/**
 * Rapikan kunci dari input operator.
 *
 * `null` kalau kosong atau tidak masuk akal. Sengaja tidak memeriksa prefix
 * `AIza`: format kunci bisa berubah, dan menolak kunci yang sah lebih mahal
 * daripada satu panggilan yang ditolak Gemini dengan pesan jelas.
 */
export function normalizeAiKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < AI_KEY_MIN_LENGTH) return null;
  if (trimmed.length > 200) return null;
  // Karakter yang lazim di kunci API; tolak baris baru/spasi (salah tempel).
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Sidik jari kunci — untuk bucket pembatas laju & log.
 *
 * Bukan hash kripto untuk keamanan (kunci tidak pernah disimpan di server);
 * tujuannya supaya pembatas laju bisa membedakan pemanggil **tanpa** menaruh
 * kunci asli di memori/log. FNV-1a 32-bit cukup dan tidak butuh `node:crypto`,
 * jadi modul ini tetap bisa diimpor studio (browser).
 */
export function keyFingerprint(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `k${hash.toString(16).padStart(8, "0")}`;
}

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

/** Instruksi gaya per id. Ditulis sebagai frasa, bukan kalimat perintah. */
const STYLE_PROMPTS: Record<Exclude<AiStyleId, "custom">, string> = {
  anime:
    "2D anime illustration, cel-shaded with clean ink outlines, vivid saturated colors, " +
    "expressive eyes, soft gradient background",
  "3d":
    "stylized 3D character render, Pixar-like soft global illumination, subsurface skin " +
    "scattering, shallow depth of field, pastel studio background",
  comic:
    "American comic book art, bold black ink linework, halftone dot shading, " +
    "high-contrast primary colors",
  watercolor:
    "loose watercolor painting, wet-on-wet washes, visible paper grain, soft bleeding " +
    "edges, muted palette",
  oil:
    "classical oil painting, thick impasto brush strokes, warm chiaroscuro lighting, " +
    "canvas texture",
};

/** Bagian yang menjaga subjek tetap jadi subjek — dipakai semua tugas. */
const PRESERVE =
  "Keep the same person: same face, same expression, same pose, same framing, same " +
  "number of people. Do not add or remove anyone, do not change clothing colors.";

/**
 * Prompt lengkap untuk satu permintaan.
 *
 * Dibangun dari pilihan (`task`, `style`, `custom`) — bukan dari kalimat yang
 * dikirim klien. Proxy memanggil fungsi yang sama, jadi teks yang sampai ke
 * Gemini selalu bisa direproduksi dari data yang tersimpan.
 */
export function buildAiPrompt(task: AiTaskId, style: AiStyleId, custom = ""): string {
  const extra = normalizeCustomPrompt(custom);
  const tail = extra === "" ? "" : ` Extra direction from the operator: ${extra}.`;

  switch (task) {
    case "style": {
      const descriptor =
        style === "custom"
          ? "the artistic style described below"
          : STYLE_PROMPTS[style];
      return `Restyle this photo as ${descriptor}. ${PRESERVE}${tail}`;
    }
    case "enhance":
      return (
        "Enhance this photo: recover detail in highlights and shadows, reduce noise, " +
        `sharpen eyes and skin texture naturally, keep colors true to the original. ${PRESERVE}${tail}`
      );
    case "backdrop":
      return (
        "Replace the background behind the people with a new setting that fits the scene " +
        `(studio seamless, event hall, or the setting described below), with lighting that ` +
        `matches the subject. Keep the people cut out cleanly, including hair edges. ${PRESERVE}${tail}`
      );
    case "remix":
      return (
        `Create a playful remix of this photo: same people and pose, but composited as ` +
        `${
          style === "custom" ? "the artistic style described below" : STYLE_PROMPTS[style]
        }, with confetti and light streaks. ${PRESERVE}${tail}`
      );
  }
}

/** Instruksi tambahan: satu baris, dipangkas, dibatasi. */
export function normalizeCustomPrompt(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, AI_MAX_PROMPT_CHARS);
}

/** Apakah permintaan ini masuk akal dikirim (ada instruksi yang bisa dipakai). */
export function isActionable(task: AiTaskId, style: AiStyleId, custom = ""): boolean {
  if (task !== "style" && task !== "remix") return true;
  return style !== "custom" || normalizeCustomPrompt(custom) !== "";
}

/* ------------------------------------------------------------------ *
 * Skema
 * ------------------------------------------------------------------ */

/**
 * Body permintaan proxy.
 *
 * `image` adalah base64 **tanpa** awalan data-URL — awalan itu membuat dua
 * bentuk yang sah untuk hal yang sama, dan bentuk kedua selalu lupa ditangani.
 */
export const AiProxyRequestSchema = z.object({
  task: z.enum(AI_TASK_IDS),
  style: z.enum(AI_STYLE_IDS),
  custom: z.string().max(AI_MAX_PROMPT_CHARS).optional(),
  mimeType: z.enum(AI_IMAGE_MIME_TYPES),
  image: z.string().min(1),
});
export type AiProxyRequest = z.infer<typeof AiProxyRequestSchema>;

export const AiProxyResponseSchema = z.object({
  image: z.string().min(1),
  mimeType: z.enum(AI_IMAGE_MIME_TYPES),
  /** Prompt yang benar-benar dipakai — ditampilkan di panel debug. */
  prompt: z.string(),
});
export type AiProxyResponse = z.infer<typeof AiProxyResponseSchema>;

/* ------------------------------------------------------------------ *
 * Jawaban Gemini
 * ------------------------------------------------------------------ */

/**
 * Ambil gambar pertama dari jawaban Gemini.
 *
 * `null` = tidak ada gambar (jawaban hanya teks, diblokir filter, atau bentuknya
 * berubah). Pemanggil memperlakukan ini sebagai kegagalan yang **tidak**
 * menghilangkan foto asli — jadi tidak perlu melempar.
 */
export function parseGeminiImage(
  payload: unknown,
): { image: string; mimeType: AiImageMimeType } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return null;

  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const content = (candidate as { content?: unknown }).content;
    if (typeof content !== "object" || content === null) continue;
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (typeof part !== "object" || part === null) continue;
      const inline = (part as { inlineData?: unknown }).inlineData;
      if (typeof inline !== "object" || inline === null) continue;
      const data = (inline as { data?: unknown }).data;
      const mime = (inline as { mimeType?: unknown }).mimeType;
      if (typeof data !== "string" || data === "") continue;
      // MIME tak dikenal dari model → simpan sebagai PNG, bukan menolak gambar
      // yang sudah dibayar operator.
      return { image: data, mimeType: isAiImageMime(String(mime)) ? (mime as AiImageMimeType) : "image/png" };
    }
  }

  return null;
}

/** Pesan blokir (kalau ada) — supaya operator tahu *kenapa* tidak ada gambar. */
export function geminiBlockReason(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const feedback = (payload as { promptFeedback?: { blockReason?: unknown } }).promptFeedback;
  if (typeof feedback === "object" && feedback !== null) {
    const reason = (feedback as { blockReason?: unknown }).blockReason;
    if (typeof reason === "string" && reason !== "") return reason;
  }
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const reason = (candidate as { finishReason?: unknown }).finishReason;
      if (typeof reason === "string" && reason !== "STOP" && reason !== "MAX_TOKENS") return reason;
    }
  }
  return null;
}
