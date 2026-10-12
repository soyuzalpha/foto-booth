import {
  API_PREFIX,
  APP_VERSION,
  CONTENT_KINDS,
  ContentItemSchema,
  isContentKind,
  type ContentItem,
  type ContentKind,
} from "@foto-booth/shared";

export interface HealthResponse {
  status: string;
  version: string;
  uptimeSeconds: number;
}

const TIMEOUT_MS = 4000;

/**
 * Ping backend. Dipakai untuk membedakan "ada jaringan" dari "backend hidup" —
 * indikator offline yang jujur butuh keduanya.
 *
 * Selalu resolve, tidak pernah throw: pemanggil cuma perlu tahu hidup/mati.
 */
export async function fetchHealth(): Promise<HealthResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${API_PREFIX}/health`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) return null;

    const data = (await res.json()) as Partial<HealthResponse>;

    return {
      status: typeof data.status === "string" ? data.status : "unknown",
      version: typeof data.version === "string" ? data.version : APP_VERSION,
      uptimeSeconds: typeof data.uptimeSeconds === "number" ? data.uptimeSeconds : 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Katalog konten satu kategori.
 *
 * Respons divalidasi per-item: satu item rusak **dibuang**, sisanya tetap
 * dipakai. Kalau seluruh respons tidak berbentuk seperti yang diharapkan,
 * hasilnya daftar kosong — bukan throw. Pemanggil (sync offline) yang
 * memutuskan apa artinya "kosong".
 */
export async function fetchContentCatalog(kind: ContentKind): Promise<ContentItem[]> {
  const res = await fetch(`${API_PREFIX}/content/${kind}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });

  if (!res.ok) throw new Error(`Katalog konten gagal dimuat: HTTP ${res.status}`);

  const data = (await res.json()) as { items?: unknown };
  if (!Array.isArray(data.items)) return [];

  const items: ContentItem[] = [];
  for (const raw of data.items) {
    const parsed = ContentItemSchema.safeParse(raw);
    if (parsed.success && parsed.data.kind === kind) items.push(parsed.data);
  }
  return items;
}

/** Biner satu aset konten; `null` kalau gagal (bukan throw). */
export async function fetchContentAsset(url: string): Promise<Blob | null> {
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

/** Fetcher siap pakai untuk `syncContent` — satu putaran untuk semua kategori. */
export function browserContentFetchers(): {
  catalog: (kind: ContentKind) => Promise<ContentItem[]>;
  asset: (url: string) => Promise<Blob | null>;
} {
  return { catalog: fetchContentCatalog, asset: fetchContentAsset };
}

/** Semua kategori konten, urut sesuai `CONTENT_KINDS`. */
export function allContentKinds(): readonly ContentKind[] {
  return CONTENT_KINDS;
}

export { isContentKind };
