/**
 * QR code album tamu.
 *
 * QR-nya **dibuat di perangkat**, bukan diambil dari layanan gambar QR online.
 * Kiosk harus tetap bisa menampilkan QR saat internet mati: URL-nya sudah
 * diketahui (dari API saat galeri dibuat), jadi tidak ada alasan memanggil
 * pihak ketiga — dan memanggilnya berarti QR hilang justru saat paling
 * dibutuhkan.
 *
 * Encoder-nya dari paket `qrcode` (MIT), bukan tulis sendiri. QR butuh
 * Reed-Solomon + pemilihan mask yang benar; implementasi setengah benar tetap
 * menghasilkan gambar yang *kelihatan* seperti QR tapi tidak terbaca scanner —
 * kegagalan yang cuma ketahuan di hari acara.
 *
 * Pustaka itu dipanggil lewat namespace (`import * as QRCode`): paketnya CJS
 * dengan ekspor bernama dan tanpa `export default`, jadi default import tidak
 * punya tipe.
 */

import * as QRCode from "qrcode";

import { GALLERY_BASE_PATH } from "@foto-booth/shared";

export interface QrOptions {
  /** Sisi gambar dalam piksel. */
  size?: number;
  /** Zona sunyi dalam modul. QR tanpa margin sering ditolak scanner. */
  margin?: number;
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  dark?: string;
  light?: string;
}

/**
 * Zona sunyi 4 modul adalah minimum di spesifikasi. `qrcode` menghitungnya
 * dari `margin` yang kita berikan, jadi nilainya tidak boleh 0.
 */
export const DEFAULT_QR_OPTIONS: Required<QrOptions> = {
  size: 320,
  margin: 4,
  errorCorrectionLevel: "M",
  dark: "#000000",
  light: "#ffffff",
};

/**
 * Hash galeri hanya boleh berisi karakter URL-aman. Ini **bukan** validasi
 * keamanan (API yang menentukan hash); gunanya menolak lebih awal nilai yang
 * jelas rusak, supaya yang tampil di layar bukan QR berisi URL setengah jadi.
 */
export function isSafeGalleryHash(hash: string): boolean {
  return /^[A-Za-z0-9_-]{4,64}$/.test(hash);
}

/**
 * URL album tamu dari origin + hash.
 *
 * Origin sengaja tidak di-hardcode: galeri yang sama harus benar dibuka lewat
 * tunnel publik, LAN, maupun `localhost` saat dikembangkan. Yang tahu origin
 * adalah browser, bukan konstanta di kode.
 */
export function galleryUrl(origin: string, hash: string): string {
  return `${origin.replace(/\/+$/, "")}${GALLERY_BASE_PATH}${hash}`;
}

function rendererOptions(options: QrOptions): QRCode.QRCodeRenderersOptions {
  return {
    width: options.size ?? DEFAULT_QR_OPTIONS.size,
    margin: options.margin ?? DEFAULT_QR_OPTIONS.margin,
    errorCorrectionLevel: options.errorCorrectionLevel ?? DEFAULT_QR_OPTIONS.errorCorrectionLevel,
    color: {
      dark: options.dark ?? DEFAULT_QR_OPTIONS.dark,
      light: options.light ?? DEFAULT_QR_OPTIONS.light,
    },
  };
}

/**
 * QR sebagai markup SVG.
 *
 * SVG dipilih ketimbang PNG karena hasilnya tajam di layar berapa pun dan
 * tidak perlu `<canvas>` — jadi tidak ada ketergantungan pada DOM saat dirender
 * di luar browser (mis. saat diuji).
 */
export async function renderQrSvg(text: string, options: QrOptions = {}): Promise<string> {
  if (text === "") throw new Error("QR tidak bisa dibuat dari teks kosong");
  return QRCode.toString(text, { ...rendererOptions(options), type: "svg" });
}

/** QR sebagai data-URL PNG — dipakai kalau perlu diunduh operator. */
export async function renderQrDataUrl(text: string, options: QrOptions = {}): Promise<string> {
  if (text === "") throw new Error("QR tidak bisa dibuat dari teks kosong");
  return QRCode.toDataURL(text, { ...rendererOptions(options), type: "image/png" });
}
