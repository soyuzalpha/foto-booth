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
  {
    id: 2,
    name: "booking",
    sql: `
      CREATE TABLE booking_packages (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        description      TEXT,
        duration_minutes INTEGER NOT NULL,
        price_idr        INTEGER NOT NULL,
        deposit_idr      INTEGER NOT NULL DEFAULT 0,
        active           INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX idx_booking_packages_active ON booking_packages(active);

      CREATE TABLE bookings (
        id               TEXT PRIMARY KEY,
        token            TEXT NOT NULL UNIQUE,
        package_id       TEXT NOT NULL,
        package_name     TEXT NOT NULL,
        name             TEXT NOT NULL,
        email            TEXT NOT NULL,
        phone            TEXT NOT NULL,
        start            TEXT NOT NULL,
        end              TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        price_idr        INTEGER NOT NULL,
        deposit_idr      INTEGER NOT NULL DEFAULT 0,
        deposit_status   TEXT NOT NULL DEFAULT 'unpaid',
        status           TEXT NOT NULL,
        notes            TEXT,
        reason           TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX idx_bookings_start  ON bookings(start);
      CREATE INDEX idx_bookings_status ON bookings(status);
      CREATE INDEX idx_bookings_email  ON bookings(email);

      CREATE TABLE booking_settings (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        json       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 3,
    name: "booking-event-link",
    // Booking yang disetujui jadi event di studio, supaya hari-H tidak perlu
    // input ulang. Kolomnya nullable: booking lama (dan yang masih `requested`)
    // memang belum punya event. `ON DELETE SET NULL` karena menghapus event
    // tidak boleh menghapus riwayat booking.
    sql: `
      ALTER TABLE bookings ADD COLUMN event_id TEXT REFERENCES events(id) ON DELETE SET NULL;
    `,
  },
  {
    id: 4,
    name: "leads-analytics",
    // Fase 9. Tiga tabel, masing-masing dengan alasan yang berbeda:
    //
    //   · `lead_fields` — definisi field yang ditanyakan ke tamu. `key` unik
    //     per lingkup (`COALESCE(event_id,'')`), bukan per baris: dua field
    //     bernama sama akan menulis ke kolom CSV yang sama dan menimpa satu
    //     sama lain tanpa error.
    //   · `leads` — satu baris per tamu. `values_json` sengaja JSON, bukan
    //     kolom dinamis: field dibuat operator saat runtime, dan SQLite tidak
    //     bisa menambah kolom per perubahan konfigurasi. `consent_text` +
    //     `consent_version` disimpan apa adanya supaya bisa dibuktikan versi
    //     mana yang disetujui tamu (syarat UU PDP).
    //   · `gallery_views` — dihitung **per galeri per hari**, bukan per
    //     kunjungan. Tabel ini tumbuh oleh trafik tamu; menyimpan satu baris
    //     per muat halaman akan membuatnya jadi tabel terbesar di DB hanya
    //     untuk sebuah angka di dasbor.
    sql: `
      CREATE TABLE lead_fields (
        id          TEXT PRIMARY KEY,
        event_id    TEXT REFERENCES events(id) ON DELETE CASCADE,
        key         TEXT NOT NULL,
        label       TEXT NOT NULL,
        type        TEXT NOT NULL,
        required    INTEGER NOT NULL DEFAULT 0,
        options     TEXT NOT NULL DEFAULT '[]',
        help_text   TEXT,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_lead_fields_scope_key ON lead_fields(COALESCE(event_id, ''), key);
      CREATE INDEX idx_lead_fields_event ON lead_fields(event_id);

      CREATE TABLE leads (
        id              TEXT PRIMARY KEY,
        event_id        TEXT REFERENCES events(id) ON DELETE CASCADE,
        gallery_id      TEXT REFERENCES galleries(id) ON DELETE SET NULL,
        values_json     TEXT NOT NULL,
        consent         INTEGER NOT NULL,
        consent_text    TEXT NOT NULL,
        consent_version TEXT NOT NULL,
        source          TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_leads_event   ON leads(event_id);
      CREATE INDEX idx_leads_gallery ON leads(gallery_id);
      CREATE INDEX idx_leads_created ON leads(created_at);

      CREATE TABLE gallery_views (
        gallery_id TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
        day        TEXT NOT NULL,
        views      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (gallery_id, day)
      );
      CREATE INDEX idx_gallery_views_day ON gallery_views(day);
    `,
  },
  {
    id: 5,
    name: "photo-content-type",
    // Fase 7. Sebelum ini semua foto pasti JPEG, jadi MIME tidak pernah perlu
    // disimpan. Begitu video masuk ke galeri yang sama, halaman tamu harus tahu
    // mana yang `<img>` dan mana yang `<video controls>` — dan menebaknya dari
    // ekstensi key salah untuk baris lama. `DEFAULT 'image/jpeg'` membuat baris
    // yang sudah ada tetap benar tanpa backfill.
    sql: `
      ALTER TABLE photos ADD COLUMN content_type TEXT NOT NULL DEFAULT 'image/jpeg';
    `,
  },
  {
    id: 6,
    name: "branding-guestbook",
    // Fase 9 (sisa). Dua tabel dengan bentuk yang sangat berbeda, sengaja:
    //
    //   · `app_settings` — satu baris JSON untuk branding. Sama seperti
    //     `booking_settings`: bidang branding bisa bertambah tanpa migrasi
    //     baru, dan membacanya selalu satu baris. `id = 1` dipaksa CHECK supaya
    //     tidak pernah ada dua baris setelan yang saling bertentangan.
    //   · `guestbook_entries` — pesan video/audio tamu. `key` objek disimpan
    //     apa adanya (dibangun `guestbookKey`, bukan dari label), dan `visible`
    //     ada supaya operator bisa menyembunyikan pesan tanpa menghapus berkas
    //     — menghapus karena alasan sesaat berarti tamu kehilangan ucapannya.
    sql: `
      CREATE TABLE app_settings (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        json       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE guestbook_entries (
        id               TEXT PRIMARY KEY,
        event_id         TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        gallery_id       TEXT REFERENCES galleries(id) ON DELETE SET NULL,
        kind             TEXT NOT NULL,
        content_type     TEXT NOT NULL,
        key              TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        bytes            INTEGER NOT NULL,
        label            TEXT NOT NULL,
        visible          INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL
      );
      CREATE INDEX idx_guestbook_event   ON guestbook_entries(event_id);
      CREATE INDEX idx_guestbook_created ON guestbook_entries(created_at);
    `,
  },
  {
    id: 7,
    name: "license-orders",
    // Fase 10. Dua tabel, dan pembagiannya disengaja:
    //
    //   · `orders` — pembelian lisensi. `sku_name` dan `amount_idr` disimpan
    //     **apa adanya saat dibeli**, bukan menunjuk katalog hidup: kalau harga
    //     naik, invoice lama tidak boleh ikut berubah. `reference` berisi kode
    //     aktivasi yang diterbitkan setelah lunas.
    //   · `activation_codes` — kode yang bisa ditebus di perangkat. Tabel
    //     terpisah karena satu order bisa menerbitkan beberapa kode (misal
    //     operator komersial dengan dua booth), dan karena kode harus tetap
    //     bisa diverifikasi walau barisnya di DB order sudah dihapus.
    //
    // `code` disimpan dalam bentuk ternormalisasi (`ABCDEFGHJKLM`, tanpa tanda
    // hubung) supaya `UNIQUE` benar-benar mencegah dua kode yang sama secara
    // visual ditulis dengan format berbeda.
    sql: `
      CREATE TABLE orders (
        id          TEXT PRIMARY KEY,
        sku         TEXT NOT NULL,
        sku_name    TEXT NOT NULL,
        email       TEXT NOT NULL,
        amount_idr  INTEGER NOT NULL,
        status      TEXT NOT NULL,
        provider    TEXT NOT NULL,
        reference   TEXT,
        note        TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        paid_at     TEXT
      );
      CREATE INDEX idx_orders_email  ON orders(email);
      CREATE INDEX idx_orders_status ON orders(status);
      CREATE INDEX idx_orders_created ON orders(created_at);

      CREATE TABLE activation_codes (
        code       TEXT PRIMARY KEY,
        order_id   TEXT REFERENCES orders(id) ON DELETE SET NULL,
        plan       TEXT NOT NULL,
        max_active_galleries INTEGER,
        issued_at  TEXT NOT NULL,
        expires_at TEXT,
        redeemed_at TEXT,
        redeemed_by TEXT,
        revoked_at TEXT
      );
      CREATE INDEX idx_activation_codes_order ON activation_codes(order_id);
    `,
  },
  {
    id: 8,
    name: "booking-reminders",
    // Fase 11 (sisa). Satu kolom, dan alasannya bukan sekadar "supaya ada
    // pengingat": tanpa penanda ini, sapuan pengingat yang jalan tiap jam akan
    // mengirim pesan yang sama berulang kali ke orang yang sama. `NULL` berarti
    // "belum pernah diingatkan"; diisi saat pengingat benar-benar dikirim.
    sql: `
      ALTER TABLE bookings ADD COLUMN reminded_at TEXT;
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
