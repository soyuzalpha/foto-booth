/**
 * Perkiraan bitrate video — murni.
 *
 * MediaRecorder bisa menerima `videoBitsPerSecond`, tapi angka mentah tidak
 * berarti apa-apa bagi operator. Yang mereka pilih adalah "hemat / standar /
 * maks", jadi di sini-lah terjemahannya: dari (lebar, tinggi, fps, kualitas)
 * ke bit/detik.
 *
 * Rumusnya **bukan** standar industri yang presisi — memang tidak perlu.
 * Yang penting: monoton (resolusi/fps/kualitas naik → bitrate naik), ada batas
 * atas yang jelas, dan angkanya bisa dijelaskan ke operator ("720p 30 fps
 * standar ≈ 4 Mbps → 15 detik ≈ 7,5 MB").
 */

import type { VideoQualityId } from "./types.ts";

/** Bit per piksel per frame. Angka hasil kalibrasi kasar, bukan janji kualitas. */
const BITS_PER_PIXEL: Record<VideoQualityId, number> = {
  hemat: 0.06,
  standar: 0.1,
  maks: 0.18,
};

/** Batas bawah & atas supaya hasil ekstrem tidak bikin berkas mustahil. */
export const MIN_BITRATE_BPS = 400_000;
export const MAX_BITRATE_BPS = 40_000_000;

/**
 * Bitrate video yang diusulkan, bit/detik.
 *
 * Sengaja dibulatkan ke ribuan terdekat supaya angkanya enak dibaca di UI dan
 * stabil antar pemanggilan.
 */
export function estimateBitrateBps(
  width: number,
  height: number,
  fps: number,
  quality: VideoQualityId,
): number {
  const pixels = Math.max(1, Math.round(width)) * Math.max(1, Math.round(height));
  const safeFps = Math.max(1, Math.min(Math.round(fps), 240));
  const raw = pixels * safeFps * BITS_PER_PIXEL[quality];
  const clamped = Math.max(MIN_BITRATE_BPS, Math.min(raw, MAX_BITRATE_BPS));
  return Math.round(clamped / 1000) * 1000;
}

/** Perkiraan ukuran berkas untuk durasi tertentu, byte. */
export function estimateBytes(bitrateBps: number, durationSec: number): number {
  const seconds = Math.max(0, durationSec);
  return Math.round((bitrateBps / 8) * seconds);
}

/**
 * Bitrate audio, bit/detik. `0` kalau audio dimatikan.
 *
 * Opus/AAC 128 kbps cukup untuk suara booth (tawa, ucapan singkat) dan tidak
 * menggeser perkiraan ukuran berkas secara berarti.
 */
export function audioBitrateBps(audio: boolean): number {
  return audio ? 128_000 : 0;
}
