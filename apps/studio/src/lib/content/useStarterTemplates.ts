/**
 * Starter template bawaan (Fase 3, FEATURE-MATRIX §B39).
 *
 * Starter dikirim sebagai **konten katalog** (`kind: "starters"`), bukan
 * ditanam di bundle studio. Alasannya: template bawaan ikut aturan konten —
 * bisa ditambah/diubah dari server tanpa rilis ulang, dan otomatis ikut
 * ter-cache offline bersama frame/sticker.
 *
 * Alur baca: katalog dari IndexedDB → blob JSON per item → `parseTemplate`.
 * Semua lewat cache dulu; jaringan cuma dipakai kalau cache belum ada isinya.
 */

import { useEffect, useState } from "react";

import { normalizeTemplate } from "../template/model.ts";
import type { Template } from "@foto-booth/shared";

import { createContentCache, loadCachedCatalog, type ContentCacheStore } from "./contentCache.ts";

export interface StarterTemplate {
  id: string;
  name: string;
  template: Template;
}

export interface StartersState {
  starters: StarterTemplate[];
  loading: boolean;
  /** `true` kalau daftar datang dari cache offline, bukan dari sync baru. */
  fromCache: boolean;
}

/** Sumber blob JSON per URL — injectable supaya bisa diuji tanpa browser. */
export type AssetBlobLoader = (url: string) => Promise<Blob | null>;

/**
 * Sync konten berjalan di komponen lain, jadi panel bisa dibuka sebelum
 * katalognya siap. Retry-nya dibatasi supaya tidak jadi polling tanpa ujung.
 */
const STARTER_LOAD_RETRIES = 8;
const STARTER_LOAD_RETRY_MS = 400;

async function defaultBlobLoader(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

/**
 * Ubah satu blob JSON jadi template yang valid.
 * Starter rusak → `null` (dilewati), bukan melempar dan mematikan seluruh daftar.
 */
export async function parseStarter(
  id: string,
  name: string,
  blob: Blob,
): Promise<StarterTemplate | null> {
  try {
    const raw: unknown = JSON.parse(await blob.text());
    const template = normalizeTemplate(raw);
    return { id, name, template };
  } catch {
    return null;
  }
}

/**
 * Baca semua starter dari cache. Urutan item mengikuti katalog.
 * Item yang blob-nya tidak ada di cache dilewati — bukan error.
 */
export async function loadStarters(
  cache: ContentCacheStore,
  loadBlob: AssetBlobLoader = defaultBlobLoader,
): Promise<StarterTemplate[]> {
  const catalog = await loadCachedCatalog(cache, "starters");
  if (catalog === null) return [];

  const starters: StarterTemplate[] = [];
  for (const item of catalog.items) {
    const blob = (await cache.getAsset(item.url)) ?? (await loadBlob(item.url));
    if (blob === null) continue;
    const parsed = await parseStarter(item.id, item.name, blob);
    if (parsed !== null) starters.push(parsed);
  }
  return starters;
}

/**
 * Hook daftar starter bawaan.
 *
 * Dipanggil sekali per mount panel; `reload` dipakai setelah sync konten
 * selesai supaya starter baru ikut muncul tanpa reload halaman.
 */
export function useStarterTemplates(reloadKey: unknown = null): StartersState {
  const [state, setState] = useState<StartersState>({ starters: [], loading: true, fromCache: false });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { cache } = createContentCache();
      // Sync konten jalan di komponen lain dan bisa belum selesai saat panel ini
      // dibuka. Kalau katalog belum ada, coba lagi beberapa kali (bounded) —
      // kalau tetap kosong, daftar starter memang belum pernah tersinkron.
      let catalog = await loadCachedCatalog(cache, "starters");
      for (let attempt = 0; catalog === null && attempt < STARTER_LOAD_RETRIES; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, STARTER_LOAD_RETRY_MS));
        if (cancelled) return;
        catalog = await loadCachedCatalog(cache, "starters");
      }

      const starters = await loadStarters(cache);
      if (cancelled) return;
      setState({ starters, loading: false, fromCache: catalog !== null });
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return state;
}
