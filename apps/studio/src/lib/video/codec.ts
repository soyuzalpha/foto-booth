/**
 * Pemilihan kontainer/kodek rekaman — murni, dengan dukungan yang disuntik.
 *
 * Browser tidak sepakat soal format rekaman: Chrome/Firefox paham WebM
 * (VP8/VP9 + Opus), Safari paham MP4 (H.264 + AAC). Kalau kita mengunci satu
 * format saja, separuh kiosk menghasilkan berkas yang tidak bisa diputar tamu.
 *
 * Karena itu urutan preferensi ditulis di sini sebagai **data**, dan
 * pemilihannya (`pickMimeType`) menerima fungsi "apakah didukung?" sebagai
 * argumen — sehingga bisa diuji di Node tanpa `MediaRecorder`.
 *
 * Aturan yang dijaga: kalau **tidak ada** kandidat yang didukung, hasilnya
 * `null` — pemanggil wajib memperlakukannya sebagai "tidak bisa merekam",
 * bukan diam-diam memakai format yang mungkin ditolak browser.
 */

/** Urutan preferensi: MP4/H.264 dulu (paling universal buat tamu), lalu WebM. */
export const VIDEO_MIME_PREFERENCES: readonly string[] = [
  "video/mp4;codecs=avc1.4d002a,mp4a.40.2",
  "video/mp4;codecs=avc1.42e01e,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

/** Urutan preferensi kalau audio dimatikan — kandidat ber-audio tidak dipakai. */
export const VIDEO_MIME_PREFERENCES_NO_AUDIO: readonly string[] = [
  "video/mp4;codecs=avc1.4d002a",
  "video/mp4;codecs=avc1.42e01e",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export function preferencesFor(audio: boolean): readonly string[] {
  return audio ? VIDEO_MIME_PREFERENCES : VIDEO_MIME_PREFERENCES_NO_AUDIO;
}

/**
 * Kandidat pertama yang didukung, atau `null`.
 *
 * `isSupported` disuntik (biasanya `MediaRecorder.isTypeSupported`) supaya
 * logika ini bisa diuji tanpa browser.
 */
export function pickMimeType(
  candidates: readonly string[],
  isSupported: (mimeType: string) => boolean,
): string | null {
  for (const candidate of candidates) {
    try {
      if (isSupported(candidate)) return candidate;
    } catch {
      // `isTypeSupported` bisa melempar untuk string aneh di sebagian browser;
      // anggap saja tidak didukung dan lanjut ke kandidat berikutnya.
    }
  }
  return null;
}

/** Ekstensi berkas dari tipe MIME. Default `webm` untuk yang tidak dikenali. */
export function extensionForMimeType(mimeType: string | null): "mp4" | "webm" {
  return mimeType !== null && mimeType.includes("mp4") ? "mp4" : "webm";
}

/** Tipe konten yang dipakai saat berkas disimpan/diunduh. */
export function contentTypeForMimeType(mimeType: string | null): string {
  return extensionForMimeType(mimeType) === "mp4" ? "video/mp4" : "video/webm";
}
