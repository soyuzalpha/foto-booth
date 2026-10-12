/**
 * Mengambil foto diam resolusi penuh.
 *
 * Dua jalur, dan keduanya perlu ada:
 *
 * 1. **`ImageCapture.takePhoto()`** — jalur bagus. Mengambil still resolusi
 *    penuh dari sensor, bukan dari frame preview. Chrome/Edge saja.
 * 2. **Canvas fallback** — `drawImage(video)` lalu `toBlob()`. Resolusinya
 *    mentok di resolusi stream, tapi jalan di Firefox dan Safari.
 *
 * Yang penting: fallback bukan "kalau sempat". Kalau `ImageCapture` tidak ada
 * atau gagal, kita **wajib** tetap menghasilkan foto — booth yang menolak
 * jepret lebih buruk daripada booth dengan resolusi lebih rendah.
 */

import type { StillStrategy } from "./types.ts";

export interface StillResult {
  blob: Blob;
  width: number;
  height: number;
  strategy: StillStrategy;
}

export interface StillOptions {
  /** Kualitas JPEG 0..1. */
  quality?: number;
  /** MIME output. JPEG default karena semua browser mendukungnya. */
  type?: string;
  /** Batas lama `takePhoto()` sebelum menyerah ke canvas. */
  takePhotoTimeoutMs?: number;
}

/** Apakah `ImageCapture` tersedia di lingkungan ini. */
export function hasImageCapture(): boolean {
  return typeof globalThis.ImageCapture === "function";
}

/**
 * Pilih jalur still. Dipisah jadi fungsi murni supaya bisa diuji dan supaya
 * fallback tidak bergantung pada `try/catch` yang tak terlihat.
 */
export function pickStillStrategy(imageCaptureAvailable: boolean): StillStrategy {
  return imageCaptureAvailable ? "image-capture" : "canvas";
}

/** Video sudah punya frame yang bisa digambar? */
export function isVideoReady(video: {
  videoWidth: number;
  videoHeight: number;
  readyState: number;
}): boolean {
  // `readyState >= 2` (HAVE_CURRENT_DATA) saja tidak cukup: capture card baru
  // dicolok melaporkan readyState tinggi dengan dimensi 0×0. Dimensi yang
  // menentukan, karena tanpa itu canvas menghasilkan gambar kosong.
  return video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2;
}

/**
 * Tunggu sampai frame pertama benar-benar valid.
 *
 * Ini yang mencegah "foto hitam pertama setelah colok HDMI" — masalah klasik
 * capture card yang butuh 1–3 detik warm-up.
 */
export async function waitForVideoReady(
  video: HTMLVideoElement,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 4000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (isVideoReady(video)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return isVideoReady(video);
}

async function canvasFromVideo(
  video: HTMLVideoElement,
  options: StillOptions,
): Promise<StillResult> {
  const width = video.videoWidth;
  const height = video.videoHeight;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("canvas 2d context tidak tersedia");

  ctx.drawImage(video, 0, 0, width, height);

  const type = options.type ?? "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type, options.quality ?? 0.92);
  });

  if (blob === null) throw new Error("canvas.toBlob() mengembalikan null");

  return { blob, width, height, strategy: "canvas" };
}

/**
 * `takePhoto()` mengembalikan `Blob` (yang mengembalikan `ImageBitmap` adalah
 * `grabFrame()`). Blob-nya sudah JPEG resolusi penuh — cukup di-decode sekali
 * untuk membaca dimensinya, lalu diteruskan apa adanya tanpa re-encode.
 */
async function photoToResult(photo: Blob): Promise<StillResult> {
  const bitmap = await createImageBitmap(photo);
  try {
    return {
      blob: photo,
      width: bitmap.width,
      height: bitmap.height,
      strategy: "image-capture",
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Jepret satu frame diam dari stream yang sedang jalan.
 *
 * Selalu mengembalikan hasil. Kalau `takePhoto()` gagal (device sibuk, capture
 * card tidak mendukung), jalur canvas dipakai tanpa mengeluh — tapi `strategy`
 * di hasil memberi tahu jalur mana yang benar-benar terpakai, jadi bisa diaudit.
 */
export async function captureStill(
  track: MediaStreamTrack | null,
  video: HTMLVideoElement,
  options: StillOptions = {},
): Promise<StillResult> {
  if (!isVideoReady(video)) {
    throw new Error("video belum punya frame valid — tunggu warm-up");
  }

  if (pickStillStrategy(hasImageCapture() && track !== null) === "image-capture" && track !== null) {
    try {
      const imageCapture = new ImageCapture(track);
      const photo = await imageCapture.takePhoto();
      return await photoToResult(photo);
    } catch {
      // Device tidak mendukung takePhoto (banyak capture card UVC murah),
      // atau device sibuk. Jatuh ke canvas — jangan gagalkan sesi.
    }
  }

  return canvasFromVideo(video, options);
}
