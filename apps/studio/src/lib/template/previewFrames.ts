/**
 * Ambil frame hasil sesi terakhir buat dipakai pratinjau template.
 *
 * Tanpa ini, editor cuma menampilkan kotak kosong — operator tidak bisa menilai
 * apakah tata letaknya benar. Jadi editor **selalu** mencoba memuat foto nyata
 * dari sesi terakhir.
 *
 * Semua ketergantungan browser disuntik (`createImage`, `createUrl`,
 * `revokeUrl`) supaya alurnya bisa diuji di Node tanpa DOM.
 */

import type { FrameStore } from "../capture/frameStore.ts";
import type { FrameImage } from "./render.ts";

export interface LoadedFrames {
  sessionId: string | null;
  /** Satu entri per slot (urut `shotIndex`); `null` = slot kosong. */
  frames: (FrameImage | null)[];
  /**
   * Blob asli per slot. Disimpan supaya export bisa membuat `ImageBitmap`
   * **baru** tiap kali — `ImageBitmap` yang dikirim ke Worker ikut dipindah
   * (transfer) dan tidak bisa dipakai dua kali, sedangkan `HTMLImageElement`
   * yang dipakai editor tidak bisa dipindah sama sekali.
   */
  blobs: (Blob | null)[];
  /** Berapa frame mentah yang ditemukan di sesi itu. */
  count: number;
  /** Lepaskan object URL. Wajib dipanggil saat pratinjau diganti/dibongkar. */
  release(): void;
}

/**
 * Bagian `HTMLImageElement` yang benar-benar dipakai. Ditulis sempit begini
 * supaya tes bisa menyuntik gambar palsu tanpa memalsukan seluruh DOM.
 */
export interface DecodableImage {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  decode(): Promise<void>;
}

export interface LoadDeps {
  createImage?: () => DecodableImage;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

const EMPTY: LoadedFrames = {
  sessionId: null,
  frames: [],
  blobs: [],
  count: 0,
  release: () => {},
};

/** Sesi terakhir = sesi yang punya frame paling baru. */
function latestSessionId(
  frames: readonly { sessionId: string; capturedAt: number }[],
): string | null {
  let best: string | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;

  for (const frame of frames) {
    if (frame.capturedAt >= bestAt) {
      bestAt = frame.capturedAt;
      best = frame.sessionId;
    }
  }
  return best;
}

export async function loadLatestSessionFrames(
  store: FrameStore,
  deps: LoadDeps = {},
): Promise<LoadedFrames> {
  const createImage = deps.createImage ?? (() => new Image());
  const createUrl = deps.createUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeUrl = deps.revokeUrl ?? ((url: string) => URL.revokeObjectURL(url));

  const all = await store.all();
  const sessionId = latestSessionId(all);
  if (sessionId === null) return EMPTY;

  const sessionFrames = all
    .filter((frame) => frame.sessionId === sessionId)
    .sort((a, b) => a.shotIndex - b.shotIndex);

  const urls: string[] = [];
  const release = (): void => {
    for (const url of urls) revokeUrl(url);
    urls.length = 0;
  };

  const frames: (FrameImage | null)[] = [];
  const blobs: (Blob | null)[] = [];
  for (const frame of sessionFrames) {
    const url = createUrl(frame.blob);
    urls.push(url);

    const image = createImage();
    image.src = url;
    try {
      await image.decode();
    } catch {
      // Satu foto rusak tidak boleh menggagalkan seluruh pratinjau.
      frames.push(null);
      blobs.push(null);
      continue;
    }
    frames.push({
      // Seam-nya sengaja sempit (`DecodableImage`); di browser yang asli
      // memang `HTMLImageElement`, jadi cast ini aman dan disengaja.
      image: image as unknown as CanvasImageSource,
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
    blobs.push(frame.blob);
  }

  return { sessionId, frames, blobs, count: sessionFrames.length, release };
}
