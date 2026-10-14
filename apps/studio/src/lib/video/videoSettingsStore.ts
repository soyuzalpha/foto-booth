/**
 * Penyimpanan pengaturan video — murni.
 *
 * Pola yang sama dengan `filterSettingsStore.ts`: pengaturan video adalah
 * keputusan operator untuk satu acara, bukan satu rekaman. Menyetel ulang
 * resolusi/fps/audio tiap kali adalah pekerjaan yang tidak perlu di kiosk.
 *
 * `normalizeVideoSettings` menahan data rusak. localStorage bisa berisi JSON
 * dari versi lama (field hilang) atau hasil editan tangan; yang **tidak boleh**
 * terjadi adalah aplikasi gagal jalan karena satu angka bernilai `NaN`.
 */

import type { KeyValueStore } from "../capture/rememberedDevice.ts";
import {
  DEFAULT_VIDEO_SETTINGS,
  SLIDESHOW_FRAME_MS_LIMITS,
  SLOW_MO_FACTORS,
  VIDEO_FPS_OPTIONS,
  VIDEO_MAX_DURATION_LIMITS,
  VIDEO_RESOLUTIONS,
  type SlowMoFactor,
  type VideoAnimationKind,
  type VideoFps,
  type VideoQualityId,
  type VideoResolutionId,
  type VideoSettings,
} from "./types.ts";

export const VIDEO_SETTINGS_KEY = "foto-booth:video";

const RESOLUTION_IDS = VIDEO_RESOLUTIONS.map((r) => r.id);
const QUALITIES: readonly VideoQualityId[] = ["hemat", "standar", "maks"];
const ANIMATIONS: readonly VideoAnimationKind[] = ["none", "slideshow", "boomerang"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickNumber<T extends number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "number" && (allowed as readonly number[]).includes(value) ? (value as T) : fallback;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normalisasi apa pun menjadi `VideoSettings` yang sah. */
export function normalizeVideoSettings(input: unknown): VideoSettings {
  if (!isRecord(input)) return { ...DEFAULT_VIDEO_SETTINGS };

  return {
    resolution: pick<VideoResolutionId>(input.resolution, RESOLUTION_IDS, DEFAULT_VIDEO_SETTINGS.resolution),
    fps: pickNumber<VideoFps>(input.fps, VIDEO_FPS_OPTIONS, DEFAULT_VIDEO_SETTINGS.fps),
    maxDurationSec: Math.round(
      clamp(
        input.maxDurationSec,
        DEFAULT_VIDEO_SETTINGS.maxDurationSec,
        VIDEO_MAX_DURATION_LIMITS.min,
        VIDEO_MAX_DURATION_LIMITS.max,
      ),
    ),
    audio: typeof input.audio === "boolean" ? input.audio : DEFAULT_VIDEO_SETTINGS.audio,
    slowMo: pickNumber<SlowMoFactor>(input.slowMo, SLOW_MO_FACTORS, DEFAULT_VIDEO_SETTINGS.slowMo),
    quality: pick<VideoQualityId>(input.quality, QUALITIES, DEFAULT_VIDEO_SETTINGS.quality),
    animation: pick<VideoAnimationKind>(input.animation, ANIMATIONS, DEFAULT_VIDEO_SETTINGS.animation),
    slideshowFrameMs: Math.round(
      clamp(
        input.slideshowFrameMs,
        DEFAULT_VIDEO_SETTINGS.slideshowFrameMs,
        SLIDESHOW_FRAME_MS_LIMITS.min,
        SLIDESHOW_FRAME_MS_LIMITS.max,
      ),
    ),
  };
}

export function readVideoSettings(store: KeyValueStore | null): VideoSettings {
  if (store === null) return { ...DEFAULT_VIDEO_SETTINGS };
  try {
    const raw = store.getItem(VIDEO_SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_VIDEO_SETTINGS };
    return normalizeVideoSettings(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_VIDEO_SETTINGS };
  }
}

export function writeVideoSettings(store: KeyValueStore | null, settings: VideoSettings): void {
  if (store === null) return;
  try {
    store.setItem(VIDEO_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Penyimpanan penuh/diblokir: setelan hilang antar-sesi, alur tetap jalan.
  }
}
