/**
 * Satu pembuka IndexedDB untuk seluruh studio.
 *
 * Kenapa dipusatkan: dua modul yang membuka database yang sama dengan versi
 * berbeda akan saling menutup koneksi (`onblocked`), dan gejalanya di UI
 * cuma "penyimpanan kadang gagal" — susah dilacak. Jadi nama, versi, dan
 * daftar object store hanya boleh hidup di sini.
 *
 * Naikkan `DB_VERSION` setiap kali ada object store atau index baru, dan
 * tambahkan pembuatannya di `upgrade()` — store lama tidak boleh dihapus,
 * isinya foto tamu.
 */

export const DB_NAME = "foto-booth";
export const DB_VERSION = 3;

export const STORE_FRAMES = "frames";
export const STORE_TEMPLATES = "templates";
/** Katalog konten dari API (starters/frames/backgrounds/stickers). */
export const STORE_CONTENT = "content";
/** Biner aset konten, dikunci per URL — ini yang bikin konten tampil offline. */
export const STORE_CONTENT_ASSETS = "contentAssets";

const INDEX_FRAME_SESSION = "sessionId";

/** Ubah `IDBRequest` jadi Promise, tanpa menelan error aslinya. */
export function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request gagal"));
  });
}

/**
 * Bikin store yang belum ada. Aman dipanggil berkali-kali: upgrade bisa
 * berjalan dari versi berapa pun, jadi jangan pernah berasumsi store lain
 * sudah ada.
 */
function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_FRAMES)) {
    const frames = db.createObjectStore(STORE_FRAMES, { keyPath: "id" });
    frames.createIndex(INDEX_FRAME_SESSION, "sessionId", { unique: false });
  }

  if (!db.objectStoreNames.contains(STORE_TEMPLATES)) {
    db.createObjectStore(STORE_TEMPLATES, { keyPath: "id" });
  }

  if (!db.objectStoreNames.contains(STORE_CONTENT)) {
    db.createObjectStore(STORE_CONTENT, { keyPath: "kind" });
  }

  if (!db.objectStoreNames.contains(STORE_CONTENT_ASSETS)) {
    db.createObjectStore(STORE_CONTENT_ASSETS, { keyPath: "url" });
  }
}

export function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      upgrade(request.result);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("tidak bisa membuka IndexedDB"));
    request.onblocked = () =>
      reject(new Error("IndexedDB diblokir tab lain yang masih terbuka"));
  });
}
