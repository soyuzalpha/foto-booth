/**
 * Jembatan klip video → jalur simpan (arsip lokal + antrian upload).
 *
 * Sama alasannya dengan `composedToIntake.ts` untuk foto: `VideoClip` adalah
 * bahasa mesin rekam (plan, extension, durasi), `IntakePhoto` bahasa
 * penyimpanan (nama berkas, tipe konten, thumbnail). Menerjemahkan di satu
 * tempat berarti kedua sisi bisa berubah tanpa saling menyeret.
 *
 * Dua aturan yang dijaga di sini:
 *
 *   · **Klip tanpa byte tidak pernah masuk antrian.** `MediaRecorder` yang
 *     ditolak browser menghasilkan `Blob` kosong; mendaftarkannya berarti
 *     operator melihat "1 tersimpan" untuk berkas yang tidak ada isinya.
 *   · **Kegagalan thumbnail tidak menggagalkan klip.** Poster video itu
 *     kemewahan; tamu tetap harus menerima berkasnya. `null` selalu jawaban
 *     yang sah.
 */

import { UPLOAD_CONTENT_TYPES, type UploadContentType } from "@foto-booth/shared";

import type { IntakePhoto } from "../upload/photoIntake.ts";
import type { VideoClip } from "./videoSession.ts";

/**
 * Tipe konten yang dikenali API, atau `null`.
 *
 * Daftarnya dari `packages/shared` — bukan salinan lokal: begitu `video/av1`
 * ditambahkan di shared, studio ikut mengenalinya tanpa ada berkas kedua yang
 * harus diingat.
 */
export function asUploadContentType(value: string): UploadContentType | null {
  return (UPLOAD_CONTENT_TYPES as readonly string[]).includes(value)
    ? (value as UploadContentType)
    : null;
}

export interface ClipIntakeOptions {
  /** Sumber poster. `null` = tidak ada poster; itu bukan kegagalan. */
  makeThumb?: (blob: Blob) => Promise<Blob | null>;
  /** Nomor urut dalam sesi. Default: nomor urut klip. */
  index?: number;
}

/**
 * Ubah satu klip jadi foto-siap-simpan.
 *
 * `null` = klip ini tidak boleh masuk antrian (kosong atau tipe kontennya tidak
 * dikenal API). Pemanggil tidak perlu memeriksa ukuran blob lagi.
 */
export async function clipToIntake(
  clip: VideoClip,
  options: ClipIntakeOptions = {},
): Promise<IntakePhoto | null> {
  if (clip.blob.size === 0) return null;

  const contentType = asUploadContentType(clip.contentType);
  if (contentType === null) return null;

  let thumb: Blob | null = null;
  if (options.makeThumb !== undefined) {
    try {
      thumb = await options.makeThumb(clip.blob);
    } catch {
      // Poster best-effort: pembuatnya boleh melempar (codec tidak ada,
      // metadata tidak pernah siap), klipnya tetap ikut.
      thumb = null;
    }
  }

  return {
    blob: clip.blob,
    thumb,
    contentType,
    width: clip.width,
    height: clip.height,
    filename: clip.filename,
    index: options.index ?? clip.index,
  };
}

/**
 * Satu frame sumber animasi (slideshow/boomerang) yang sudah punya piksel.
 *
 * `image` sengaja `unknown`: di browser isinya `ImageBitmap`, di tes cukup
 * objek apa saja. Yang menggambar tahu tipe sebenarnya.
 */
export interface AnimationFrameSource {
  index: number;
  image: unknown;
  width: number;
  height: number;
}

/**
 * Dekode daftar foto jadi frame sumber animasi.
 *
 * Foto yang gagal didekode **dilewati**, bukan menggagalkan seluruh animasi:
 * slideshow dari tiga dari empat foto jauh lebih baik daripada tidak ada
 * animasi sama sekali. Nomor urut (`index`) tetap mengikuti posisi aslinya
 * supaya urutan tamu tidak tertukar.
 */
export async function decodeFrames(
  blobs: readonly Blob[],
  decode: (blob: Blob) => Promise<{ image: unknown; width: number; height: number } | null>,
): Promise<AnimationFrameSource[]> {
  const frames: AnimationFrameSource[] = [];

  for (let index = 0; index < blobs.length; index += 1) {
    const blob = blobs[index];
    if (blob === undefined) continue;

    try {
      const decoded = await decode(blob);
      if (decoded === null || decoded.width <= 0 || decoded.height <= 0) continue;
      frames.push({ index, image: decoded.image, width: decoded.width, height: decoded.height });
    } catch {
      continue;
    }
  }

  return frames;
}

/** Ringkasan satu klip untuk UI/debug — angka, bukan prosa. */
export function describeClip(clip: VideoClip): string {
  const seconds = Math.round(clip.durationSec * 10) / 10;
  const megabytes = Math.round((clip.blob.size / (1024 * 1024)) * 10) / 10;
  return `${clip.filename} · ${clip.width}×${clip.height} · ${seconds} dtk · ${megabytes} MB`;
}
