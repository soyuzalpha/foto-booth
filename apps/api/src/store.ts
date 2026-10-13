/**
 * Akses data ber-tipe di atas `db.ts`.
 *
 * Semua query SQL tinggal di sini — route tidak pernah menulis SQL sendiri.
 * Alasannya bukan kerapian: kolom `snake_case` ↔ field `camelCase` gampang
 * tertukar, dan bug seperti `password_hash` yang lupa dibaca bikin galeri
 * berpassword jadi galeri terbuka **tanpa error apa pun**.
 *
 * Semua fungsi menerima `Db` sebagai argumen pertama, bukan singleton modul,
 * supaya tes bisa memakai `:memory:` dan tidak ada state yang bocor antar-tes.
 */

import type {
  Entitlement,
  EntitlementPlan,
  Event,
  Gallery,
  Photo,
} from "@foto-booth/shared";

import type { Db } from "./db.ts";

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export interface EventRow {
  name: string;
  date: string;
  hashtag?: string | undefined;
}

export function insertEvent(db: Db, id: string, row: EventRow, createdAt: string): Event {
  db.prepare("INSERT INTO events (id, name, date, hashtag, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    row.name,
    row.date,
    row.hashtag ?? null,
    createdAt,
  );
  return { id, name: row.name, date: row.date, hashtag: row.hashtag, createdAt };
}

function toEvent(raw: Record<string, unknown>): Event {
  const event: Event = {
    id: str(raw.id),
    name: str(raw.name),
    date: str(raw.date),
    createdAt: str(raw.created_at),
  };
  const hashtag = raw.hashtag;
  if (typeof hashtag === "string" && hashtag !== "") event.hashtag = hashtag;
  return event;
}

export function getEvent(db: Db, id: string): Event | null {
  const raw = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  return raw === undefined ? null : toEvent(raw);
}

export function listEvents(db: Db): Event[] {
  return db.prepare("SELECT * FROM events ORDER BY created_at DESC").all().map(toEvent);
}

/* ------------------------------------------------------------------ *
 * Galleries
 * ------------------------------------------------------------------ */

export interface GalleryRow {
  eventId: string;
  hash: string;
  passwordHash: string | null;
  passwordSalt: string | null;
  expiresAt: string;
}

