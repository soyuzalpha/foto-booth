/**
 * Penyimpanan frame — IndexedDB, dengan versi memori untuk tes.
 *
 * Frame disimpan **begitu selesai dijepret**, bukan saat sesi ditutup. Kalau
 * browser di-refresh di tengah sesi, tamu tidak kehilangan pose yang sudah
 * diambil. Ini yang membuat "refresh di tengah sesi" jadi kriteria terima dan
 * bukan cuma harapan.
 *
 * `Blob` disimpan apa adanya — IndexedDB menyimpannya sebagai berkas, bukan
 * base64, jadi tidak ada pembengkakan 33%.
 */

import { openDatabase, promisify, STORE_FRAMES } from "../idb.ts";
import type { DeviceSource, StillStrategy } from "../transports/types.ts";

export interface StoredFrame {
  id: string;
  sessionId: string;
  shotIndex: number;
  blob: Blob;
  width: number;
  height: number;
  source: DeviceSource;
  strategy: StillStrategy;
  capturedAt: number;
}

export interface FrameStore {
  put(frame: StoredFrame): Promise<void>;
  get(id: string): Promise<StoredFrame | null>;
  /** Semua frame, urut `capturedAt` naik. Filter opsional per sesi. */
  all(sessionId?: string): Promise<StoredFrame[]>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** Urutkan tanpa memutasi array masukan. */
function byCapturedAt(frames: StoredFrame[]): StoredFrame[] {
  return [...frames].sort((a, b) => a.capturedAt - b.capturedAt);
}

/** Versi memori — dipakai tes dan sebagai fallback kalau IndexedDB tidak ada. */
export class MemoryFrameStore implements FrameStore {
  private readonly frames = new Map<string, StoredFrame>();

  async put(frame: StoredFrame): Promise<void> {
    this.frames.set(frame.id, frame);
  }

  async get(id: string): Promise<StoredFrame | null> {
    return this.frames.get(id) ?? null;
  }

  async all(sessionId?: string): Promise<StoredFrame[]> {
    const values = [...this.frames.values()];
    const filtered = sessionId === undefined ? values : values.filter((f) => f.sessionId === sessionId);
    return byCapturedAt(filtered);
  }

  async remove(id: string): Promise<void> {
    this.frames.delete(id);
  }

  async clear(): Promise<void> {
    this.frames.clear();
  }

  get size(): number {
    return this.frames.size;
  }
}

const INDEX_SESSION = "sessionId";

export class IdbFrameStore implements FrameStore {
  private db: IDBDatabase | null = null;
  private readonly factory: IDBFactory;

  constructor(factory: IDBFactory) {
    this.factory = factory;
  }

  private async handle(): Promise<IDBDatabase> {
    if (this.db === null) this.db = await openDatabase(this.factory);
    return this.db;
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.handle();
    return db.transaction(STORE_FRAMES, mode).objectStore(STORE_FRAMES);
  }

  async put(frame: StoredFrame): Promise<void> {
    const store = await this.tx("readwrite");
    await promisify(store.put(frame));
  }

  async get(id: string): Promise<StoredFrame | null> {
    const store = await this.tx("readonly");
    const result = await promisify<StoredFrame | undefined>(store.get(id));
    return result ?? null;
  }

  async all(sessionId?: string): Promise<StoredFrame[]> {
    const store = await this.tx("readonly");
    const source = sessionId === undefined ? store : store.index(INDEX_SESSION);
    const key = sessionId === undefined ? undefined : IDBKeyRange.only(sessionId);
    const result = await promisify<StoredFrame[]>(source.getAll(key));
    return byCapturedAt(result);
  }

  async remove(id: string): Promise<void> {
    const store = await this.tx("readwrite");
    await promisify(store.delete(id));
  }

  async clear(): Promise<void> {
    const store = await this.tx("readwrite");
    await promisify(store.clear());
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/**
 * Pilih penyimpanan terbaik yang tersedia.
 *
 * Kalau IndexedDB tidak ada (mode privat Safari lama, iframe terkunci), jangan
 * matikan fitur — pakai memori dan beri tahu lewat `kind` supaya UI bisa
 * memperingatkan bahwa frame tidak akan tahan refresh.
 */
export function createFrameStore(
  global: { indexedDB?: IDBFactory } = globalThis as { indexedDB?: IDBFactory },
): { store: FrameStore; kind: "indexeddb" | "memory" } {
  if (global.indexedDB !== undefined) {
    return { store: new IdbFrameStore(global.indexedDB), kind: "indexeddb" };
  }
  return { store: new MemoryFrameStore(), kind: "memory" };
}
