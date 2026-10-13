/**
 * Lapisan data: SQLite lewat `node:sqlite` bawaan Node 24.
 *
 * Kenapa bukan Prisma/Postgres: aplikasi ini jalan di satu rumah, satu
 * proses, satu disk. Yang dibutuhkan cuma "simpan baris, baca baris". SQLite
 * sudah ada di Node sejak v22, jadi **nol dependensi baru** — penting karena
 * ini proyek yang harus bisa dipasang orang lain tanpa drama.
 *
 * Aturan yang dijaga di sini:
 *
 *   · **Migrasi berurutan & tercatat.** `schema_migrations` menyimpan nomor
 *     yang sudah dijalankan; satu migrasi dijalankan tepat sekali. Menambah
 *     kolom = menambah entri di `MIGRATIONS`, bukan mengedit yang lama.
 *   · **WAL.** Kiosk menulis foto sementara halaman tamu membaca; tanpa WAL
 *     pembaca memblokir penulis dan sebaliknya.
 *   · **Foreign key ON.** SQLite mematikannya secara default; tanpa ini
 *     `photos` bisa menunjuk galeri yang sudah dihapus.
 *   · **Waktu sebagai ISO TEXT.** Sama seperti Zod schema, jadi tidak ada
 *     konversi epoch↔ISO yang gampang salah di perbandingan tanggal.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Satu langkah skema. `id` naik monoton; jangan pernah mengubah yang lama. */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "init",
    sql: `
      CREATE TABLE events (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        date        TEXT NOT NULL,
        hashtag     TEXT,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE galleries (
        id                 TEXT PRIMARY KEY,
        event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        hash               TEXT NOT NULL UNIQUE,
        password_hash      TEXT,
        password_salt      TEXT,
        expires_at         TEXT NOT NULL,
        created_at         TEXT NOT NULL
      );
      CREATE INDEX idx_galleries_event   ON galleries(event_id);
      CREATE INDEX idx_galleries_expires ON galleries(expires_at);

      CREATE TABLE photos (
        id          TEXT PRIMARY KEY,
        gallery_id  TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
        key         TEXT NOT NULL,
        thumb_key   TEXT NOT NULL,
        width       INTEGER NOT NULL,
        height      INTEGER NOT NULL,
        bytes       INTEGER NOT NULL,
        filename    TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_photos_gallery ON photos(gallery_id);
      CREATE INDEX idx_photos_created ON photos(created_at);

      CREATE TABLE otp_codes (
        email       TEXT PRIMARY KEY,
        code_hash   TEXT NOT NULL,
        salt        TEXT NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        expires_at  TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE entitlements (
        id                    TEXT PRIMARY KEY,
        email                 TEXT NOT NULL UNIQUE,
        plan                  TEXT NOT NULL,
        status                TEXT NOT NULL,
        max_active_galleries  INTEGER,
        issued_at             TEXT NOT NULL,
        expires_at            TEXT
      );
    `,
  },
];

/** Handle minimal yang dipakai seluruh kode — memudahkan tes pakai `:memory:`. */
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

/** Subset `node:sqlite` yang kita pakai. Sengaja sempit supaya bisa di-fake. */
export interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/**
 * Buka database dan jalankan migrasi yang belum dijalankan.
 *
 * `:memory:` didukung (dan dipakai tes) — di situ `mkdirSync` dilewati karena
 * tidak ada berkas.
 */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  // WAL: penulis tidak memblokir pembaca. Di `:memory:` tidak berlaku.
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare("SELECT id FROM schema_migrations").all().map((row) => Number(row.id)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    // Satu transaksi per migrasi: gagal di tengah → tidak ada skema separuh.
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return db as unknown as Db;
}

/** Nama berkas database di dalam `DATA_DIR`. */
export const DB_FILENAME = "foto-booth.sqlite";