export function insertGallery(db: Db, id: string, row: GalleryRow, createdAt: string): Gallery {
  db.prepare(
    `INSERT INTO galleries (id, event_id, hash, password_hash, password_salt, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, row.eventId, row.hash, row.passwordHash, row.passwordSalt, row.expiresAt, createdAt);

  return {
    id,
    eventId: row.eventId,
    hash: row.hash,
    passwordProtected: row.passwordHash !== null,
    expiresAt: row.expiresAt,
    createdAt,
  };
}

function toGallery(raw: Record<string, unknown>): Gallery {
  return {
    id: str(raw.id),
    eventId: str(raw.event_id),
    hash: str(raw.hash),
    passwordProtected: raw.password_hash !== null && raw.password_hash !== undefined,
    expiresAt: str(raw.expires_at),
    createdAt: str(raw.created_at),
  };
}

export function getGallery(db: Db, id: string): Gallery | null {
  const raw = db.prepare("SELECT * FROM galleries WHERE id = ?").get(id);
  return raw === undefined ? null : toGallery(raw);
}

/** Cari lewat bagian URL publik. Ini jalur yang dipakai halaman tamu. */
export function getGalleryByHash(db: Db, hash: string): Gallery | null {
  const raw = db.prepare("SELECT * FROM galleries WHERE hash = ?").get(hash);
  return raw === undefined ? null : toGallery(raw);
}

/** Galeri terbaru lebih dulu — operator melihat yang baru dibuat di atas. */
export function listGalleries(db: Db): Gallery[] {
  return db.prepare("SELECT * FROM galleries ORDER BY created_at DESC").all().map(toGallery);
}

/** Salt + hash password galeri; `null` = galeri terbuka. */
export function getGalleryPassword(
  db: Db,
  id: string,
): { salt: string | null; hash: string | null } | null {
  const raw = db.prepare("SELECT password_hash, password_salt FROM galleries WHERE id = ?").get(id);
  if (raw === undefined) return null;
  return {
    salt: typeof raw.password_salt === "string" ? raw.password_salt : null,
    hash: typeof raw.password_hash === "string" ? raw.password_hash : null,
  };
}

export function deleteGallery(db: Db, id: string): number {
  const result = db.prepare("DELETE FROM galleries WHERE id = ?").run(id);
  return Number(result.changes);
}

/**
 * Galeri yang sudah lewat `expires_at`.
 *
 * `ORDER BY expires_at` supaya galeri yang paling lama kedaluwarsa dihapus
 * lebih dulu — kalau job keburu mati, yang paling basi tetap yang terbersihkan.
 */
export function listExpiredGalleries(db: Db, now: string, limit = 200): Gallery[] {
  return db
    .prepare("SELECT * FROM galleries WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?")
    .all(now, limit)
    .map(toGallery);
}

/** Umur galeri tersisa dalam hari — buat ditampilkan ke operator. */
export function countGalleries(db: Db): number {
  return num(db.prepare("SELECT COUNT(*) AS n FROM galleries").get()?.n);
}

/* ------------------------------------------------------------------ *
 * Photos
 * ------------------------------------------------------------------ */

export interface PhotoRow {
  galleryId: string;
  key: string;
  thumbKey: string;
  width: number;
  height: number;
  bytes: number;
  filename?: string | undefined;
}

/**
 * Simpan metadata foto. Idempoten lewat `INSERT OR REPLACE`: studio boleh
 * mengirim ulang `register` setelah jaringan putus di tengah, dan hasilnya
 * tetap satu baris, bukan dua.
 */
export function insertPhoto(db: Db, id: string, row: PhotoRow, createdAt: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO photos (id, gallery_id, key, thumb_key, width, height, bytes, filename, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    row.galleryId,
    row.key,
    row.thumbKey,
    row.width,
    row.height,
    row.bytes,
    row.filename ?? null,
    createdAt,
  );
}

export interface PhotoRecord extends Photo {
  key: string;
  thumbKey: string;
}

function toPhoto(raw: Record<string, unknown>): PhotoRecord {
  const id = str(raw.id);
  return {
    id,
    galleryId: str(raw.gallery_id),
    key: str(raw.key),
    thumbKey: str(raw.thumb_key),
    // `url`/`thumbUrl` diisi pemanggil — butuh hash galeri, yang tidak ada di
    // baris `photos`. Placeholder kosong lebih jujur daripada URL yang salah.
    url: "",
    thumbUrl: "",
    width: num(raw.width),
    height: num(raw.height),
    createdAt: str(raw.created_at),
  };
}

export function listPhotos(db: Db, galleryId: string): PhotoRecord[] {
  return db
    .prepare("SELECT * FROM photos WHERE gallery_id = ? ORDER BY created_at ASC")
    .all(galleryId)
    .map(toPhoto);
}

export function countPhotos(db: Db, galleryId: string): number {
  return num(db.prepare("SELECT COUNT(*) AS n FROM photos WHERE gallery_id = ?").get(galleryId)?.n);
}

export function getPhoto(db: Db, galleryId: string, photoId: string): PhotoRecord | null {
  const raw = db.prepare("SELECT * FROM photos WHERE gallery_id = ? AND id = ?").get(galleryId, photoId);
  return raw === undefined ? null : toPhoto(raw);
}

export function deletePhotos(db: Db, galleryId: string): number {
  return Number(db.prepare("DELETE FROM photos WHERE gallery_id = ?").run(galleryId).changes);
}

/* ------------------------------------------------------------------ *
 * OTP
 * ------------------------------------------------------------------ */

export interface OtpRow {
  email: string;
  codeHash: string;
  salt: string;
  expiresAt: string;
}

/**
 * Simpan kode OTP baru, menimpa yang lama.
 *
 * Satu kode aktif per email: kalau user menekan "kirim ulang", kode lama harus
 * mati. Menyimpan dua kode hidup sekaligus berarti permintaan ulang memperbesar
 * peluang tebakan.
 */
export function upsertOtp(db: Db, row: OtpRow, createdAt: string): void {
  db.prepare(
    `INSERT INTO otp_codes (email, code_hash, salt, attempts, expires_at, created_at)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       code_hash = excluded.code_hash,
       salt      = excluded.salt,
       attempts  = 0,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`,
  ).run(row.email, row.codeHash, row.salt, row.expiresAt, createdAt);
}

export function getOtp(
  db: Db,
  email: string,
): { codeHash: string; salt: string; attempts: number; expiresAt: string } | null {
  const raw = db.prepare("SELECT * FROM otp_codes WHERE email = ?").get(email);
  if (raw === undefined) return null;
  return {
    codeHash: str(raw.code_hash),
    salt: str(raw.salt),
    attempts: num(raw.attempts),
    expiresAt: str(raw.expires_at),
  };
}

export function bumpOtpAttempts(db: Db, email: string): number {
  db.prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ?").run(email);
  return num(db.prepare("SELECT attempts FROM otp_codes WHERE email = ?").get(email)?.attempts);
}

export function deleteOtp(db: Db, email: string): void {
  db.prepare("DELETE FROM otp_codes WHERE email = ?").run(email);
}

/** Buang OTP kedaluwarsa — dipanggil job harian, bukan tiap permintaan. */
export function deleteExpiredOtps(db: Db, now: string): number {
  return Number(db.prepare("DELETE FROM otp_codes WHERE expires_at <= ?").run(now).changes);
}

/* ------------------------------------------------------------------ *
 * Entitlements
 * ------------------------------------------------------------------ */

export interface EntitlementRow {
  email: string;
  plan: EntitlementPlan;
  status: Entitlement["status"];
  maxActiveGalleries: number | null;
  expiresAt: string | null;
}

export function upsertEntitlement(db: Db, id: string, row: EntitlementRow, issuedAt: string): Entitlement {
  db.prepare(
    `INSERT INTO entitlements (id, email, plan, status, max_active_galleries, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       plan = excluded.plan,
       status = excluded.status,
       max_active_galleries = excluded.max_active_galleries,
       expires_at = excluded.expires_at`,
  ).run(id, row.email, row.plan, row.status, row.maxActiveGalleries, issuedAt, row.expiresAt);

  return {
    id,
    email: row.email,
    plan: row.plan,
    status: row.status,
    maxActiveGalleries: row.maxActiveGalleries,
    issuedAt,
    expiresAt: row.expiresAt,
  };
}

export function getEntitlement(db: Db, email: string): Entitlement | null {
  const raw = db.prepare("SELECT * FROM entitlements WHERE email = ?").get(email);
  if (raw === undefined) return null;
  return {
    id: str(raw.id),
    email: str(raw.email),
    plan: str(raw.plan) as EntitlementPlan,
    status: str(raw.status) as Entitlement["status"],
    maxActiveGalleries:
      raw.max_active_galleries === null || raw.max_active_galleries === undefined
        ? null
        : num(raw.max_active_galleries),
    issuedAt: str(raw.issued_at),
    expiresAt: typeof raw.expires_at === "string" ? raw.expires_at : null,
  };
}

/**
 * Apakah lisensi ini boleh bikin galeri baru?
 *
 * Lisensi kedaluwarsa diperlakukan sebagai tidak aktif — bukan error, cuma
 * tidak boleh menambah galeri. Galeri yang sudah ada tetap bisa dibuka tamu;
 * mencabut akses tamu gara-gara lisensi operator habis bukan perilaku yang
 * diinginkan di tengah acara.
 */
export function entitlementAllowsNewGallery(
  entitlement: Entitlement | null,
  now: Date,
): { allowed: boolean; reason: string | null } {
  if (entitlement === null) return { allowed: true, reason: null };
  if (entitlement.status !== "active") {
    return { allowed: false, reason: `lisensi ${entitlement.status}` };
  }
  if (entitlement.expiresAt !== null && new Date(entitlement.expiresAt).getTime() <= now.getTime()) {
    return { allowed: false, reason: "lisensi kedaluwarsa" };
  }
  return { allowed: true, reason: null };
}
