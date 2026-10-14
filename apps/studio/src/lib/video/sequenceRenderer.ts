/**
 * Adapter DOM: susun animasi (slideshow / boomerang) jadi satu berkas bergerak.
 *
 * Urutan frame & waktunya **bukan** keputusan file ini — itu di `animation.ts`
 * (murni, teruji). Di sini hanya eksekusi: gambar frame ke kanvas, rekam kanvas
 * lewat `MediaRecorder`, kembalikan `Blob`.
 *
 * Semua ketergantungan DOM disuntik (`createCanvas`, `createRecorder`,
 * penjadwal waktu), jadi urutan penggambaran bisa diuji tanpa browser: tes
 * memberi kanvas palsu yang mencatat `drawImage`, lalu memeriksa urutannya.
 *
 * **Janji terpenting:** gagal di tengah jalan tidak melempar ke UI. Yang
 * dikembalikan adalah `Blob` (mungkin kosong) — pemanggil memeriksa `size`.
 */

import type { FilterCanvas } from "../filters/applyFilters.ts";
import type { RecorderLike } from "./recorder.ts";
import { buildAnimation, type SequenceStep } from "./animation.ts";
import type { VideoAnimationKind } from "./types.ts";

/** Kanvas yang bisa dipakai `captureStream` (khusus animasi). */
export interface StreamableCanvas extends FilterCanvas {
  captureStream?(fps: number): MediaStream;
}

export interface SequenceDeps {
  createCanvas(width: number, height: number): StreamableCanvas;
  createRecorder(stream: MediaStream, options: { mimeType?: string; videoBitsPerSecond?: number }): RecorderLike;
  /** Jadwal tunda; disuntik supaya tes bebas timer nyata. */
  wait(ms: number): Promise<void>;
}

export interface SequenceOptions {
  kind: VideoAnimationKind;
  frames: readonly unknown[];
  width: number;
  height: number;
  fps: number;
  bitrateBps: number;
  frameMs: number;
  mimeType: string | null;
  /** Warna latar kanvas; frame yang tidak memenuhi kanvas di-`contain`. */
  background?: string;
}

export interface SequenceResult {
  blob: Blob;
  /** Jumlah frame yang benar-benar digambar. */
  drawn: number;
  /** Timeline yang dipakai — berguna untuk panel debug & tes. */
  steps: SequenceStep[];
}

/** Hitung posisi & ukuran gambar agar muat di kanvas tanpa distorsi (`contain`). */
export function containRect(
  imageWidth: number,
  imageHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number; width: number; height: number } {
  const iw = Math.max(1, imageWidth);
  const ih = Math.max(1, imageHeight);
  const scale = Math.min(canvasWidth / iw, canvasHeight / ih);
  const width = Math.round(iw * scale);
  const height = Math.round(ih * scale);
  return {
    x: Math.round((canvasWidth - width) / 2),
    y: Math.round((canvasHeight - height) / 2),
    width,
    height,
  };
}

/**
 * Gambar satu frame ke kanvas, dengan latar penuh lebih dulu.
 *
 * Latar digambar setiap frame (bukan sekali) karena `clearRect` + gambar ulang
 * lebih murah daripada mempertahankan state, dan `MediaRecorder` merekam apa
 * yang ada di kanvas pada tiap detik — kalau latar tidak digambar ulang,
 * frame dengan gambar transparan akan menghasilkan jejak frame sebelumnya.
 *
 * Ukuran gambar dibaca dari frame itu sendiri (`width`/`height`, dimiliki
 * `ImageBitmap`/`HTMLImageElement`/kanvas); kalau frame tidak mengakukannya,
 * `fallbackSize` dipakai. Tanpa ini foto lanskap akan direntangkan ke kanvas
 * persegi — distorsi yang paling kelihatan di hasil tamu.
 */
