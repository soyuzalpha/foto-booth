/**
 * Chroma key (green/blue screen) — murni.
 *
 * Warna dibandingkan di **bidang kroma** (Cb, Cr), bukan di RGB langsung.
 * Alasannya: di RGB, latar hijau yang kena bayangan jauh berbeda dari latar
 * hijau terang, padahal keduanya sama-sama "hijau". Memisahkan kroma dari
 * terang (Y) membuat keduanya terdeteksi sebagai warna kunci yang sama, tanpa
 * ikut membuang bagian gelap subjek.
 *
 * Tiga tombol, tiga fungsi berbeda — sengaja dipisah supaya bisa diuji sendiri:
 *
 *   · `similarity` — seberapa jauh warna masih dianggap latar (ambang dalam).
 *   · `smoothness` — lebar pita peralihan di tepi (anti-alias; tanpa ini tepi
 *     subjek bergerigi).
 *   · `spill`      — seberapa kuat pantulan warna kunci dibuang dari subjek.
 */

import { clamp01 } from "./util.ts";
import type { ChromaKeySettings, Rgb } from "./types.ts";

/** Jarak kroma maksimum; dipakai supaya similarity/smoothness (0..100) punya arti tetap. */
export const MAX_CHROMA_DISTANCE = 255;

export type Channel = "r" | "g" | "b";

/** Kanal mana yang paling dominan di warna kunci — dasar spill suppression. */
export function dominantChannel(color: Rgb): Channel {
  if (color.g >= color.r && color.g >= color.b) return "g";
  if (color.b >= color.r) return "b";
  return "r";
}

/** Kroma (Cb, Cr) dari sebuah piksel — memisahkan warna dari terang. */
export function chromaOf(r: number, g: number, b: number): { cb: number; cr: number } {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return { cb: b - y, cr: r - y };
}

/**
 * Alpha untuk satu piksel: `0` = tembus (latar), `1` = tampil (subjek).
 *
 * Di bawah ambang dalam → 0; di atas ambang luar → 1; di antaranya → gradasi
 * linear, yang jadi tepi halus. Kalau chroma key mati, selalu `1` — fungsi ini
 * tidak pernah "menebak" saat fitur tidak diminta.
 */
export function chromaKeyAlpha(
  r: number,
  g: number,
  b: number,
  key: ChromaKeySettings,
): number {
  if (!key.enabled) return 1;

  const p = chromaOf(r, g, b);
  const k = chromaOf(key.color.r, key.color.g, key.color.b);
  const distance = Math.hypot(p.cb - k.cb, p.cr - k.cr);

  const inner = clamp01(key.similarity / 100) * MAX_CHROMA_DISTANCE;
  const outer = inner + clamp01(key.smoothness / 100) * MAX_CHROMA_DISTANCE;

  if (distance <= inner) return 0;
  if (outer <= inner || distance >= outer) return 1;
  return (distance - inner) / (outer - inner);
}

/**
 * Buang pantulan warna kunci dari piksel yang tetap tampil.
 *
 * Untuk kunci hijau: kelebihan kanal hijau di atas kanal lain ditekan.
 * `spill = 100` memaksa kanal hijau turun sampai setara kanal terbesar
 * lainnya (mis. (100, 200, 100) → (100, 100, 100)); `spill = 0` membiarkan
 * semuanya apa adanya. Kanal yang **tidak** berlebih tidak pernah dinaikkan.
 */
export function suppressSpill(r: number, g: number, b: number, key: ChromaKeySettings): Rgb {
  const strength = clamp01(key.spill / 100);
  if (strength === 0) return { r, g, b };

  const channel = dominantChannel(key.color);

  if (channel === "g") {
    const ceiling = Math.max(r, b);
    return { r, g: g - Math.max(0, g - ceiling) * strength, b };
  }
  if (channel === "b") {
    const ceiling = Math.max(r, g);
    return { r, g, b: b - Math.max(0, b - ceiling) * strength };
  }

  const ceiling = Math.max(g, b);
  return { r: r - Math.max(0, r - ceiling) * strength, g, b };
}

/**
 * Terapkan chroma key ke seluruh buffer RGBA sekaligus — alpha dari
 * `chromaKeyAlpha`, warna dari `suppressSpill`.
 *
 * Dipisah dari adapter canvas supaya aturan keying bisa diuji pada array
 * byte nyata tanpa browser, dan adapter hanya menyediakan buffer-nya.
 * Piksel yang jadi tembus (`alpha = 0`) tidak perlu di-spill: warnanya tidak
 * akan terlihat lagi.
 */
export function keyImageData(data: Uint8ClampedArray, key: ChromaKeySettings): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;

    const alpha = chromaKeyAlpha(r, g, b, key);
    if (alpha <= 0) {
      data[i + 3] = 0;
      continue;
    }

    const spilled = suppressSpill(r, g, b, key);
    data[i] = spilled.r;
    data[i + 1] = spilled.g;
    data[i + 2] = spilled.b;
    data[i + 3] = Math.round(alpha * 255);
  }
}
