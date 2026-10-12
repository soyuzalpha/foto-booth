/**
 * Hook penyimpanan template.
 *
 * Satu tempat yang tahu soal IndexedDB, supaya komponen tetap bodoh dan bisa
 * diuji lewat `MemoryTemplateStore`. Kalau IndexedDB tidak ada (WebView lama,
 * mode privat), store jatuh ke memori dan UI **memberi tahu** — jangan
 * diam-diam kehilangan template operator.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Template } from "@foto-booth/shared";

import { createTemplateStore, type TemplateStore } from "./template/templateStore.ts";

export interface TemplatesApi {
  /** `memory` = template tidak bertahan setelah reload. */
  kind: "indexeddb" | "memory";
  loading: boolean;
  templates: Template[];
  error: string | null;
  save(template: Template): Promise<void>;
  remove(id: string): Promise<void>;
  reload(): Promise<void>;
}

export function useTemplates(store?: TemplateStore): TemplatesApi {
  const created = useMemo(() => createTemplateStore(), []);
  const ref = useRef<{ store: TemplateStore; kind: "indexeddb" | "memory" } | null>(null);
  if (ref.current === null) {
    ref.current = store !== undefined ? { store, kind: "indexeddb" } : created;
  }
  const active = ref.current;

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await active.store.all());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [active]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (template: Template) => {
      await active.store.put(template);
      await reload();
    },
    [active, reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await active.store.remove(id);
      await reload();
    },
    [active, reload],
  );

  return { kind: active.kind, loading, templates, error, save, remove, reload };
}
