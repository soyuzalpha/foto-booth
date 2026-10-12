/**
 * Aspect ratio untuk preview dan hasil.
 *
 * Foto booth hampir selalu dicetak/dibagikan dalam rasio tetap, bukan rasio
 * sensor. Jadi crop dilakukan **sekali, di satu tempat**, dan hasilnya
 * dihitung dari frame asli — bukan dari preview yang sudah di-crop, supaya
 * tidak ada kehilangan resolusi berantai.
 *
 * Semua fungsi di sini murni: tidak menyentuh DOM. Bagian yang menyentuh DOM
 * (`cropToCanvas`) memakai `CropRect` yang dihasilkan di sini.
 */

export type AspectRatioId = "original" | "16:9" | "3:2" | "1:1";

export interface AspectRatioOption {
  id: AspectRatioId;
  label: string;
  /** `null` = ikut rasio asli frame. */
  ratio: number | null;
}

export const ASPECT_RATIOS: readonly AspectRatioOption[] = [
  { id: "original", label: "Original", ratio: null },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "1:1", label: "1:1", ratio: 1 },
];

export function aspectRatioById(id: AspectRatioId): AspectRatioOption | null {
  return ASPECT_RATIOS.find((option) => option.id === id) ?? null;
}

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

/**
 * Persegi terbesar dengan rasio `ratio` yang muat di dalam frame, di tengah.
 *
 * Selalu memotong dari frame asli (tidak pernah memperbesar), jadi hasilnya
 * tidak pernah lebih besar dari sumbernya. `ratio === null` mengembalikan
 * seluruh frame.
 */
export function computeCrop(source: FrameSize, ratio: number | null): CropRect {
  if (ratio === null || source.width <= 0 || source.height <= 0) {
    return { sx: 0, sy: 0, sw: source.width, sh: source.height };
  }

  const sourceRatio = source.width / source.height;

  let sw: number;
  let sh: number;

  if (sourceRatio > ratio) {
    // Sumber lebih lebar dari target → batasi tinggi, potong kiri-kanan.
    sh = source.height;
    sw = source.height * ratio;
  } else {
    // Sumber lebih tinggi dari target → batasi lebar, potong atas-bawah.
    sw = source.width;
    sh = source.width / ratio;
  }

  // Pembulatan ke bilangan bulat piksel, minimal 1.
  const width = Math.max(1, Math.floor(sw));
  const height = Math.max(1, Math.floor(sh));

  return {
    sx: Math.max(0, Math.floor((source.width - width) / 2)),
    sy: Math.max(0, Math.floor((source.height - height) / 2)),
    sw: width,
    sh: height,
  };
}

/** Ukuran keluaran setelah crop — dipakai untuk memvalidasi hasil di tes. */
export function croppedSize(source: FrameSize, ratio: number | null): FrameSize {
  const crop = computeCrop(source, ratio);
  return { width: crop.sw, height: crop.sh };
}

/**
 * Skala crop ke ukuran target sambil menjaga rasionya.
 * Dipakai kalau nanti perlu thumbnail dengan rasio yang sama.
 */
export function scaleToFit(source: FrameSize, maxEdge: number): FrameSize {
  const longest = Math.max(source.width, source.height);
  if (longest <= 0 || longest <= maxEdge) return { ...source };

  const factor = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(source.width * factor)),
    height: Math.max(1, Math.round(source.height * factor)),
  };
}

/** Crop `ImageBitmap`/`HTMLVideoElement` ke canvas — satu-satunya bagian DOM. */
export function cropToCanvas(
  source: CanvasImageSource,
  crop: CropRect,
  target?: FrameSize,
): HTMLCanvasElement {
  const width = target?.width ?? crop.sw;
  const height = target?.height ?? crop.sh;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("canvas 2d context tidak tersedia");

  ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);

  return canvas;
}
