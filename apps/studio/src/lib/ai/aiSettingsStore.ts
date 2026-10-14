/**
 * Pengaturan AI (Fase 8) — kunci BYOK & pilihan gaya, murni.
 *
 * **Kenapa kunci disimpan di perangkat operator, bukan di server.** Fase 8 itu
 * BYOK: yang punya kunci Gemini adalah operator, dan server rumah hanya jadi
 * perantara supaya kunci tidak perlu ikut ke permintaan lintas-origin dari
 * halaman studio. Kalau kunci disimpan di server, satu kebocoran backup berarti
 * kunci orang lain ikut bocor — dan tidak ada alasan untuk menanggung itu.
 *
 * **Kenapa `localStorage` cukup.** Kiosk ini satu perangkat, satu operator.
 * Yang perlu bertahan antar-buka hanyalah: kunci, tugas terakhir, dan gaya
 * terakhir. Tidak ada yang perlu disinkronkan ke mana pun.
 *
 * **Yang dijaga fungsi di sini:**
 *   · Kunci tidak pernah masuk ke nilai balik yang bisa ter-log. `readAiSettings`
 *     mengembalikan kunci apa adanya (memang perlu untuk dipakai), tapi
 *     `maskAiKey` disediakan untuk tampilan, dan tidak ada fungsi di sini yang
 *     menulis kunci ke `console`.
 *   · Data rusak tidak menjatuhkan aplikasi. localStorage bisa berisi JSON versi
 *     lama; setiap field divalidasi lalu dijatuhkan ke default.
 *   · Gaya/tugas yang tidak dikenal dari penyimpanan lama jatuh ke default,
 *     bukan diteruskan ke API (yang akan menolaknya dengan 400).
 */

import {
  AI_STYLE_IDS,
  AI_TASK_IDS,
  normalizeAiKey,
  normalizeCustomPrompt,
  type AiStyleId,
  type AiTaskId,
} from "@foto-booth/shared";

import type { KeyValueStore } from "../capture/rememberedDevice.ts";

/** Kunci penyimpanan; diekspor supaya tes & panel debug menyebut hal yang sama. */
export const AI_SETTINGS_KEY = "foto-booth:ai";

export interface AiSettings {
  /** Kunci Gemini milik operator. String kosong = belum diisi. */
  key: string;
  /** Apakah efek AI dijalankan pada setiap sesi. Default `false`. */
  enabled: boolean;
  /** Tugas terakhir yang dipilih operator. */
  task: AiTaskId;
  /** Gaya terakhir yang dipilih operator. */
  style: AiStyleId;
  /** Instruksi tambahan terakhir (sudah dipangkas). */
  custom: string;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  key: "",
  enabled: false,
  task: "style",
  style: "anime",
  custom: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Rapikan objek apa pun menjadi `AiSettings` yang sah.
 *
 * Kunci yang tidak masuk akal **dikosongkan**, bukan dipakai: lebih baik UI
 * bilang "kunci belum diisi" daripada mengirim kunci terpotong ke server dan
 * mendapat 401 yang membingungkan.
 */
export function normalizeAiSettings(input: unknown): AiSettings {
  if (!isRecord(input)) return { ...DEFAULT_AI_SETTINGS };
  return {
    key: normalizeAiKey(input.key) ?? "",
    enabled: input.enabled === true,
    task: pick(input.task, AI_TASK_IDS, DEFAULT_AI_SETTINGS.task),
    style: pick(input.style, AI_STYLE_IDS, DEFAULT_AI_SETTINGS.style),
    custom: normalizeCustomPrompt(input.custom),
  };
}

/** Baca pengaturan tersimpan; default kalau tidak ada / rusak. */
export function readAiSettings(store: KeyValueStore | null): AiSettings {
  if (store === null) return { ...DEFAULT_AI_SETTINGS };
  try {
    const raw = store.getItem(AI_SETTINGS_KEY);
    if (raw === null) return { ...DEFAULT_AI_SETTINGS };
    return normalizeAiSettings(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

/** Simpan pengaturan; kegagalan penyimpanan tidak boleh menghentikan alur. */
export function writeAiSettings(store: KeyValueStore | null, settings: AiSettings): void {
  if (store === null) return;
  try {
    store.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Penyimpanan penuh / diblokir: pengaturan tetap berlaku di sesi ini.
  }
}

/**
 * Bentuk kunci untuk ditampilkan: cukup untuk dikenali, tidak cukup untuk
 * dipakai. Kunci pendek tidak pernah menampilkan ekornya.
 */
export function maskAiKey(key: string): string {
  if (key === "") return "";
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 6)}${"•".repeat(8)}${key.slice(-4)}`;
}

/** Apakah pengaturan ini sudah bisa dipakai memanggil AI. */
export function isAiConfigured(settings: AiSettings): boolean {
  return normalizeAiKey(settings.key) !== null;
}
