/**
 * Arsip lokal foto (OPFS) — salinan yang tidak pernah ikut terkirim.
 *
 * Kenapa OPFS dan bukan IndexedDB: foto yang **sudah** diupload dihapus dari
 * IndexedDB supaya kuota kiosk tidak cepat penuh. Tapi operator tetap butuh
 * salinan lokal untuk mencetak ulang setelah kiosk restart. OPFS adalah
 * filesystem sungguhan di perangkat, jadi mencetak dari situ tidak perlu
 * memuat ulang dari jaringan.
 *
 * Aturan yang penting: **arsip lokal tidak pernah jadi syarat upload.** Kalau
 * OPFS tidak ada (browser lama, mode privat), fotonya tetap diupload dan
 * dicetak — cuma salinan cetak-ulangnya yang hilang. Kegagalan di sini tidak
 * boleh menjatuhkan alur utama.
 *
 * Nama berkas: `<albumHash>/<urutan>-<photoId>.<ext>` — sama bentuknya dengan
 * nama di ZIP galeri, jadi operator melihat penamaan yang konsisten.
 */

/** Bagian OPFS yang kita pakai — dibuat sendiri supaya bisa dipalsukan di tes. */
export interface OpfsDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface OpfsFileHandle {
  createWritable(): Promise<OpfsWritable>;
  getFile(): Promise<File>;
}

export interface OpfsWritable {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
}

export interface ArchiveEntry {
  name: string;
  bytes: number;
}

/** Ekstensi dari MIME — sengaja cermin `extForMime` shared, tanpa impor. */
function extensionFor(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

export class LocalArchive {
  private readonly root: () => Promise<OpfsDirectory>;
  private readonly folder: string;

  constructor(root: () => Promise<OpfsDirectory>, folder: string) {
    this.root = root;
    this.folder = folder;
  }

  /** Simpan satu foto. Mengembalikan nama berkasnya, atau `null` kalau gagal. */
  async save(
    photoId: string,
    index: number,
    blob: Blob,
    contentType: string,
  ): Promise<ArchiveEntry | null> {
    try {
      const dir = await this.root();
      const album = await dir.getDirectoryHandle(this.folder, { create: true });
      const name = `${String(index).padStart(3, "0")}-${photoId}.${extensionFor(contentType)}`;
      const file = await album.getFileHandle(name, { create: true });
      const writable = await file.createWritable();
      await writable.write(blob);
      await writable.close();
      return { name, bytes: blob.size };
    } catch {
      // Sengaja tidak melempar: arsip lokal itu kemewahan, bukan syarat.
      return null;
    }
  }

  /** Daftar nama berkas di folder ini. */
  async list(): Promise<string[]> {
    try {
      const dir = await this.root();
      const album = await dir.getDirectoryHandle(this.folder, { create: true });
      const names: string[] = [];
      // `entries()` ada di spesifikasi tapi belum di semua tipe — dibaca lewat
      // cast supaya tidak memaksa `any` di pemanggil.
      const iterable = album as unknown as {
        entries?: () => AsyncIterableIterator<[string, unknown]>;
      };
      if (iterable.entries === undefined) return names;
      for await (const [name] of iterable.entries()) names.push(name);
      return names.sort();
    } catch {
      return [];
    }
  }

  async clear(): Promise<void> {
    try {
      const dir = await this.root();
      await dir.removeEntry(this.folder, { recursive: true });
    } catch {
      // Folder memang belum ada — tidak ada yang perlu dibereskan.
    }
  }
}

/** OPFS dari `navigator.storage`; `null` kalau tidak tersedia. */
export async function openOpfsRoot(): Promise<OpfsDirectory | null> {
  if (typeof navigator === "undefined") return null;
  const storage = navigator.storage as { getDirectory?: () => Promise<OpfsDirectory> } | undefined;
  if (storage?.getDirectory === undefined) return null;
  try {
    return await storage.getDirectory();
  } catch {
    return null;
  }
}

export function createLocalArchive(folder: string): LocalArchive {
  return new LocalArchive(async () => {
    const root = await openOpfsRoot();
    if (root === null) throw new Error("OPFS tidak tersedia");
    return root;
  }, folder);
}
