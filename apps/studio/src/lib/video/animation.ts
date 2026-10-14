/**
 * Animasi dari foto: slideshow & boomerang — murni.
 *
 * Booth sering menghasilkan beberapa foto per sesi, dan tamu suka kalau
 * foto-foto itu jadi satu berkas bergerak. Dua bentuk paling berguna:
 *
 *   · **slideshow** — tiap foto tampil bergantian, berurutan.
 *   · **boomerang** — maju lalu mundur (ping-pong), mengulang; gerakannya
 *     terasa "hidup" tanpa perlu merekam video sungguhan.
 *
 * Berkas ini hanya menyusun **urutan** (foto mana, mulai kapan, berapa lama).
 * Menggambar ke kanvas & merekamnya adalah kerja `sequenceRenderer.ts`.
 */

import type { VideoAnimationKind } from "./types.ts";

export interface SequenceStep {
  /** Indeks foto sumber. */
  sourceIndex: number;
  /** Mulai pada detik ke-berapa di video keluaran. */
  startSec: number;
  durationSec: number;
}

/** Urutan indeks untuk slideshow: 0,1,2,…,n-1. */
export function slideshowOrder(frameCount: number): number[] {
  const n = Math.max(0, Math.round(frameCount));
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Urutan indeks untuk boomerang: 0,1,…,n-1,n-2,…,1.
 *
 * Ujung-ujungnya tidak diulang: kalau frame terakhir dan frame pertama
 * diletakkan berdampingan dua kali, hasilnya terasa "tersendat" di titik balik.
 * Untuk satu foto, urutannya cuma `[0]` — tidak ada yang bisa diping-pong.
 */
export function boomerangOrder(frameCount: number): number[] {
  const n = Math.max(0, Math.round(frameCount));
  if (n <= 1) return Array.from({ length: n }, (_, i) => i);
  const forward = Array.from({ length: n }, (_, i) => i);
  const back = Array.from({ length: n - 2 }, (_, i) => n - 2 - i);
  return [...forward, ...back];
}

/** Urutan indeks untuk jenis animasi tertentu. */
export function orderFor(kind: VideoAnimationKind, frameCount: number): number[] {
  if (kind === "boomerang") return boomerangOrder(frameCount);
  if (kind === "slideshow") return slideshowOrder(frameCount);
  return [];
}

/** Susun timeline dari urutan indeks + lama tiap foto. */
export function buildSequence(order: readonly number[], frameMs: number): SequenceStep[] {
  const duration = Math.max(1, Math.round(frameMs)) / 1000;
  return order.map((sourceIndex, i) => ({
    sourceIndex,
    startSec: i * duration,
    durationSec: duration,
  }));
}

/** Total durasi sebuah urutan, detik. */
export function sequenceDuration(steps: readonly SequenceStep[]): number {
  let end = 0;
  for (const step of steps) end = Math.max(end, step.startSec + step.durationSec);
  return end;
}

/** Berapa kali animasi diulang agar mendekati `targetSec`. Minimal sekali. */
export function repeatCount(steps: readonly SequenceStep[], targetSec: number): number {
  const once = sequenceDuration(steps);
  if (once <= 0) return 0;
  return Math.max(1, Math.round(Math.max(0, targetSec) / once));
}

/** Susun timeline animasi lengkap untuk `kind` & jumlah foto. */
export function buildAnimation(
  kind: VideoAnimationKind,
  frameCount: number,
  frameMs: number,
): SequenceStep[] {
  return buildSequence(orderFor(kind, frameCount), frameMs);
}

/**
 * Apakah jenis animasi ini punya arti untuk jumlah foto tertentu.
 *
 * Satu foto tidak bisa jadi slideshow yang bergerak maupun boomerang; UI
 * memakai ini untuk menonaktifkan pilihan, bukan membiarkan operator memilih
 * sesuatu yang hasilnya cuma foto diam.
 */
export function animationIsMeaningful(kind: VideoAnimationKind, frameCount: number): boolean {
  if (kind === "none") return false;
  if (kind === "boomerang") return frameCount >= 2;
  return frameCount >= 2;
}
