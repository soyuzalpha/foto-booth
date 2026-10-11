import { useEffect, useState } from "react";

export type StorageStatus =
  | { kind: "unsupported" }
  | { kind: "checking" }
  | { kind: "ready"; persisted: boolean; usageBytes: number; quotaBytes: number };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export { formatBytes };

/**
 * Kondisi penyimpanan lokal.
 *
 * Offline-first hanya masuk akal kalau data benar-benar tersimpan di
 * perangkat. `persisted` = true berarti browser berjanji tidak menghapus data
 * kita saat ruang menipis — itu yang diminta sebelum sesi foto dimulai.
 */
export function useStorageStatus(): StorageStatus {
  const [status, setStatus] = useState<StorageStatus>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;

    if (typeof navigator === "undefined" || navigator.storage?.estimate === undefined) {
      setStatus({ kind: "unsupported" });
      return;
    }

    void (async () => {
      try {
        const persisted = (await navigator.storage.persisted?.()) ?? false;
        const estimate = await navigator.storage.estimate();

        if (cancelled) return;

        setStatus({
          kind: "ready",
          persisted,
          usageBytes: estimate.usage ?? 0,
          quotaBytes: estimate.quota ?? 0,
        });
      } catch {
        if (!cancelled) setStatus({ kind: "unsupported" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}
