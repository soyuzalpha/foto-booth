/**
 * Penyimpanan template — IndexedDB, dengan versi memori untuk tes.
 *
 * Template itu kecil (JSON, bukan gambar), jadi seluruhnya disimpan apa adanya
 * sebagai satu record. Yang penting: **setiap record yang dibaca divalidasi
 * ulang**. IndexedDB bisa berisi template dari versi skema lama; satu record
 * rusak tidak boleh bikin seluruh daftar gagal dibuka.
 */

import type { Template } from "@foto-booth/shared";

import { openDatabase, promisify, STORE_TEMPLATES } from "../idb.ts";
import { validateTemplate } from "./model.ts";

export interface TemplateStore {
  put(template: Template): Promise<void>;
  get(id: string): Promise<Template | null>;
  /** Semua template, terbaru diubah dulu. */
  all(): Promise<Template[]>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

function byUpdatedDesc(templates: Template[]): Template[] {
  return [...templates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Versi memori — dipakai tes dan fallback kalau IndexedDB tidak tersedia. */
export class MemoryTemplateStore implements TemplateStore {
  private readonly templates = new Map<string, Template>();

  async put(template: Template): Promise<void> {
    this.templates.set(template.id, template);
  }

  async get(id: string): Promise<Template | null> {
    return this.templates.get(id) ?? null;
  }

  async all(): Promise<Template[]> {
    return byUpdatedDesc([...this.templates.values()]);
  }

  async remove(id: string): Promise<void> {
    this.templates.delete(id);
  }

  async clear(): Promise<void> {
    this.templates.clear();
  }

  get size(): number {
    return this.templates.size;
  }
}

export class IdbTemplateStore implements TemplateStore {
  private db: IDBDatabase | null = null;
  private readonly factory: IDBFactory;

  constructor(factory: IDBFactory) {
    this.factory = factory;
  }

  private async handle(): Promise<IDBDatabase> {
    if (this.db === null) this.db = await openDatabase(this.factory);
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.handle();
    return db.transaction(STORE_TEMPLATES, mode).objectStore(STORE_TEMPLATES);
  }

  async put(template: Template): Promise<void> {
    const store = await this.store("readwrite");
    await promisify(store.put(template));
  }

  async get(id: string): Promise<Template | null> {
    const store = await this.store("readonly");
    const raw = await promisify<unknown>(store.get(id));
    if (raw === undefined) return null;

    const result = validateTemplate(raw);
    if (!result.ok) {
      console.warn(`Template "${id}" di IndexedDB tidak valid, diabaikan:`, result.errors);
      return null;
    }
    return result.template;
  }

  async all(): Promise<Template[]> {
    const store = await this.store("readonly");
    const raw = await promisify<unknown[]>(store.getAll());

    const valid: Template[] = [];
    for (const record of raw) {
      const result = validateTemplate(record);
      if (result.ok) {
        valid.push(result.template);
      } else {
        console.warn("Template di IndexedDB dilewati (skema tidak cocok):", result.errors);
      }
    }
    return byUpdatedDesc(valid);
  }

  async remove(id: string): Promise<void> {
    const store = await this.store("readwrite");
    await promisify(store.delete(id));
  }

  async clear(): Promise<void> {
    const store = await this.store("readwrite");
    await promisify(store.clear());
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export function createTemplateStore(
  global: { indexedDB?: IDBFactory } = globalThis as { indexedDB?: IDBFactory },
): { store: TemplateStore; kind: "indexeddb" | "memory" } {
  if (global.indexedDB !== undefined) {
    return { store: new IdbTemplateStore(global.indexedDB), kind: "indexeddb" };
  }
  return { store: new MemoryTemplateStore(), kind: "memory" };
}
