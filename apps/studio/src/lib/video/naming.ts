/**
 * Penamaan berkas video — murni.
 *
 * Sama alasannya dengan `captureFilename` di `composedToIntake.ts`: nomor
 * di-`padStart` supaya berkas terurut benar di file manager (`10` setelah `9`,
 * bukan setelah `1`). Bedanya, video memakai awalan `video-` supaya tidak
 * bertabrakan dengan foto dalam folder arsip yang sama.
 */

import type { VideoMode } from "./plan.ts";

export function videoFilename(index: number, extension: "mp4" | "webm"): string {
  return `video-${String(index + 1).padStart(2, "0")}.${extension}`;
}

/** Nama untuk animasi (slideshow/boomerang) — dibedakan dari rekaman kamera. */
export function animationFilename(kind: string, extension: "mp4" | "webm"): string {
  return `animasi-${kind}.${extension}`;
}

export function filenameForMode(
  mode: VideoMode,
  index: number,
  extension: "mp4" | "webm",
  animationKind = "slideshow",
): string {
  return mode === "animate" ? animationFilename(animationKind, extension) : videoFilename(index, extension);
}
