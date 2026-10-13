/**
 * Offset tunda shutter — murni.
 *
 * Hitungan di layar selesai di angka 0, tapi jari & kelopak mata tamu belum
 * benar-benar tenang. Offset ini menyisipkan jeda kecil **setelah hitungan
 * habis dan sebelum frame diambil**, supaya yang terjepret adalah pose yang
 * sudah mantap, bukan wajah yang masih menutup mata karena baru berkedip saat
 * angka 0 muncul.
 *
 * Offset dihitung **terpisah dari countdown** — bukan sekadar menambah angka
 * hitungan. Kalau ditambahkan ke countdown, layar akan menampilkan "1" lebih
 * lama dari yang tamu harapkan; dengan jeda terpisah, angka tetap jujur dan
 * jeda tambahannya tidak terlihat.
 */

/** Batas atas offset, ms. Lebih dari ini tamu mengira kameranya hang. */
export const MAX_SHUTTER_OFFSET_MS = 2000;

/** Jumlah langkah yang wajar (mis. 0, 150, 300, …) untuk slider UI. */
export const SHUTTER_OFFSET_STEP_MS = 50;

/** Jepit offset ke `0..MAX_SHUTTER_OFFSET_MS`, bulatkan ke langkah terdekat. */
export function normalizeShutterOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const stepped = Math.round(value / SHUTTER_OFFSET_STEP_MS) * SHUTTER_OFFSET_STEP_MS;
  return Math.min(MAX_SHUTTER_OFFSET_MS, Math.max(0, stepped));
}

/**
 * Apakah waktunya mengambil frame.
 *
 * `elapsedSinceZeroMs` = waktu yang sudah lewat sejak hitungan menyentuh nol.
 * Offset 0 → langsung ambil (perilaku lama tidak berubah).
 */
export function shutterGrabDue(elapsedSinceZeroMs: number, offsetMs: number): boolean {
  return elapsedSinceZeroMs >= normalizeShutterOffset(offsetMs);
}

/** Sisa jeda sebelum frame diambil; `0` kalau sudah waktunya. */
export function shutterRemainingMs(elapsedSinceZeroMs: number, offsetMs: number): number {
  const offset = normalizeShutterOffset(offsetMs);
  return Math.max(0, offset - Math.max(0, elapsedSinceZeroMs));
}

/** Label singkat untuk UI ("tidak ada" / "0,3 dtk"). */
export function describeShutterOffset(offsetMs: number): string {
  const offset = normalizeShutterOffset(offsetMs);
  if (offset === 0) return "tidak ada";
  // `toFixed` memakai titik desimal; UI berbahasa Indonesia memakai koma.
  const seconds = (offset / 1000).toFixed(offset % 1000 === 0 ? 0 : 1).replace(".", ",");
  return `${seconds} dtk`;
}
