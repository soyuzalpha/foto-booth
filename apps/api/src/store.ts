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
  Booking,
  BookingPackage,
  BookingSettings,
  BookingStatus,
  DepositStatus,
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

/**
 * Geser tanggal sebuah event.
 *
 * Dipakai saat booking yang sudah disetujui di-reschedule: event di studio harus
 * ikut pindah hari, kalau tidak operator akan mencari klien di tanggal lama.
 * Sengaja hanya `date` — nama/hashtag yang sudah disunting operator tidak boleh
 * ditimpa.
 */
export function updateEventDate(db: Db, id: string, date: string): Event | null {
  const result = db.prepare("UPDATE events SET date = ? WHERE id = ?").run(date, id);
  return result.changes === 0 ? null : getEvent(db, id);
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

/* ------------------------------------------------------------------ *
 * Booking — paket (Fase 11)
 * ------------------------------------------------------------------ */

function bool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function toBookingPackage(raw: Record<string, unknown>): BookingPackage {
  const pkg: BookingPackage = {
    id: str(raw.id),
    name: str(raw.name),
    durationMinutes: num(raw.duration_minutes),
    priceIdr: num(raw.price_idr),
    depositIdr: num(raw.deposit_idr),
    active: bool(raw.active),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
  const description = raw.description;
  if (typeof description === "string" && description !== "") pkg.description = description;
  return pkg;
}

export interface BookingPackageRow {
  name: string;
  description?: string | undefined;
  durationMinutes: number;
  priceIdr: number;
  depositIdr: number;
  active: boolean;
}

export function insertBookingPackage(
  db: Db,
  id: string,
  row: BookingPackageRow,
  now: string,
): BookingPackage {
  db.prepare(
    `INSERT INTO booking_packages
       (id, name, description, duration_minutes, price_idr, deposit_idr, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    row.name,
    row.description ?? null,
    row.durationMinutes,
    row.priceIdr,
    row.depositIdr,
    row.active ? 1 : 0,
    now,
    now,
  );
  return {
    id,
    name: row.name,
    ...(row.description === undefined ? {} : { description: row.description }),
    durationMinutes: row.durationMinutes,
    priceIdr: row.priceIdr,
    depositIdr: row.depositIdr,
    active: row.active,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Ubah paket. Hanya field yang dikirim yang ditulis.
 *
 * Paket sengaja **tidak** di-`DELETE`: booking lama menyimpan `package_id`, dan
 * menghapus paket akan memutus jejaknya. Operator menonaktifkan (`active=0`)
 * supaya paket berhenti ditawarkan tapi riwayat tetap terbaca.
 */
export function updateBookingPackage(
  db: Db,
  id: string,
  patch: Partial<BookingPackageRow>,
  now: string,
): BookingPackage | null {
  const current = getBookingPackage(db, id);
  if (current === null) return null;

  const next: BookingPackageRow = {
    name: patch.name ?? current.name,
    description: patch.description ?? current.description,
    durationMinutes: patch.durationMinutes ?? current.durationMinutes,
    priceIdr: patch.priceIdr ?? current.priceIdr,
    depositIdr: patch.depositIdr ?? current.depositIdr,
    active: patch.active ?? current.active,
  };

  db.prepare(
    `UPDATE booking_packages SET
       name = ?, description = ?, duration_minutes = ?, price_idr = ?, deposit_idr = ?, active = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.name,
    next.description ?? null,
    next.durationMinutes,
    next.priceIdr,
    next.depositIdr,
    next.active ? 1 : 0,
    now,
    id,
  );

  return getBookingPackage(db, id);
}

export function getBookingPackage(db: Db, id: string): BookingPackage | null {
  const raw = db.prepare("SELECT * FROM booking_packages WHERE id = ?").get(id);
  return raw === undefined ? null : toBookingPackage(raw);
}

/** Urut harga menaik — urutan yang sama dengan yang dilihat tamu di form. */
export function listBookingPackages(db: Db, activeOnly = false): BookingPackage[] {
  const sql = activeOnly
    ? "SELECT * FROM booking_packages WHERE active = 1 ORDER BY price_idr ASC, name ASC"
    : "SELECT * FROM booking_packages ORDER BY price_idr ASC, name ASC";
  return db.prepare(sql).all().map(toBookingPackage);
}

/* ------------------------------------------------------------------ *
 * Booking — reservasi (Fase 11)
 * ------------------------------------------------------------------ */

function toBooking(raw: Record<string, unknown>): Booking {
  const booking: Booking = {
    id: str(raw.id),
    token: str(raw.token),
    packageId: str(raw.package_id),
    packageName: str(raw.package_name),
    name: str(raw.name),
    email: str(raw.email),
    phone: str(raw.phone),
    start: str(raw.start),
    end: str(raw.end),
    durationMinutes: num(raw.duration_minutes),
    priceIdr: num(raw.price_idr),
    depositIdr: num(raw.deposit_idr),
    depositStatus: str(raw.deposit_status) as DepositStatus,
    status: str(raw.status) as BookingStatus,
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
  if (typeof raw.notes === "string" && raw.notes !== "") booking.notes = raw.notes;
  if (typeof raw.reason === "string" && raw.reason !== "") booking.reason = raw.reason;
  booking.eventId = typeof raw.event_id === "string" && raw.event_id !== "" ? raw.event_id : null;
  return booking;
}

export interface BookingRow {
  token: string;
  packageId: string;
  packageName: string;
  name: string;
  email: string;
  phone: string;
  start: string;
  end: string;
  durationMinutes: number;
  priceIdr: number;
  depositIdr: number;
  status: BookingStatus;
  notes?: string | undefined;
}

export function insertBooking(db: Db, id: string, row: BookingRow, now: string): Booking {
  db.prepare(
    `INSERT INTO bookings
       (id, token, package_id, package_name, name, email, phone, start, end,
        duration_minutes, price_idr, deposit_idr, deposit_status, status, notes, reason,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    row.token,
    row.packageId,
    row.packageName,
    row.name,
    row.email,
    row.phone,
    row.start,
    row.end,
    row.durationMinutes,
    row.priceIdr,
    row.depositIdr,
    row.status,
    row.notes ?? null,
    now,
    now,
  );
  return getBooking(db, id)!;
}

export function getBooking(db: Db, id: string): Booking | null {
  const raw = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
  return raw === undefined ? null : toBooking(raw);
}

/**
 * Cari lewat token publik. Token ada di URL halaman status, jadi harus unik dan
 * tidak menebak-nebak — bandingkan persis, bukan `LIKE`.
 */
export function getBookingByToken(db: Db, token: string): Booking | null {
  const raw = db.prepare("SELECT * FROM bookings WHERE token = ?").get(token);
  return raw === undefined ? null : toBooking(raw);
}

export interface BookingFilter {
  /** Batas bawah `start` (ISO, inklusif). */
  from?: string | undefined;
  /** Batas atas `start` (ISO, eksklusif). */
  to?: string | undefined;
  status?: BookingStatus | undefined;
  email?: string | undefined;
  limit?: number | undefined;
}

export function listBookings(db: Db, filter: BookingFilter = {}): Booking[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.from !== undefined) {
    where.push("start >= ?");
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    where.push("start < ?");
    params.push(filter.to);
  }
  if (filter.status !== undefined) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.email !== undefined) {
    where.push("email = ?");
    params.push(filter.email);
  }

  const sql = `SELECT * FROM bookings
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY start ASC
    LIMIT ?`;
  params.push(filter.limit ?? 500);

  return db
    .prepare(sql)
    .all(...params)
    .map(toBooking);
}

/**
 * Booking yang **mengunci** slot: `requested` dan `approved`.
 *
 * `requested` ikut dikunci walau belum disetujui. Kalau tidak, dua orang bisa
 * sama-sama meminta jam 14:00 dan operator baru tahu bentroknya saat menyetujui
 * yang kedua — tamu pertama sudah keburu diberi tahu "tersedia".
 */
export const SLOT_HOLDING_STATUSES: readonly BookingStatus[] = ["requested", "approved"];

export function listBookingsInRange(db: Db, from: string, to: string): Booking[] {
  return db
    .prepare(
      `SELECT * FROM bookings
       WHERE status IN ('requested', 'approved') AND start < ? AND end > ?
       ORDER BY start ASC`,
    )
    .all(to, from)
    .map(toBooking);
}

export interface BookingStatusPatch {
  status?: BookingStatus | undefined;
  reason?: string | null | undefined;
  depositStatus?: DepositStatus | undefined;
  start?: string | undefined;
  end?: string | undefined;
  durationMinutes?: number | undefined;
  eventId?: string | null | undefined;
}

export function updateBooking(db: Db, id: string, patch: BookingStatusPatch, now: string): Booking | null {
  const current = getBooking(db, id);
  if (current === null) return null;

  db.prepare(
    `UPDATE bookings SET
       status = ?, reason = ?, deposit_status = ?, start = ?, end = ?, duration_minutes = ?,
       event_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.status ?? current.status,
    patch.reason === undefined ? (current.reason ?? null) : patch.reason,
    patch.depositStatus ?? current.depositStatus,
    patch.start ?? current.start,
    patch.end ?? current.end,
    patch.durationMinutes ?? current.durationMinutes,
    patch.eventId === undefined ? (current.eventId ?? null) : patch.eventId,
    now,
    id,
  );

  return getBooking(db, id);
}

export function deleteBooking(db: Db, id: string): number {
  return Number(db.prepare("DELETE FROM bookings WHERE id = ?").run(id).changes);
}

export function countBookings(db: Db): number {
  return num(db.prepare("SELECT COUNT(*) AS n FROM bookings").get()?.n);
}

/* ------------------------------------------------------------------ *
 * Booking — setelan (Fase 11)
 * ------------------------------------------------------------------ */

/**
 * Setelan disimpan sebagai satu baris JSON, bukan kolom-kolom terpisah.
 *
 * Bentuknya (jam buka, tanggal tutup, buffer) adalah satu kesatuan yang selalu
 * dibaca dan ditulis utuh; memecahnya jadi belasan kolom hanya menambah
 * migrasi setiap kali ada field baru tanpa manfaat nyata di skala satu rumah.
 * Validasi tetap lewat Zod di route, jadi JSON rusak tidak pernah lolos masuk.
 */
export function getBookingSettings(db: Db): BookingSettings | null {
  const raw = db.prepare("SELECT json FROM booking_settings WHERE id = 1").get();
  if (raw === undefined) return null;
  try {
    return JSON.parse(str(raw.json)) as BookingSettings;
  } catch {
    return null;
  }
}

export function saveBookingSettings(db: Db, settings: BookingSettings, now: string): void {
  db.prepare(
    `INSERT INTO booking_settings (id, json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(settings), now);
}
