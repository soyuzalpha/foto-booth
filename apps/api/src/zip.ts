/**
 * Penulis ZIP mode `store` (tanpa kompresi), tanpa dependensi.
 *
 * Kenapa tidak `archiver`/`yazl`: yang dibutuhkan cuma satu bentuk — bungkus
 * beberapa JPEG/PNG yang **sudah** terkompresi jadi satu berkas unduhan.
 * Mengompres ulang JPEG tidak mengecilkan apa pun, hanya menghabiskan CPU saat
 * tamu menekan "unduh semua". Mode `store` juga berarti penulis ZIP ini tidak
 * punya bug kompresi, karena tidak ada kompresi.
 *
 * ZIP ditulis sebagai **aliran**: foto diambil satu per satu dari bucket, jadi
 * satu album besar tidak pernah utuh di memori. Karena itu ukuran & CRC tiap
 * entri harus diketahui sebelum header-nya ditulis — kita dapat keduanya dari
 * `bytes` di database dan dari buffer per-foto (maks 25 MB).
 *
 * Batas yang disengaja: **tanpa ZIP64**. Total album > 4 GiB atau entri tunggal
 * > 4 GiB akan ditolak dengan error yang jelas, bukan menghasilkan arsip rusak.
 * Galeri tamu berumur 30 hari dengan foto maks 25 MB tidak mendekati batas itu.
 */

import { PassThrough, type Readable } from "node:stream";

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_LIMIT = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Nama entri ZIP: buang path absolut & traversal, jaga UTF-8. */
export function sanitizeEntryName(name: string): string {
  const cleaned = name
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .join("/");
  return cleaned === "" ? "foto" : cleaned;
}

export interface ZipEntry {
  /** Nama di dalam arsip. Disanitasi oleh penulis. */
  name: string;
  bytes: Uint8Array;
  /** Waktu modifikasi; default `now`. */
  date?: Date;
}

/** MS-DOS date/time — ZIP memakai format 1980-an ini, bukan epoch. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

function u16(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

/**
 * Bangun ZIP dari entri yang datang berurutan.
 *
 * Mengembalikan `Readable` supaya Fastify bisa mengalirkannya langsung ke
 * respons tanpa menampung arsipnya dulu.
 */
export function buildZip(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  options: { now?: () => Date } = {},
): Readable {
  const out = new PassThrough();
  const now = options.now ?? (() => new Date());

  void (async () => {
    const central: Buffer[] = [];
    let offset = 0;
    let count = 0;

    for await (const entry of entries) {
      const name = sanitizeEntryName(entry.name);
      const nameBytes = Buffer.from(name, "utf8");
      const data = Buffer.from(entry.bytes);
      const crc = crc32(data);
      const { time, date } = dosDateTime(entry.date ?? now());

      if (data.length > ZIP64_LIMIT || offset + data.length > ZIP64_LIMIT) {
        throw new ZipError(
          `arsip melebihi 4 GiB (${offset + data.length} byte) — ZIP64 tidak didukung`,
        );
      }

      // Bit 11 = nama berkas UTF-8.
      const localHeader = Buffer.concat([
        u32(LOCAL_HEADER_SIG),
        u16(20), // versi minimum
        u16(0x0800),
        u16(0), // metode 0 = store
        u16(time),
        u16(date),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0), // extra
      ]);

      out.write(localHeader);
      out.write(nameBytes);
      out.write(data);

      central.push(
        Buffer.concat([
          u32(CENTRAL_HEADER_SIG),
          u16(20), // versi pembuat
          u16(20), // versi minimum
          u16(0x0800),
          u16(0),
          u16(time),
          u16(date),
          u32(crc),
          u32(data.length),
          u32(data.length),
          u16(nameBytes.length),
          u16(0), // extra
          u16(0), // komentar
          u16(0), // nomor disk
          u16(0), // atribut internal
          u32(0), // atribut eksternal
          u32(offset),
          nameBytes,
        ]),
      );

      offset += localHeader.length + nameBytes.length + data.length;
      count += 1;
    }

    const centralStart = offset;
    for (const record of central) {
      out.write(record);
      offset += record.length;
    }

    out.write(
      Buffer.concat([
        u32(EOCD_SIG),
        u16(0), // nomor disk
        u16(0), // disk berisi central directory
        u16(count),
        u16(count),
        u32(offset - centralStart),
        u32(centralStart),
        u16(0), // panjang komentar
      ]),
    );

    out.end();
  })().catch((error: unknown) => out.destroy(error as Error));

  return out;
}
