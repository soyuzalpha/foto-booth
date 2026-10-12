/**
 * Preset resolusi untuk capture card & webcam.
 *
 * `MediaStreamTrack.getCapabilities()` tidak memberi daftar mode (720p, 1080p,
 * …) — hanya rentang `min`/`max` per sumbu. Jadi kita tawarkan preset umum dan
 * saring dengan batas kemampuan device, supaya operator tidak memilih 4K di
 * capture card yang mentok 1080p.
 */

export interface ResolutionPreset {
  label: string;
  width: number;
  height: number;
}

export const RESOLUTION_PRESETS: readonly ResolutionPreset[] = [
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
  { label: "1440p", width: 2560, height: 1440 },
  { label: "2160p", width: 3840, height: 2160 },
];

/** Bentuk minimal `MediaTrackCapabilities` yang kita pakai. */
export interface ResolutionCapabilities {
  width?: { max?: number };
  height?: { max?: number };
}

/**
 * Preset yang muat di kemampuan device.
 *
 * Kalau `capabilities` tidak tersedia (Safari tidak punya `getCapabilities()`),
 * kembalikan semua preset — lebih baik operator mencoba dan gagal dengan pesan
 * `overconstrained` daripada kita menyembunyikan pilihan berdasarkan tebakan.
 */
export function availablePresets(
  capabilities: ResolutionCapabilities | null,
): readonly ResolutionPreset[] {
  if (capabilities === null) return RESOLUTION_PRESETS;

  const maxWidth = capabilities.width?.max;
  const maxHeight = capabilities.height?.max;

  if (maxWidth === undefined && maxHeight === undefined) return RESOLUTION_PRESETS;

  return RESOLUTION_PRESETS.filter((preset) => {
    if (maxWidth !== undefined && preset.width > maxWidth) return false;
    if (maxHeight !== undefined && preset.height > maxHeight) return false;
    return true;
  });
}

/** Preset terbesar yang muat — dipakai sebagai default saat menyambung. */
export function bestPreset(
  capabilities: ResolutionCapabilities | null,
): ResolutionPreset | null {
  const presets = availablePresets(capabilities);
  return presets.length === 0 ? null : (presets[presets.length - 1] ?? null);
}

/** Preset yang paling dekat dengan dimensi nyata stream. */
export function matchPreset(
  width: number,
  height: number,
): ResolutionPreset | null {
  let best: ResolutionPreset | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const preset of RESOLUTION_PRESETS) {
    const distance = Math.abs(preset.width - width) + Math.abs(preset.height - height);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = preset;
    }
  }

  return best;
}
