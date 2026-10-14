/**
 * Bagikan album dari studio (Fase 9, FEATURE-MATRIX #56–#59).
 *
 * Logika kanal & tautan ada di `@foto-booth/shared/sharing.ts` — modul itu yang
 * diuji dan dipakai halaman share publik, jadi kartu yang dibuka tamu dan yang
 * dibagikan operator tidak bisa berbeda. Berkas ini hanya menjembatani ke
 * browser: menyusun target, lalu benar-benar membagikan/menyalin.
 *
 * Kenapa ada berkas terpisah, bukan panggil `navigator.share` langsung di panel:
 *
 *   · **Jalur "tanpa Web Share API" bukan kasus langka.** Desktop Firefox dan
 *     sebagian browser dalam-app tidak punya `navigator.share`; kalau tombol
 *     mengandalkan itu saja, tombolnya mati tanpa penjelasan.
 *   · **Clipboard bisa ditolak.** Di halaman non-secure atau tanpa izin,
 *     `writeText` melempar. Perlu jatuh ke `prompt`, dan itu keputusan yang
 *     lebih baik diuji daripada ditemukan saat acara berlangsung.
 */

import {
  SHARE_CHANNELS,
  resolvedHeading,
  resolvedSubheading,
  shareLink,
  sharePageTitle,
  shareText,
  type Branding,
  type ShareChannel,
  type ShareTarget,
} from "@foto-booth/shared";

/** Data acara yang minimal untuk menyusun target share. */
export interface ShareEventInfo {
  name: string;
  date: string;
  hashtag: string | null;
}

export interface ShareContext {
  branding: Branding;
  event: ShareEventInfo | null;
  /** URL absolut halaman galeri tamu. */
  galleryUrl: string;
}

/** Satu kanal siap tampil: label, dan tautannya kalau kanal itu punya URL. */
export interface ShareOption {
  channel: ShareChannel;
  label: string;
  href: string | null;
}

const CHANNEL_LABELS: Record<ShareChannel, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  sms: "SMS",
  native: "Bagikan…",
  copy: "Salin tautan",
};

/** Target share dari konteks acara — judul memakai fungsi yang sama dengan halaman publik. */
export function shareTargetOf(context: ShareContext): ShareTarget {
  const heading = resolvedHeading(context.branding, context.event?.name ?? null);
  return {
    url: context.galleryUrl,
    title: sharePageTitle(heading, context.event?.name ?? null),
  };
}

/** Deskripsi yang tampil di kartu share / pesan. */
export function shareDescriptionOf(context: ShareContext): string {
  const subheading = resolvedSubheading(context.branding, context.event);
  return subheading === "" ? "Ambil & bagikan fotonya." : subheading;
}

/** Semua kanal, urut seperti `SHARE_CHANNELS`. */
export function shareOptionsOf(context: ShareContext): ShareOption[] {
  const target = shareTargetOf(context);
  return SHARE_CHANNELS.map((channel) => ({
    channel,
    label: CHANNEL_LABELS[channel],
    href: shareLink(channel, target),
  }));
}

export interface ShareHandlers {
  /** Web Share API; `false` kalau browser tidak punya atau tamu membatalkan. */
  native?: (target: ShareTarget) => Promise<boolean>;
  /** Buka tautan kanal di tab baru. */
  open?: (href: string) => void;
  /** Salin ke clipboard; `false` kalau ditolak. */
  copy?: (text: string) => Promise<boolean>;
  /** Cadangan terakhir saat clipboard ditolak. */
  prompt?: (text: string) => void;
}

export interface ShareOutcome {
  channel: ShareChannel;
  /** `shared` = Web Share berhasil; `opened` = tab dibuka; `copied` = tersalin; `manual` = prompt. */
  result: "shared" | "opened" | "copied" | "manual";
}

/**
 * Jalankan satu kanal.
 *
 * Kanal yang punya URL (`whatsapp`/`email`/`sms`) selalu dibuka di tab baru —
 * itu yang diharapkan operator. `native` mencoba Web Share lebih dulu dan
 * jatuh ke clipboard kalau tidak tersedia; `copy` langsung ke clipboard. Dua
 * kanal terakhir jatuh ke `prompt` kalau clipboard menolak, supaya tautannya
 * tidak pernah hilang tanpa jejak.
 */
export async function runShare(
  channel: ShareChannel,
  context: ShareContext,
  handlers: ShareHandlers = {},
): Promise<ShareOutcome> {
  const target = shareTargetOf(context);
  const href = shareLink(channel, target);

  if (href !== null) {
    (handlers.open ?? ((url: string) => window.open(url, "_blank", "noopener,noreferrer")))(href);
    return { channel, result: "opened" };
  }

  const copy = handlers.copy ?? defaultCopy;
  const prompt = handlers.prompt ?? ((text: string) => window.prompt("Salin tautan ini", text));

  if (channel === "native") {
    const native =
      handlers.native ??
      (async (t: ShareTarget) => {
        if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
        try {
          await navigator.share({ title: t.title, text: shareText(t), url: t.url });
          return true;
        } catch {
          // Tamu membatalkan dialog — bukan kegagalan yang perlu ditampilkan.
          return false;
        }
      });

    if (await native(target)) return { channel, result: "shared" };
  }

  if (await copy(target.url)) return { channel, result: "copied" };
  prompt(target.url);
  return { channel, result: "manual" };
}

async function defaultCopy(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
