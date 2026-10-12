/**
 * Nilai token teks saat compose.
 *
 * Token-nya sendiri (`{event}` `{date}` `{time}` `{custom}`) didefinisikan di
 * `@foto-booth/shared`; di sini yang diurus cuma **dari mana nilainya datang**
 * dan bagaimana diformat. Jam selalu disuntikkan (`now`) supaya bisa diuji
 * tanpa menunggu waktu nyata.
 */

import { substituteTokens, type TokenValues } from "@foto-booth/shared";

export interface TokenContext {
  eventName?: string;
  custom?: string;
  now?: Date;
  /** Locale buat format tanggal, mis. `id-ID`. */
  locale?: string;
}

const DEFAULT_LOCALE = "id-ID";

function formatDate(now: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(now);
  } catch {
    // Locale tidak dikenal di runtime ini — jangan gagalkan compose.
    return now.toISOString().slice(0, 10);
  }
}

function formatTime(now: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(now);
  } catch {
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }
}

export function resolveTokenValues(context: TokenContext = {}): TokenValues {
  const now = context.now ?? new Date();
  const locale = context.locale ?? DEFAULT_LOCALE;

  return {
    event: context.eventName ?? "",
    date: formatDate(now, locale),
    time: formatTime(now, locale),
    custom: context.custom ?? "",
  };
}

/** Nilai contoh buat pratinjau di editor, supaya token tidak terlihat kosong. */
export function previewTokenValues(now: Date = new Date()): TokenValues {
  return resolveTokenValues({ eventName: "Pesta Ulang Tahun", custom: "contoh", now });
}

/** Ganti token di teks dengan nilai dari konteks. */
export function renderText(text: string, context: TokenContext = {}): string {
  return substituteTokens(text, resolveTokenValues(context));
}
