/**
 * Proxy AI BYOK (Fase 8) — `POST /v1/ai/gemini`.
 *
 * Kenapa diproxy, bukan dipanggil langsung dari studio:
 *
 *   1. **Kunci tidak pernah ke browser pihak ketiga.** Kunci milik operator
 *      tetap di perangkatnya, tapi yang bicara ke Google adalah server rumah —
 *      jadi tidak ada permintaan lintas-origin dari halaman studio, dan tidak
 *      ada kunci yang ikut ke URL (URL bocor lewat log & Referer).
 *   2. **Batas ada di satu tempat.** Ukuran gambar, panjang prompt, waktu
 *      tunggu, dan laju per kunci ditegakkan di sini. Kalau ditegakkan di klien,
 *      ia cuma saran.
 *   3. **Audit jujur.** Yang dicatat: tugas, gaya, ukuran, durasi, hasil. Yang
 *      **tidak pernah** dicatat: kunci.
 *
 * Yang dijaga eksplisit:
 *
 *   · Kunci datang dari header `x-gemini-key` — bukan body, bukan query.
 *   · Kunci tidak pernah masuk ke body permintaan ke Gemini maupun ke balasan,
 *     dan pembatas laju memakai `keyFingerprint` supaya kunci asli tidak duduk
 *     di memori proses sebagai bucket key.
 *   · URL upstream **dikunci** (`aiUpstreamUrl()`) — tidak ada bagian URL yang
 *     berasal dari klien, jadi rute ini tidak bisa dipakai sebagai SSRF relay.
 *   · Prompt dibangun ulang dari `task`/`style`/`custom` memakai fungsi shared
 *     yang sama dengan studio, jadi klien tidak bisa menyuntikkan prompt bebas
 *     (dan operator melihat teks yang sama dengan yang dikirim).
 *   · Kegagalan apa pun → foto asli dipakai studio. Route ini tidak pernah
 *     membuat operator kehilangan foto.
 */

import type { FastifyInstance } from "fastify";

import {
  AI_GEMINI_PATH,
  AI_KEY_HEADER,
  AI_MAX_INPUT_BYTES,
  AI_MAX_OUTPUT_BYTES,
  AI_RATE_LIMIT,
  AI_RATE_WINDOW_MS,
  AI_TIMEOUT_MS,
  AiProxyRequestSchema,
  aiUpstreamUrl,
  base64Bytes,
  buildAiPrompt,
  geminiBlockReason,
  keyFingerprint,
  normalizeAiKey,
  parseGeminiImage,
} from "@foto-booth/shared";

import { authenticate } from "../auth.ts";
import type { ServerContext } from "../context.ts";
import { createRateLimiter } from "../rateLimit.ts";

/** Batas body Fastify: base64 membengkak ~4/3, jadi beri ruang. */
const BODY_LIMIT = Math.ceil((AI_MAX_INPUT_BYTES * 4) / 3) + 4096;

type Failure = {
  status: number;
  error: string;
  message: string;
  /** Kode singkat untuk UI studio; bukan teks upstream apa adanya. */
  reason: string;
};

function fail(status: number, error: string, reason: string, message: string): Failure {
  return { status, error, reason, message };
}

/**
 * Panggil Gemini sekali.
 *
 * `fetch` datang dari konteks (bisa disuntik di tes), `AbortController` dipakai
 * supaya kiosk tidak menggantung kalau Google lambat. Body permintaan **tidak**
 * memuat kunci: kunci dikirim lewat header `x-goog-api-key` ke upstream, yang
 * tidak pernah masuk ke log kita (kita yang menulis lognya, dan yang kita tulis
 * hanya fingerprint).
 */
