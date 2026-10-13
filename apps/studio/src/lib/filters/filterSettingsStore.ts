/**
 * Penyimpanan pengaturan filter — murni.
 *
 * Pengaturan filter (rotasi, chroma key, koreksi warna, latar) itu keputusan
 * operator untuk satu acara, bukan satu foto. Menyetel ulang tiap sesi itu
 * melelahkan di kiosk, jadi nilainya disimpan di localStorage — persis seperti
 * `CONFIG_KEY` di `useCaptureSession.ts`.
 *
 * `normalizeFilterSettings` menahan data rusak: localStorage bisa berisi JSON
 * dari versi aplikasi lama (field hilang) atau hasil editan tangan. Yang
 * **tidak** boleh terjadi adalah aplikasi gagal jalan hanya karena satu angka
 * di penyimpanan bernilai `NaN`. Karena itu setiap field divalidasi dan
 * dijatuhkan ke default — bukan dipercaya begitu saja.
 *
 * Objeknya sengaja murni data (tanpa DOM) supaya bisa diserialisasi dan diuji
 * di Node.
 */

import type { KeyValueStore } from "../capture/rememberedDevice.ts";
import {
  CHROMA_BLUE,
  CHROMA_GREEN,
  DEFAULT_FILTER_SETTINGS,
  type Adjustments,
  type BackgroundMode,
  type BackgroundSettings,
  type ChromaKeySettings,
  type FilterSettings,
  type QualityPresetId,
  type Rgb,
  type RotationDegrees,
} from "./types.ts";

/** Kunci penyimpanan; diekspor supaya tes & panel debug menyebut hal yang sama. */
export const FILTER_SETTINGS_KEY = "foto-booth:filters";

const ROTATIONS: readonly RotationDegrees[] = [0, 90, 180, 270];
const QUALITIES: readonly QualityPresetId[] = ["hemat", "standar", "maks"];
const BACKGROUND_MODES: readonly BackgroundMode[] = ["none", "color", "blur", "ai"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Angka berhingga, atau `fallback`. `NaN`/`Infinity`/string dianggap tidak ada. */
function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Angka yang dijepit ke rentang. */
function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = num(value, fallback);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function rgb(value: unknown, fallback: Rgb): Rgb {
  if (!isRecord(value)) return { ...fallback };
  return {
    r: clamp(value.r, fallback.r, 0, 255),
    g: clamp(value.g, fallback.g, 0, 255),
    b: clamp(value.b, fallback.b, 0, 255),
  };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Sama seperti `pick`, tapi untuk nilai numerik (rotasi). */
function pickNumber<T extends number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "number" && (allowed as readonly number[]).includes(value)
    ? (value as T)
    : fallback;
}

function normalizeChromaKey(value: unknown): ChromaKeySettings {
  const base = DEFAULT_FILTER_SETTINGS.chromaKey;
  if (!isRecord(value)) return { ...base, color: { ...base.color } };
  return {
    enabled: value.enabled === true,
    color: rgb(value.color, base.color),
    similarity: clamp(value.similarity, base.similarity, 0, 100),
    smoothness: clamp(value.smoothness, base.smoothness, 0, 100),
    spill: clamp(value.spill, base.spill, 0, 100),
  };
}

function normalizeAdjustments(value: unknown): Adjustments {
  const base = DEFAULT_FILTER_SETTINGS.adjustments;
  if (!isRecord(value)) return { ...base };
  return {
    brightness: clamp(value.brightness, base.brightness, -100, 100),
    contrast: clamp(value.contrast, base.contrast, -100, 100),
    saturation: clamp(value.saturation, base.saturation, -100, 100),
  };
}

function normalizeBackground(value: unknown): BackgroundSettings {
  const base = DEFAULT_FILTER_SETTINGS.background;
  if (!isRecord(value)) return { ...base, color: { ...base.color } };
  return {
    mode: pick(value.mode, BACKGROUND_MODES, base.mode),
    color: rgb(value.color, base.color),
    blur: clamp(value.blur, base.blur, 0, 100),
  };
}

/**
 * Rapikan objek apa pun menjadi `FilterSettings` yang sah.
 *
 * Tidak pernah melempar: masukan `null`/string/objek separuh tetap menghasilkan
 * pengaturan default yang bisa dipakai.
 */
export function normalizeFilterSettings(input: unknown): FilterSettings {
  if (!isRecord(input)) {
    return structuredCloneish(DEFAULT_FILTER_SETTINGS);
  }
  return {
    rotation: pickNumber(input.rotation, ROTATIONS, DEFAULT_FILTER_SETTINGS.rotation),
    quality: pick(input.quality, QUALITIES, DEFAULT_FILTER_SETTINGS.quality),
    chromaKey: normalizeChromaKey(input.chromaKey),
    adjustments: normalizeAdjustments(input.adjustments),
    background: normalizeBackground(input.background),
    faceEnhance: input.faceEnhance === true,
  };
}

/** Salinan dalam supaya pemanggil tidak bisa mengubah default global. */
function structuredCloneish(value: FilterSettings): FilterSettings {
  return {
    rotation: value.rotation,
    quality: value.quality,
    chromaKey: { ...value.chromaKey, color: { ...value.chromaKey.color } },
    adjustments: { ...value.adjustments },
    background: { ...value.background, color: { ...value.background.color } },
    faceEnhance: value.faceEnhance,
  };
}

/** Baca pengaturan tersimpan; default kalau tidak ada / rusak. */
export function readFilterSettings(store: KeyValueStore | null): FilterSettings {
  if (store === null) return structuredCloneish(DEFAULT_FILTER_SETTINGS);
  try {
    const raw = store.getItem(FILTER_SETTINGS_KEY);
    if (raw === null) return structuredCloneish(DEFAULT_FILTER_SETTINGS);
    return normalizeFilterSettings(JSON.parse(raw) as unknown);
  } catch {
    return structuredCloneish(DEFAULT_FILTER_SETTINGS);
  }
}

/** Simpan pengaturan; kegagalan penyimpanan tidak boleh menghentikan alur. */
export function writeFilterSettings(store: KeyValueStore | null, settings: FilterSettings): void {
  if (store === null) return;
  try {
    store.setItem(FILTER_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Penyimpanan penuh / diblokir: pengaturan tetap berlaku di sesi ini.
  }
}

/** Preset kroma yang dikenal, untuk tombol cepat di UI. */
export const CHROMA_SWATCHES: readonly { id: string; label: string; color: Rgb }[] = [
  { id: "green", label: "Hijau", color: { ...CHROMA_GREEN } },
  { id: "blue", label: "Biru", color: { ...CHROMA_BLUE } },
];
