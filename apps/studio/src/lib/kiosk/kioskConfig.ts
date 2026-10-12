/**
 * Pengaturan kiosk yang bertahan antar-restart (Fase 4).
 *
 * Hanya **preferensi**, bukan rahasia: PIN hidup di `pinStore.ts` sebagai hash.
 */

import { IDLE_DEFAULT_CONFIG, normalizeIdleConfig, type IdleConfig } from "./idle.ts";

export const KIOSK_CONFIG_KEY = "foto-booth:kiosk";

/** Tombol tamu yang boleh tampil di layar hasil. UI lengkapnya di Fase 9. */
export interface KioskButtons {
  gallery: boolean;
  print: boolean;
  share: boolean;
}

export interface KioskConfig {
  /** Kiosk dijalankan penuh-layar dengan reset idle & layar tarik. */
  enabled: boolean;
  idle: IdleConfig;
  /** Minta PIN sebelum keluar dari kiosk. Aktif hanya kalau PIN sudah diatur. */
  requirePinOnExit: boolean;
  /** Blokir menu konteks, zoom, dan swipe-back. */
  blockGestures: boolean;
  /** Layar "sentuh untuk mulai" sebelum tamu boleh memakai kamera. */
  tapToStart: boolean;
  buttons: KioskButtons;
}

export const KIOSK_DEFAULT_CONFIG: KioskConfig = {
  enabled: false,
  idle: IDLE_DEFAULT_CONFIG,
  requirePinOnExit: true,
  blockGestures: true,
  tapToStart: true,
  buttons: { gallery: false, print: true, share: false },
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: StorageLike): StorageLike | null {
  if (storage !== undefined) return storage;
  if (typeof localStorage === "undefined") return null;

  try {
    localStorage.getItem(KIOSK_CONFIG_KEY);
    return localStorage;
  } catch {
    return null;
  }
}

/** Hanya `true` boolean yang menyalakan sebuah flag; sisanya jatuh ke default. */
function flag(value: unknown, fallback: boolean): boolean {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
}

export function parseKioskConfig(raw: string | null): KioskConfig {
  if (raw === null) return KIOSK_DEFAULT_CONFIG;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return KIOSK_DEFAULT_CONFIG;

    const record = parsed as Record<string, unknown>;
    const idleRaw =
      typeof record.idle === "object" && record.idle !== null
        ? (record.idle as Record<string, unknown>)
        : {};
    const buttonsRaw =
      typeof record.buttons === "object" && record.buttons !== null
        ? (record.buttons as Record<string, unknown>)
        : {};

    return {
      enabled: record.enabled === true,
      idle: normalizeIdleConfig({
        timeoutMs: typeof idleRaw.timeoutMs === "number" ? idleRaw.timeoutMs : undefined,
        warningMs: typeof idleRaw.warningMs === "number" ? idleRaw.warningMs : undefined,
      }),
      requirePinOnExit: flag(record.requirePinOnExit, KIOSK_DEFAULT_CONFIG.requirePinOnExit),
      blockGestures: flag(record.blockGestures, KIOSK_DEFAULT_CONFIG.blockGestures),
      tapToStart: flag(record.tapToStart, KIOSK_DEFAULT_CONFIG.tapToStart),
      buttons: {
        gallery: flag(buttonsRaw.gallery, KIOSK_DEFAULT_CONFIG.buttons.gallery),
        print: flag(buttonsRaw.print, KIOSK_DEFAULT_CONFIG.buttons.print),
        share: flag(buttonsRaw.share, KIOSK_DEFAULT_CONFIG.buttons.share),
      },
    };
  } catch {
    return KIOSK_DEFAULT_CONFIG;
  }
}

export function loadKioskConfig(storage?: StorageLike): KioskConfig {
  const target = resolveStorage(storage);
  if (target === null) return KIOSK_DEFAULT_CONFIG;

  try {
    return parseKioskConfig(target.getItem(KIOSK_CONFIG_KEY));
  } catch {
    return KIOSK_DEFAULT_CONFIG;
  }
}

export function saveKioskConfig(config: KioskConfig, storage?: StorageLike): boolean {
  const target = resolveStorage(storage);
  if (target === null) return false;

  try {
    target.setItem(KIOSK_CONFIG_KEY, JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}
