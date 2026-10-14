/**
 * Klien proxy AI (Fase 8) — satu panggilan, satu hasil.
 *
 * Yang perlu dipegang saat membaca file ini:
 *
 *   · **Kunci lewat header, bukan body.** `x-gemini-key` dipasang di sini dan
 *     tidak pernah masuk ke objek yang dikirim sebagai JSON. Kalau suatu saat
 *     seseorang "menyederhanakan" dengan menaruh kunci di body, ia ikut ke log
 *     server — jadi bentuk header adalah keputusan, bukan detail.
 *   · **Kegagalan jadi kode, bukan teks Inggris dari Google.** UI perlu
 *     menerjemahkan dan memutuskan apa yang dilakukan (coba lagi? buka
 *     pengaturan? lewati saja?). Karena itu error membawa `reason` yang stabil.
 *   · **Selalu resolve dengan hasil bertanda.** Tidak ada yang melempar ke luar:
 *     pemanggil di jalur foto (kiosk) tidak boleh kehilangan foto hanya karena
 *     AI gagal, jadi kegagalan dikembalikan sebagai `{ ok: false, reason }`.
 *   · **Tidak ada kunci di pesan error.** Pesan error datang dari server dan
 *     sudah bersih; kunci tidak pernah dirangkai ke dalamnya di sini.
 */

import {
  AI_GEMINI_PATH,
  AI_KEY_HEADER,
  AI_TIMEOUT_MS,
  AiProxyResponseSchema,
  isAiImageMime,
  type AiImageMimeType,
  type AiStyleId,
  type AiTaskId,
} from "@foto-booth/shared";

/** Alasan kegagalan yang stabil — dipetakan UI ke locale. */
export type AiFailureReason =
  | "no_key"
  | "invalid"
  | "too_large"
  | "rate_limited"
  | "rejected"
  | "timeout"
  | "network"
  | "no_image"
  | "blocked"
  | "upstream"
  | "output_too_large"
  | "unauthorized"
  | "unknown";

export interface AiGenerateInput {
  task: AiTaskId;
  style: AiStyleId;
  custom?: string;
  mimeType: AiImageMimeType;
  /** Base64 tanpa awalan data-URL. */
  image: string;
}

export interface AiGenerateSuccess {
  ok: true;
  image: string;
  mimeType: AiImageMimeType;
  /** Prompt yang benar-benar dipakai server — ditampilkan supaya operator tahu. */
  prompt: string;
}

export interface AiGenerateFailure {
  ok: false;
  reason: AiFailureReason;
  /** Pesan dari server (sudah bersih, tanpa kunci). Cadangan kalau locale tak ada. */
  message: string;
  status: number;
  /** Ada gunanya mencoba lagi? (rate limit / jaringan / waktu habis) */
  retryable: boolean;
}

export type AiGenerateResult = AiGenerateSuccess | AiGenerateFailure;

export interface AiClientOptions {
  /** Token sesi operator. Tanpa ini server menjawab 401. */
  token: string;
  /** Kunci Gemini operator. Tidak pernah dirangkai ke pesan error. */
  key: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Batas waktu lokal; lebih longgar dari server supaya 504 server yang menang. */
  timeoutMs?: number;
}

export interface AiClient {
  generate(input: AiGenerateInput): Promise<AiGenerateResult>;
}

const REASONS: readonly AiFailureReason[] = [
  "no_key",
  "invalid",
  "too_large",
  "rate_limited",
  "rejected",
  "timeout",
  "network",
  "no_image",
  "blocked",
  "upstream",
  "output_too_large",
  "unauthorized",
  "unknown",
];

/** Alasan yang layak dicoba ulang tanpa mengubah apa pun. */
const RETRYABLE: ReadonlySet<AiFailureReason> = new Set<AiFailureReason>([
  "rate_limited",
  "timeout",
  "network",
  "upstream",
]);

/** Kode alasan dari body server, kalau bentuknya masuk akal. */
export function reasonFromBody(body: unknown): AiFailureReason {
  if (typeof body !== "object" || body === null) return "unknown";
  const reason = (body as { reason?: unknown }).reason;
  if (typeof reason === "string" && (REASONS as readonly string[]).includes(reason)) {
    return reason as AiFailureReason;
  }
  // Server versi lama mungkin hanya mengirim `error`.
  const error = (body as { error?: unknown }).error;
  if (error === "unauthorized") return "unauthorized";
  if (error === "image_too_large") return "too_large";
  return "unknown";
}

/** Pesan dari body server, kalau ada; kalau tidak, dari status. */
export function messageFromBody(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return `HTTP ${status}`;
}

export function createAiClient(options: AiClientOptions): AiClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS + 5_000;

  return {
    async generate(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await doFetch(`${baseUrl}${AI_GEMINI_PATH}`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${options.token}`,
            [AI_KEY_HEADER]: options.key,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            task: input.task,
            style: input.style,
            ...(input.custom === undefined ? {} : { custom: input.custom }),
            mimeType: input.mimeType,
            image: input.image,
          }),
        });
      } catch (error) {
        clearTimeout(timer);
        const aborted = error instanceof Error && error.name === "AbortError";
        const reason: AiFailureReason = aborted ? "timeout" : "network";
        return {
          ok: false,
          reason,
          message: aborted ? "permintaan AI melewati batas waktu" : "tidak bisa menghubungi server",
          status: 0,
          retryable: true,
        };
      } finally {
        clearTimeout(timer);
      }

      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (!res.ok) {
        const reason = reasonFromBody(body);
        return {
          ok: false,
          reason,
          message: messageFromBody(body, res.status),
          status: res.status,
          retryable: RETRYABLE.has(reason),
        };
      }

      const parsed = AiProxyResponseSchema.safeParse(body);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "no_image",
          message: "jawaban server tidak memuat gambar",
          status: res.status,
          retryable: false,
        };
      }

      // Validasi ulang MIME: server sudah menjamin enum, tapi ini murah dan
      // membuat klien tidak pernah menyerahkan MIME tak dikenal ke `<img src>`.
      const mimeType: AiImageMimeType = isAiImageMime(parsed.data.mimeType) ? parsed.data.mimeType : "image/png";
      return { ok: true, image: parsed.data.image, mimeType, prompt: parsed.data.prompt };
    },
  };
}