async function callGemini(
  ctx: ServerContext,
  key: string,
  prompt: string,
  image: string,
  mimeType: string,
): Promise<{ ok: true; image: string; mimeType: string } | { ok: false; failure: Failure }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  let response: Response;
  try {
    response = await ctx.fetch(aiUpstreamUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Kunci ke upstream: header, bukan query string.
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }, { inlineData: { mimeType, data: image } }],
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      failure: aborted
        ? fail(504, "upstream_timeout", "timeout", `Gemini tidak menjawab dalam ${AI_TIMEOUT_MS / 1000} detik`)
        : fail(502, "upstream_unreachable", "network", "tidak bisa menghubungi Gemini"),
    };
  }
  clearTimeout(timer);

  if (!response.ok) {
    // Pesan upstream tidak diteruskan apa adanya: ia bisa memuat detail kuota
    // akun operator, dan tidak ada yang bisa dilakukan studio dengan teks itu.
    const status = response.status;
    if (status === 400 || status === 401 || status === 403) {
      return { ok: false, failure: fail(401, "upstream_key_rejected", "rejected", "kunci Gemini ditolak atau tidak berhak") };
    }
    if (status === 429) {
      return { ok: false, failure: fail(429, "upstream_rate_limited", "rate_limited", "kuota Gemini sedang penuh — coba lagi sebentar") };
    }
    if (status === 413) {
      return { ok: false, failure: fail(413, "image_too_large", "too_large", "gambar terlalu besar untuk Gemini") };
    }
    return { ok: false, failure: fail(502, "upstream_error", "upstream", `Gemini membalas ${status}`) };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, failure: fail(502, "upstream_error", "upstream", "jawaban Gemini bukan JSON") };
  }

  const image_ = parseGeminiImage(payload);
  if (image_ === null) {
    const blocked = geminiBlockReason(payload);
    return {
      ok: false,
      failure: blocked === null
        ? fail(502, "no_image", "no_image", "Gemini tidak mengembalikan gambar")
        : fail(422, "blocked", "blocked", `permintaan diblokir Gemini (${blocked})`),
    };
  }

  if (base64Bytes(image_.image) > AI_MAX_OUTPUT_BYTES) {
    return { ok: false, failure: fail(502, "output_too_large", "output_too_large", "gambar hasil terlalu besar") };
  }

  return { ok: true, image: image_.image, mimeType: image_.mimeType };
}

export async function aiRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const limiter = createRateLimiter(
    { limit: AI_RATE_LIMIT, windowMs: AI_RATE_WINDOW_MS },
    ctx.now,
  );

  app.post(AI_GEMINI_PATH, { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    // Token operator dulu: tanpa ini server rumah jadi relay gratis untuk siapa
    // pun yang tahu alamatnya (kunci operator tidak boleh jadi tiket masuk).
    const auth = authenticate(request, ctx);
    if (!auth.ok) {
      return reply.status(auth.status).send({ error: "unauthorized", message: auth.message, statusCode: auth.status });
    }

    const key = normalizeAiKey(request.headers[AI_KEY_HEADER]);
    if (key === null) {
      return reply.status(401).send({
        error: "missing_key",
        reason: "no_key",
        message: `kunci Gemini belum diisi (header ${AI_KEY_HEADER})`,
        statusCode: 401,
      });
    }

    const parsed = AiProxyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        reason: "invalid",
        message: "body tidak sesuai bentuk yang diharapkan",
        statusCode: 400,
      });
    }

    const inputBytes = base64Bytes(parsed.data.image);
    if (inputBytes > AI_MAX_INPUT_BYTES) {
      return reply.status(413).send({
        error: "image_too_large",
        reason: "too_large",
        message: `gambar melebihi ${Math.floor(AI_MAX_INPUT_BYTES / 1024 / 1024)} MB`,
        statusCode: 413,
      });
    }

    // Pembatas laju per kunci — memakai fingerprint, bukan kunci asli.
    const verdict = limiter.check(keyFingerprint(key));
    if (!verdict.allowed) {
      return reply
        .status(429)
        .header("retry-after", String(verdict.retryAfterSeconds))
        .send({
          error: "rate_limited",
          reason: "rate_limited",
          message: `terlalu banyak permintaan AI — coba lagi dalam ${verdict.retryAfterSeconds} detik`,
          statusCode: 429,
        });
    }

    // Prompt dibangun ulang dari pilihan; klien tidak mengirim kalimat jadi.
    const prompt = buildAiPrompt(parsed.data.task, parsed.data.style, parsed.data.custom ?? "");
    const started = ctx.now().getTime();

    const result = await callGemini(ctx, key, prompt, parsed.data.image, parsed.data.mimeType);
    const durationMs = ctx.now().getTime() - started;

    // Audit: tanpa kunci, tanpa isi gambar. `key` di sini hanya fingerprint.
    app.log.info(
      {
        event: "ai.proxy",
        operator: auth.operator.email,
        task: parsed.data.task,
        style: parsed.data.style,
        inputBytes,
        durationMs,
        key: keyFingerprint(key),
        ok: result.ok,
      },
      result.ok ? "ai selesai" : "ai gagal",
    );

    if (!result.ok) {
      return reply.status(result.failure.status).send({
        error: result.failure.error,
        reason: result.failure.reason,
        message: result.failure.message,
        statusCode: result.failure.status,
      });
    }

    return reply.send({ image: result.image, mimeType: result.mimeType, prompt });
  });
}
