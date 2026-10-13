/**
 * Tipe & nilai default untuk pipeline filter foto (Fase 6).
 *
 * Semua pengaturan dikumpulkan di satu objek `FilterSettings` supaya pipeline
 * bisa memutuskan *apa yang perlu dikerjakan* dari satu sumber — bukan dari
 * beberapa state UI yang tersebar. Objek ini murni data: tidak menyentuh DOM,
 * jadi bisa diserialisasi (disimpan di localStorage) dan diuji di Node.
 */

export type RotationDegrees = 0 | 90 | 180 | 270;

export type BackgroundMode = "none" | "color" | "blur" | "ai";

export type QualityPresetId = "hemat" | "standar" | "maks";

export interface Rgb {
  /** 0..255 */
  r: number;
  g: number;
  b: number;
}

export interface Adjustments {
  /** -100..100 · 0 = netral. */
  brightness: number;
  contrast: number;
  saturation: number;
}

export interface ChromaKeySettings {
  enabled: boolean;
  /** Warna yang dibuang (biasanya hijau atau biru). */
  color: Rgb;
  /** 0..100 · makin besar makin banyak warna yang dianggap latar. */
  similarity: number;
  /** 0..100 · kelembutan tepi (anti-alias). */
  smoothness: number;
  /** 0..100 · seberapa kuat pantulan warna kunci dibuang dari tepi subjek. */
  spill: number;
}

export interface BackgroundSettings {
  mode: BackgroundMode;
  /** Dipakai mode `color`. */
  color: Rgb;
  /** 0..100 · kekuatan blur latar (mode `blur`). */
  blur: number;
}

export interface FilterSettings {
  rotation: RotationDegrees;
  quality: QualityPresetId;
  chromaKey: ChromaKeySettings;
  adjustments: Adjustments;
  background: BackgroundSettings;
  faceEnhance: boolean;
}

/** Hijau standar chroma key — jauh dari warna kulit, jadi aman untuk potret. */
export const CHROMA_GREEN: Rgb = { r: 0, g: 255, b: 0 };

/** Biru standar (blue screen) untuk subjek yang memakai pakaian hijau. */
export const CHROMA_BLUE: Rgb = { r: 0, g: 0, b: 255 };

/**
 * Default = **tanpa filter apa pun**. Ini disengaja: aplikasi yang belum
 * pernah disentuh operator harus menghasilkan foto apa adanya, bukan foto yang
 * diam-diam dikey atau di-blur.
 */
export const DEFAULT_FILTER_SETTINGS: FilterSettings = {
  rotation: 0,
  quality: "standar",
  chromaKey: {
    enabled: false,
    color: { ...CHROMA_GREEN },
    similarity: 35,
    smoothness: 15,
    spill: 50,
  },
  adjustments: { brightness: 0, contrast: 0, saturation: 0 },
  background: { mode: "none", color: { r: 255, g: 255, b: 255 }, blur: 50 },
  faceEnhance: false,
};
