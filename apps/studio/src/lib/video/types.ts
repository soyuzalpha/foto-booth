/**
 * Tipe & pengaturan rekaman video (Fase 7) — murni, tanpa DOM.
 *
 * Sama seperti `filters/types.ts` untuk foto: semua keputusan operator
 * dikumpulkan di satu objek `VideoSettings`, supaya "apa yang harus direkam"
 * bisa dihitung dari satu sumber. Objeknya murni data, jadi bisa
 * diserialisasi (localStorage) dan diuji di Node tanpa browser.
 *
 * Default = **paling aman**: resolusi 720p, 30 fps, 15 detik, **tanpa audio**,
 * **tanpa slow-mo**, animasi mati. Kiosk yang belum pernah disentuh operator
 * harus merekam video yang wajar — bukan 4K 60 fps yang memenuhi disk.
 */

/** Resolusi keluaran. Nilainya tinggi piksel, bukan label pemasaran. */
export type VideoResolutionId = "480p" | "720p" | "1080p" | "2160p";

export type VideoFps = 24 | 30 | 60;

/** Faktor perlambatan. `1` = kecepatan normal. */
export type SlowMoFactor = 1 | 0.5 | 0.25;

/** Preset kualitas video (memengaruhi bitrate, bukan resolusi). */
export type VideoQualityId = "hemat" | "standar" | "maks";

/** Animasi dari foto yang sudah dijepret (bukan rekaman langsung). */
export type VideoAnimationKind = "none" | "slideshow" | "boomerang";

export interface VideoSettings {
  resolution: VideoResolutionId;
  fps: VideoFps;
  /** Batas durasi rekaman, detik. Lihat `VIDEO_MAX_DURATION_LIMITS`. */
  maxDurationSec: number;
  /** Rekam audio dari mikrofon/device input. */
  audio: boolean;
  slowMo: SlowMoFactor;
  quality: VideoQualityId;
  /** Animasi dari foto; `none` = rekaman kamera biasa. */
  animation: VideoAnimationKind;
  /** Lama tiap foto tampil di slideshow/boomerang, milidetik. */
  slideshowFrameMs: number;
}

export interface VideoResolution {
  id: VideoResolutionId;
  label: string;
  width: number;
  height: number;
}

/**
 * Daftar resolusi, urut dari terkecil. Semuanya lanskap 16:9 karena itu yang
 * dipakai kamera & printer booth; potret ditangani oleh rotasi di pipeline foto.
 */
export const VIDEO_RESOLUTIONS: readonly VideoResolution[] = [
  { id: "480p", label: "480p (854×480)", width: 854, height: 480 },
  { id: "720p", label: "720p (1280×720)", width: 1280, height: 720 },
  { id: "1080p", label: "1080p (1920×1080)", width: 1920, height: 1080 },
  { id: "2160p", label: "2160p / 4K (3840×2160)", width: 3840, height: 2160 },
];

const RESOLUTION_FALLBACK = VIDEO_RESOLUTIONS[1] as VideoResolution;

export function videoResolutionById(id: VideoResolutionId): VideoResolution {
  return VIDEO_RESOLUTIONS.find((r) => r.id === id) ?? RESOLUTION_FALLBACK;
}

export const VIDEO_FPS_OPTIONS: readonly VideoFps[] = [24, 30, 60];

export const SLOW_MO_FACTORS: readonly SlowMoFactor[] = [1, 0.5, 0.25];

/**
 * Batas durasi. Bawah 1 detik tidak masuk akal untuk booth; atas 60 detik
 * membuat berkas terlalu besar untuk diunduh tamu lewat QR.
 */
export const VIDEO_MAX_DURATION_LIMITS = { min: 1, max: 60 } as const;

/** Batas lama tiap foto di animasi, milidetik. */
export const SLIDESHOW_FRAME_MS_LIMITS = { min: 200, max: 5000 } as const;

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  resolution: "720p",
  fps: 30,
  maxDurationSec: 15,
  audio: false,
  slowMo: 1,
  quality: "standar",
  animation: "none",
  slideshowFrameMs: 900,
};

/**
 * Faktor yang dipakai untuk **merekam** agar slow-mo punya bahan.
 *
 * Slow-mo sejati butuh frame lebih banyak daripada yang ditampilkan. Kalau
 * output 30 fps dan faktor 0,5, rekaman harus 60 fps supaya tiap frame output
 * punya pasangan asli — kalau tidak, hasilnya cuma frame yang ditahan (patah).
 */
export function captureFpsFor(fps: VideoFps, factor: SlowMoFactor): number {
  if (factor >= 1) return fps;
  const needed = Math.round(fps / factor);
  return Math.min(needed, 240);
}
