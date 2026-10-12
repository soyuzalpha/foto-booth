/**
 * Penyimpanan record PIN kiosk (Fase 4).
 *
 * Storage dipisah dari kripto-nya supaya tes bisa memakai storage palsu, dan
 * supaya satu tempat jelas memegang key-nya. Yang ditulis ke storage adalah
 * **record hash**, bukan PIN.
 */

import { isPinRecord, type PinRecord } from "./pin.ts";

export const PIN_STORAGE_KEY = "foto-booth:kiosk-pin";

export interface PinStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Storage in-memory untuk tes & lingkungan yang memblokir localStorage. */
export function createMemoryStorage(): PinStorageLike {
  const map = new Map<string, string>();

  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function resolveStorage(storage?: PinStorageLike): PinStorageLike | null {
  if (storage !== undefined) return storage;
  if (typeof localStorage === "undefined") return null;

  try {
    // Sentuh sekali: mode privat / iframe terkunci melempar saat diakses.
    localStorage.getItem(PIN_STORAGE_KEY);
    return localStorage;
  } catch {
    return null;
  }
}

export function loadPinRecord(storage?: PinStorageLike): PinRecord | null {
  const target = resolveStorage(storage);
  if (target === null) return null;

  try {
    const raw = target.getItem(PIN_STORAGE_KEY);
    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);
    return isPinRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function savePinRecord(record: PinRecord, storage?: PinStorageLike): boolean {
  const target = resolveStorage(storage);
  if (target === null) return false;

  try {
    target.setItem(PIN_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function clearPinRecord(storage?: PinStorageLike): void {
  const target = resolveStorage(storage);
  if (target === null) return;

  try {
    target.removeItem(PIN_STORAGE_KEY);
  } catch {
    // Diabaikan: menghapus PIN yang tidak bisa diakses bukan kegagalan fatal.
  }
}

export function hasPin(storage?: PinStorageLike): boolean {
  return loadPinRecord(storage) !== null;
}
