/**
 * Rencana rekaman — satu fungsi murni yang menjawab "apa yang harus dilakukan".
 *
 * Ini titik pertemuan semua keputusan Fase 7: resolusi, fps, bitrate, format,
 * audio, slow-mo, dan animasi. Adapter DOM (`recorder.ts`,
 * `sequenceRenderer.ts`) **tidak** memutuskan apa pun — mereka menjalankan
 * rencana ini. Dengan begitu aturannya bisa diuji di Node, dan UI cukup
 * menampilkan ringkasannya.
 *
 * Dua mode:
 *
 *   · `record`  — rekam langsung dari kamera (dengan/tanpa slow-mo).
 *   · `animate` — susun berkas bergerak dari foto yang sudah dijepret.
 */

import { audioBitrateBps, estimateBitrateBps, estimateBytes } from "./bitrate.ts";
import { contentTypeForMimeType, extensionForMimeType, pickMimeType, preferencesFor } from "./codec.ts";
import { captureFpsFor, videoResolutionById, type VideoSettings } from "./types.ts";

export type VideoMode = "record" | "animate";

export interface VideoPlan {
  mode: VideoMode;
  width: number;
  height: number;
  /** fps berkas keluaran. */
  fps: number;
  /** fps yang diminta dari kamera — lebih tinggi saat slow-mo. */
  captureFps: number;
  bitrateBps: number;
  audioBitrateBps: number;
  audio: boolean;
  slowMo: VideoSettings["slowMo"];
  animation: VideoSettings["animation"];
  maxDurationSec: number;
  /** Mime type rekaman terpilih, atau `null` = tidak ada format yang didukung. */
  mimeType: string | null;
  extension: "mp4" | "webm";
  contentType: string;
  /** Durasi keluaran yang diharapkan, detik (sudah memperhitungkan slow-mo). */
  expectedDurationSec: number;
  /** Perkiraan ukuran berkas, byte. */
  expectedBytes: number;
  /** Apakah hasilnya butuh frame sintetis (slow-mo non-1). */
  needsInterpolation: boolean;
}

export interface PlanOptions {
  /** Durasi rekaman yang akan datang, detik. Default: batas maksimum setelan. */
  sourceDurationSec?: number;
  /** `MediaRecorder.isTypeSupported`; disuntik supaya bisa diuji di Node. */
  isSupported: (mimeType: string) => boolean;
  /**
   * Apakah ada frame foto untuk animasi. `0` = tidak ada; mode tetap `animate`
   * tapi UI harus menolaknya lebih dulu (`animationIsMeaningful`).
   */
  frameCount?: number;
}

/**
 * Susun rencana dari setelan.
 *
 * Slow-mo mengubah **dua** hal: fps yang diminta dari kamera (dinaikkan supaya
 * ada bahan) dan durasi keluaran (memanjang). Bitrate dihitung dari resolusi &
 * fps keluaran, bukan fps kamera — berkasnya toh diputar pada fps keluaran.
 */
export function resolveVideoPlan(settings: VideoSettings, options: PlanOptions): VideoPlan {
  const resolution = videoResolutionById(settings.resolution);
  const mimeType = pickMimeType(preferencesFor(settings.audio), options.isSupported);
  const bitrateBps = estimateBitrateBps(resolution.width, resolution.height, settings.fps, settings.quality);
  const audioBps = audioBitrateBps(settings.audio);

  const mode: VideoMode = settings.animation === "none" ? "record" : "animate";
  const sourceDuration = Math.max(
    0,
    options.sourceDurationSec ?? settings.maxDurationSec,
  );
  const expectedDurationSec = settings.slowMo >= 1 ? sourceDuration : sourceDuration / settings.slowMo;

  return {
    mode,
    width: resolution.width,
    height: resolution.height,
    fps: settings.fps,
    captureFps: captureFpsFor(settings.fps, settings.slowMo),
    bitrateBps,
    audioBitrateBps: audioBps,
    audio: settings.audio,
    slowMo: settings.slowMo,
    animation: settings.animation,
    maxDurationSec: settings.maxDurationSec,
    mimeType,
    extension: extensionForMimeType(mimeType),
    contentType: contentTypeForMimeType(mimeType),
    expectedDurationSec,
    expectedBytes: estimateBytes(bitrateBps + audioBps, expectedDurationSec),
    needsInterpolation: settings.slowMo < 1 && mode === "record",
  };
}

/** Ringkasan satu baris untuk UI/debug — angka, bukan prosa. */
export function describePlan(plan: VideoPlan): string {
  const parts = [
    `${plan.width}×${plan.height}`,
    `${plan.fps} fps`,
    `${Math.round(plan.bitrateBps / 1000)} kbps`,
    plan.audio ? "audio" : "tanpa audio",
    `${plan.extension.toUpperCase()}`,
  ];
  if (plan.slowMo < 1) parts.push(`slow-mo ${plan.slowMo}× (rekam ${plan.captureFps} fps)`);
  if (plan.mode === "animate") parts.push(`animasi ${plan.animation}`);
  return parts.join(" · ");
}

/** Apakah rencana ini bisa dijalankan (ada format rekaman yang didukung). */
export function planIsRunnable(plan: VideoPlan): boolean {
  return plan.mimeType !== null;
}