export function drawFrame(
  canvas: StreamableCanvas,
  frame: unknown,
  background: string,
  size: { width: number; height: number },
  fallbackSize: { width: number; height: number } = { width: size.width, height: size.height },
): boolean {
  let ctx;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return false;
  }
  if (ctx === null) return false;

  const imageSize = frameSize(frame) ?? fallbackSize;
  const rect = containRect(imageSize.width, imageSize.height, size.width, size.height);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
  return true;
}

/** Ukuran intrinsik sebuah frame, kalau objeknya mengakukannya. */
function frameSize(frame: unknown): { width: number; height: number } | null {
  const candidate = frame as { width?: unknown; height?: unknown } | null;
  if (candidate === null) return null;
  const width = typeof candidate.width === "number" ? candidate.width : 0;
  const height = typeof candidate.height === "number" ? candidate.height : 0;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Render animasi menjadi satu `Blob`.
 *
 * Setiap langkah timeline digambar lalu ditahan `durationSec` — kalau kanvas
 * mendukung `captureStream`, perekam menangkap gerakannya; kalau tidak, hasilnya
 * tetap `Blob` (mungkin hanya berisi frame terakhir). Kegagalan `captureStream`
 * bukan alasan menggagalkan alur: tamu tetap dapat berkas.
 */
export async function renderAnimation(deps: SequenceDeps, options: SequenceOptions): Promise<SequenceResult> {
  const steps = buildAnimation(options.kind, options.frames.length, options.frameMs);
  const background = options.background ?? "#000000";
  const size = { width: options.width, height: options.height };
  const canvas = deps.createCanvas(size.width, size.height);

  let recorder: RecorderLike | null = null;
  const chunks: Blob[] = [];
  let stream: MediaStream | null = null;

  try {
    if (typeof canvas.captureStream === "function") {
      stream = canvas.captureStream(options.fps);
      const recorderOptions: { mimeType?: string; videoBitsPerSecond?: number } = {
        videoBitsPerSecond: options.bitrateBps,
      };
      if (options.mimeType !== null) recorderOptions.mimeType = options.mimeType;
      recorder = deps.createRecorder(stream, recorderOptions);
      recorder.ondataavailable = (event) => {
        if (event.data !== undefined && event.data.size > 0) chunks.push(event.data);
      };
      recorder.start();
    }
  } catch {
    recorder = null;
  }

  let drawn = 0;
  for (const step of steps) {
    const frame = options.frames[step.sourceIndex];
    // Foto yang gagal didekode (`null`) atau hilang dilewati: lebih baik
    // animasi pendek daripada render yang jatuh di tengah sesi tamu.
    if (frame === undefined || frame === null) continue;
    if (drawFrame(canvas, frame, background, size)) drawn += 1;
    await deps.wait(Math.max(1, Math.round(step.durationSec * 1000)));
  }

  const blob = await stopRecorder(recorder, chunks, options.mimeType);
  return { blob, drawn, steps };
}

/** Hentikan perekam dan tunggu `onstop`; `chunks` dipakai kalau tidak ada. */
function stopRecorder(
  recorder: RecorderLike | null,
  chunks: Blob[],
  mimeType: string | null,
): Promise<Blob> {
  const type = mimeType ?? "video/webm";
  if (recorder === null) return Promise.resolve(new Blob(chunks, { type }));

  return new Promise<Blob>((resolve) => {
    const finish = (): void => resolve(new Blob(chunks, { type }));
    try {
      recorder.onstop = finish;
      recorder.onerror = finish;
      recorder.stop();
    } catch {
      finish();
    }
  });
}

/**
 * Dependensi browser untuk `renderAnimation`.
 *
 * Kanvas dibuat dari `document`, perekamnya `MediaRecorder` atas
 * `canvas.captureStream(fps)`. Kalau `captureStream` tidak ada, animasinya tetap
 * dirender (berkas berisi frame terakhir) — tamu tidak pernah pulang kosong.
 */
export function browserSequenceDeps(doc: Document = document): SequenceDeps {
  return {
    createCanvas: (width, height) => {
      const canvas = doc.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas as unknown as StreamableCanvas;
    },
    createRecorder: (stream, options) => new MediaRecorder(stream, options) as unknown as RecorderLike,
    wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
}
