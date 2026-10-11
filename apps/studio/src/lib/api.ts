import { API_PREFIX, APP_VERSION } from "@foto-booth/shared";

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
