/**
 * Adapter DOM: jalankan satu efek AI pada byte foto (`Blob → Blob`).
 *
 * Seperti `applyFilters`, file ini **tidak memutuskan apa pun** soal tugas &
 * gaya — itu ada di `packages/shared/src/ai.ts`. Yang ada di sini hanya
 * penyandian: foto → data-URL → klien → data-URL → foto.
 *
 * **Janji terpenting, sama seperti filter:** kalau AI gagal — kunci belum
 * diisi, kuota habis, jaringan mati, model diblokir — yang dikembalikan `null`,
 * dan pemanggil memakai foto asli. Foto tamu tidak boleh hilang karena layanan
 * pihak ketiga.
 *
 * `encode`/`decode` disuntik lewat `AiImageDeps` supaya keputusan di modul ini
 * bisa diuji tanpa kanvas, dan supaya Worker bisa memakai `OffscreenCanvas`
 * tanpa mengubah satu baris pun di sini.
 */

import {
  AI_MAX_INPUT_BYTES,
  buildAiPrompt,
  type AiStyleId,
  type AiTaskId,
} from "@foto-booth/shared";

import { decodeDataUrl, toDataUrl } from "./aiImage.ts";
import type { AiClient, AiFailureReason } from "./aiClient.ts";

/** Hasil penyandian gambar dari byte foto. */
export interface AiEncodedImage {
  /** Data-URL `image/jpeg;base64,…`. */
  dataUrl: string;
  width: number;
  height: number;
}

/** Hasil penyandian gambar kembali ke byte. */
export interface AiDecodedImage {
  blob: Blob;
  width: number;
  height: number;
}

/** Dependensi gambar; disuntik supaya bisa diuji tanpa DOM. */
export interface AiImageDeps {
  /** Foto → data-URL JPEG. `null` = gagal encode. */
  encode(blob: Blob): Promise<AiEncodedImage | null>;
  /** Data-URL → foto. `null` = gagal decode. */
  decode(dataUrl: string): Promise<AiDecodedImage | null>;
}

export interface AiEffectRequest {
  task: AiTaskId;
  style: AiStyleId;
  custom?: string;
}

export interface AiEffectSuccess {
  ok: true;
  blob: Blob;
  width: number;
  height: number;
  /** Prompt yang benar-benar dipakai server — ditampilkan supaya operator tahu. */
  prompt: string;
}

export interface AiEffectFailure {
  ok: false;
  reason: AiFailureReason | "encode" | "decode";
  message: string;
}

export type AiEffectResult = AiEffectSuccess | AiEffectFailure;

/**
 * Jalankan satu efek AI pada foto.
 *
 * Tidak pernah melempar. Urutan pemeriksaan sengaja dari yang paling murah:
 * encode (batas ukuran sudah ikut di `decodeDataUrl`) → panggil server → decode
 * hasil. Kalau hasil server tidak bisa didekode (jarang, tapi mungkin kalau
 * bentuk jawabannya berubah), kegagalan dilaporkan sebagai `decode` — bukan
 * sebagai sukses dengan blob kosong.
 */
export async function applyAiEffect(
  blob: Blob,
  request: AiEffectRequest,
  deps: AiImageDeps,
  client: AiClient,
): Promise<AiEffectResult> {
  let encoded: AiEncodedImage | null;
  try {
    encoded = await deps.encode(blob);
  } catch {
    encoded = null;
  }
  if (encoded === null) {
    return { ok: false, reason: "encode", message: "foto tidak bisa disandikan untuk AI" };
  }

  const decoded = decodeDataUrl(encoded.dataUrl);
  if (decoded === null) {
    // Batas ukuran ditegakkan `decodeDataUrl`; MIME di sini selalu JPEG karena
    // kita sendiri yang meng-encode, jadi yang tersisa hanyalah ukuran.
    return {
      ok: false,
      reason: "too_large",
      message: `foto melebihi ${Math.floor(AI_MAX_INPUT_BYTES / 1024 / 1024)} MB untuk AI`,
    };
  }

  const result = await client.generate({
    task: request.task,
    style: request.style,
    ...(request.custom === undefined || request.custom === "" ? {} : { custom: request.custom }),
    mimeType: decoded.mimeType,
    image: decoded.base64,
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason, message: result.message };
  }

  let out: AiDecodedImage | null;
  try {
    out = await deps.decode(toDataUrl(result.mimeType, result.image));
  } catch {
    out = null;
  }
  if (out === null) {
    return { ok: false, reason: "decode", message: "hasil AI tidak bisa dibaca" };
  }

  return { ok: true, blob: out.blob, width: out.width, height: out.height, prompt: result.prompt };
}

/**
 * Prompt yang **akan** dipakai untuk permintaan ini.
 *
 * Dipakai UI untuk menampilkan ke operator sebelum menekan tombol — teks yang
 * dilihat operator harus sama dengan yang dikirim server, jadi keduanya memakai
 * fungsi shared yang sama.
 */
export function previewAiPrompt(request: AiEffectRequest): string {
  return buildAiPrompt(request.task, request.style, request.custom ?? "");
}

/** Apakah permintaan ini masuk akal dijalankan (ada instruksi yang bisa dipakai). */
export function isAiRequestReady(request: AiEffectRequest, keyPresent: boolean): boolean {
  if (!keyPresent) return false;
  if (request.task !== "style" && request.task !== "remix") return true;
  return request.style !== "custom" || (request.custom ?? "").trim() !== "";
}

/** Dependensi browser: kanvas `document` + `Image.decode()`. */
export function browserAiImageDeps(doc: Document = document): AiImageDeps {
  async function drawToCanvas(dataUrl: string): Promise<{
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
  } | null> {
    const image = new Image();
    image.src = dataUrl;
    // `decode()` menunggu gambar benar-benar siap; `onload` saja membuat
    // `naturalWidth` kadang masih 0 saat diambil.
    await image.decode();
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return null;

    const canvas = doc.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    ctx.drawImage(image, 0, 0);
    return { canvas, width: canvas.width, height: canvas.height };
  }

  return {
    async encode(blob) {
      try {
        const bitmap = await createImageBitmap(blob);
        try {
          const canvas = doc.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext("2d");
          if (ctx === null) return null;
          // JPEG kualitas 0.92: cukup untuk model, jauh di bawah batas 8 MB.
          ctx.drawImage(bitmap, 0, 0);
          return {
            dataUrl: canvas.toDataURL("image/jpeg", 0.92),
            width: bitmap.width,
            height: bitmap.height,
          };
        } finally {
          bitmap.close();
        }
      } catch {
        return null;
      }
    },

    async decode(dataUrl) {
      try {
        const drawn = await drawToCanvas(dataUrl);
        if (drawn === null) return null;
        const blob = await new Promise<Blob | null>((resolve) => {
          drawn.canvas.toBlob((out) => resolve(out), "image/jpeg", 0.95);
        });
        if (blob === null) return null;
        return { blob, width: drawn.width, height: drawn.height };
      } catch {
        return null;
      }
    },
  };
}
