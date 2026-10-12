/**
 * Idle reset kiosk (Fase 4, §B47).
 *
 * Mesin ini **murni**: tidak ada timer di dalamnya, hanya fungsi yang memetakan
 * (config, state, now) → status. Hook React yang menyediakan detak waktu, dan
 * `now` injectable supaya tes memeriksa angka, bukan menunggu detik nyata.
 *
 * Kontrak:
 *  - Aktivitas apa pun (pointer/keyboard/sentuh) memulai ulang hitungan.
 *  - `warningMs` sebelum batas, status naik ke `warning` → UI menampilkan
 *    hitung mundur + tombol "masih di sini".
 *  - Lewat batas → `expired`. Pemanggil yang memutuskan aksi resetnya.
 *  - Selama sesi foto berjalan, hitungan **ditahan** (`suspended`): kiosk tidak
 *    boleh me-reset di tengah orang berpose.
 */

export interface IdleConfig {
  /** Total diam sebelum reset. */
  timeoutMs: number;
  /** Berapa lama sebelum batas, peringatan muncul. */
  warningMs: number;
}

export interface IdleState {
  /** Waktu aktivitas terakhir (ms, searah `now`). */
  lastActivityAt: number;
  /** true = hitungan ditahan (mis. sesi foto sedang berjalan). */
  suspended: boolean;
}

export type IdlePhase = "active" | "warning" | "expired";

export interface IdleStatus {
  phase: IdlePhase;
  /** Sisa waktu sampai reset (ms). Saat `suspended` = timeout penuh. */
  remainingMs: number;
  /** Sisa waktu sampai peringatan muncul (ms, 0 kalau sudah di fase warning). */
  warningInMs: number;
  /** true hanya pada frame pertama fase expired — berguna untuk aksi sekali. */
  expired: boolean;
}

export const IDLE_DEFAULT_CONFIG: IdleConfig = { timeoutMs: 90_000, warningMs: 15_000 };

/** Batas bawah yang masuk akal untuk kiosk; di bawah ini operator tak sempat berpose. */
export const IDLE_MIN_TIMEOUT_MS = 15_000;
export const IDLE_MAX_TIMEOUT_MS = 10 * 60_000;

export function normalizeIdleConfig(config: Partial<IdleConfig> = {}): IdleConfig {
  const timeoutMs = clamp(
    Math.round(config.timeoutMs ?? IDLE_DEFAULT_CONFIG.timeoutMs),
    IDLE_MIN_TIMEOUT_MS,
    IDLE_MAX_TIMEOUT_MS,
  );

  // Peringatan tidak boleh lebih panjang dari batasnya sendiri.
  const warningMs = clamp(
    Math.round(config.warningMs ?? IDLE_DEFAULT_CONFIG.warningMs),
    0,
    timeoutMs,
  );

  return { timeoutMs, warningMs };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

export function initialIdleState(now: number): IdleState {
  return { lastActivityAt: now, suspended: false };
}

/** Aktivitas operator: mulai ulang hitungan, termasuk saat sedang ditahan. */
export function noteActivity(state: IdleState, now: number): IdleState {
  if (state.lastActivityAt === now && !state.suspended) return state;
  return { lastActivityAt: now, suspended: false };
}

/** Tahan hitungan (sesi foto berjalan). Waktu aktivitas digeser supaya tidak
 *  langsung expired begitu sesi selesai. */
export function suspendIdle(state: IdleState, now: number): IdleState {
  if (state.suspended) return state;
  return { lastActivityAt: now, suspended: true };
}

export function resumeIdle(state: IdleState, now: number): IdleState {
  if (!state.suspended) return state;
  return { lastActivityAt: now, suspended: false };
}

/**
 * Status pada waktu `now`. `previous` dipakai untuk menandai tepi `expired`,
 * sehingga aksi reset hanya dijalankan sekali per siklus.
 */
export function idleStatus(
  config: IdleConfig,
  state: IdleState,
  now: number,
  previous?: IdleStatus | null,
): IdleStatus {
  if (state.suspended) {
    return {
      phase: "active",
      remainingMs: config.timeoutMs,
      warningInMs: config.timeoutMs - config.warningMs,
      expired: false,
    };
  }

  const elapsed = Math.max(0, now - state.lastActivityAt);
  const remainingMs = Math.max(0, config.timeoutMs - elapsed);
  const warningInMs = Math.max(0, remainingMs - config.warningMs);

  if (remainingMs <= 0) {
    return {
      phase: "expired",
      remainingMs: 0,
      warningInMs: 0,
      expired: previous?.phase !== "expired",
    };
  }

  return {
    phase: remainingMs <= config.warningMs ? "warning" : "active",
    remainingMs,
    warningInMs,
    expired: false,
  };
}

/** Detik sisa untuk ditampilkan (dibulatkan ke atas, minimal 1 saat belum expired). */
export function idleSecondsRemaining(status: IdleStatus): number {
  if (status.remainingMs <= 0) return 0;
  return Math.ceil(status.remainingMs / 1000);
}
