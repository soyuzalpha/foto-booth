/**
 * Video guestbook (Fase 9, FEATURE-MATRIX #19).
 *
 * Tamu meninggalkan pesan video pendek untuk pemilik acara — bukan foto
 * hasil sesi, tapi ucapan. Yang membuat fitur ini berbeda dari galeri biasa:
 *
 *   · **Pesannya pribadi, jadi harus bisa disembunyikan.** Seorang tamu bisa
 *     mengirim video yang tidak pantas untuk dilihat semua orang; operator
 *     perlu tombol "sembunyikan" yang bekerja tanpa menghapus berkasnya.
 *   · **Batas durasi ada di klien dan di server.** Klien menahannya supaya
 *     tamu tidak merekam 10 menit; server memeriksanya karena klien bisa
 *     dimatikan. Dua-duanya memakai angka yang sama dari sini.
 *   · **Tidak ada data pribadi di nama berkas.** Nama tamu opsional dan hanya
 *     disimpan sebagai label; `key` objek dibangun dari id, bukan nama.
 *
 * Modul ini murni (tanpa DOM, tanpa Node) supaya dipakai studio (perekam),
 * API (validasi + simpan), dan halaman tamu sekaligus.
 */


export const GUESTBOOK_ENTRY_KINDS = ["video", "audio"] as const;
export type GuestbookEntryKind = (typeof GUESTBOOK_ENTRY_KINDS)[number];

export function isGuestbookEntryKind(value: string): value is GuestbookEntryKind {
  return (GUESTBOOK_ENTRY_KINDS as readonly string[]).includes(value);
}

/** Batas durasi satu pesan (detik). Cukup untuk ucapan, bukan monolog. */
export const GUESTBOOK_MAX_SECONDS = 30;

/** Batas ukuran berkas (byte) — 1080p/30 dtk ≈ 60 MB, jadi 128 MB lega. */
export const GUESTBOOK_MAX_BYTES = 128 * 1024 * 1024;

/** Batas panjang label/nama tamu. */
export const GUESTBOOK_LABEL_MAX = 80;

/** Batas jumlah entri yang ditampilkan sekaligus di dinding guestbook. */
export const GUESTBOOK_PAGE_SIZE = 24;

/** Content type yang diterima guestbook: video & audio yang dikenal bucket. */
export const GUESTBOOK_CONTENT_TYPES: readonly string[] = ["video/mp4", "video/webm", "audio/webm"];

export interface GuestbookEntry {
  id: string;
  eventId: string;
  /** `null` kalau pesan direkam langsung di kiosk, bukan lewat galeri. */
  galleryId: string | null;
  kind: GuestbookEntryKind;
  contentType: string;
  /** Kunci objek di bucket. Dibangun dari id, bukan dari label. */
  key: string;
  durationSeconds: number;
  bytes: number;
  /** Nama tamu, opsional. Kosong = "Tamu". */
  label: string;
  /** `false` = disembunyikan operator; berkas tetap ada. */
  visible: boolean;
  createdAt: string;
}

export interface GuestbookDraft {
  kind: GuestbookEntryKind;
  contentType: string;
  durationSeconds: number;
  bytes: number;
  label?: string;
  /**
   * Persetujuan UU PDP. Harus `true` — bukan sekadar ada.
   *
   * Ini bukan kolom yang disimpan (yang disimpan hanya entri yang sudah lolos),
   * melainkan syarat masuk: tanpa persetujuan eksplisit, berkas tamu tidak
   * boleh mendarat di bucket sama sekali.
   */
  consent?: boolean;
}

/** Hasil validasi: nilai bersih atau alasan penolakan yang bisa ditampilkan. */
export type GuestbookVerdict =
  | { ok: true; value: Required<GuestbookDraft> }
  | { ok: false; reason: string };

/** Rapikan label: buang karakter kontrol, batasi panjang, kosong → "Tamu". */
export function normalizeGuestbookLabel(raw: unknown): string {
  if (typeof raw !== "string") return "Tamu";
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, GUESTBOOK_LABEL_MAX);
  return cleaned === "" ? "Tamu" : cleaned;
}

/**
 * Validasi satu kiriman guestbook.
 *
 * Urutan pemeriksaan penting untuk pesan yang dilihat tamu: tipe dulu (salah
 * jenis berkas = kesalahan sistem, bukan kesalahan tamu), baru durasi dan
 * ukuran (itu yang bisa tamu perbaiki dengan merekam ulang).
 */
export function validateGuestbookDraft(draft: unknown): GuestbookVerdict {
  if (draft === null || typeof draft !== "object") {
    return { ok: false, reason: "kiriman tidak dikenali" };
  }
  const raw = draft as Record<string, unknown>;

  if (typeof raw.kind !== "string" || !isGuestbookEntryKind(raw.kind)) {
    return { ok: false, reason: "jenis pesan tidak dikenal" };
  }
  if (typeof raw.contentType !== "string" || !GUESTBOOK_CONTENT_TYPES.includes(raw.contentType)) {
    return { ok: false, reason: "format berkas tidak didukung" };
  }

  const duration = Number(raw.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, reason: "durasi tidak terbaca" };
  }
  // Pembulatan ke atas: rekaman 30,4 detik dari timer browser tetap diterima
  // dan disimpan sebagai 31 — memotong ke bawah berarti berkas lebih panjang
  // dari yang tertulis di metadata.
  const seconds = Math.ceil(duration);
  if (seconds > GUESTBOOK_MAX_SECONDS) {
    return { ok: false, reason: `maksimal ${GUESTBOOK_MAX_SECONDS} detik` };
  }

  const bytes = Number(raw.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, reason: "berkas kosong" };
  }
  if (bytes > GUESTBOOK_MAX_BYTES) {
    return { ok: false, reason: "berkas terlalu besar" };
  }

  // Persetujuan diperiksa **terakhir**: tamu yang salah memilih berkas harus
  // diberi tahu soal berkasnya dulu, bukan soal centang. Dan yang menentukan
  // adalah `true`, bukan "ada" — `consent: false` tetap berarti tidak setuju.
  if (raw.consent !== true) {
    return { ok: false, reason: "persetujuan UU PDP belum dicentang" };
  }

  return {
    ok: true,
    value: {
      kind: raw.kind,
      contentType: raw.contentType,
      durationSeconds: seconds,
      bytes,
      label: normalizeGuestbookLabel(raw.label),
      consent: true,
    },
  };
}

/**
 * Kunci objek untuk satu entri.
 *
 * `id` yang dipakai, bukan label: dua tamu bernama "Budi" harus punya dua
 * berkas, dan nama yang mengandung `/` atau `..` tidak boleh bisa keluar dari
 * prefiks acara.
 */
export function guestbookKey(eventId: string, id: string, contentType: string): string {
  const ext = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "bin";
  return `events/${eventId}/guestbook/${id}.${ext === "" ? "bin" : ext}`;
}

/** Entri yang boleh dilihat tamu: `visible` saja, terbaru dulu. */
export function visibleEntries(entries: readonly GuestbookEntry[]): GuestbookEntry[] {
  return entries
    .filter((entry) => entry.visible)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Total durasi semua entri terlihat (detik) — untuk ringkasan operator. */
export function totalDurationSeconds(entries: readonly GuestbookEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.durationSeconds, 0);
}

/** Format durasi `m:ss` untuk ditampilkan di kartu. */
export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
