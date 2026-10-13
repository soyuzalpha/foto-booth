/**
 * Pelaporan error (Sentry) — opsional, **no-op tanpa DSN**.
 *
 * Kiosk dijalankan tanpa operator teknis di sebelahnya; kalau ada error, satu-
 * satunya jejak adalah laporan yang terkirim. Tapi aplikasi ini harus jalan di
 * mesin yang belum diisi DSN (dev, mesin cadangan, klien yang tak mau telemetri),
 * jadi aturannya keras: **tanpa `VITE_SENTRY_DSN` tidak ada apa-apa yang
 * terjadi** — tidak ada error, tidak ada panggilan jaringan, tidak ada log.
 *
 * SDK-nya **dimuat dinamis**. Dua alasan: (1) paket Sentry berat dan tidak
 * berguna kalau tidak dipakai, jadi tidak ikut bundel utama; (2) kalau paketnya
 * belum terpasang, `import` gagal dan kita jatuh ke no-op — bukan crash saat
 * start. Pemuatnya bisa disuntik supaya seluruh perilaku ini bisa diuji tanpa
 * paket Sentry sungguhan.
 */

export interface SentrySdk {
  init(options: { dsn: string; environment?: string; release?: string }): void;
  captureException(error: unknown, context?: Record<string, unknown>): void;
  captureMessage(message: string, level?: string): void;
}

export interface SentryInitOptions {
  /** `VITE_SENTRY_DSN`; `undefined`/kosong = nonaktif. */
  dsn: string | undefined;
  environment?: string;
  release?: string;
  /**
   * Cara memuat SDK. Default: `import("@sentry/browser")`. Tes menyuntik
   * pemuat palsu; build tanpa paket Sentry mengembalikan `null` → no-op.
   */
  loadSdk?: () => Promise<SentrySdk | null>;
  /** Dipanggil saat pemuatan SDK gagal — supaya tidak hilang diam-diam. */
  onLoadError?: (error: unknown) => void;
}

export interface SentryHandle {
  /** `true` = DSN ada & SDK sedang/akan dimuat. */
  enabled: boolean;
  /** Selesai setelah percobaan pemuatan SDK selesai (berhasil atau tidak). */
  ready: Promise<void>;
  captureError(error: unknown, context?: Record<string, unknown>): void;
  captureMessage(message: string, level?: string): void;
}

/**
 * DSN Sentry berbentuk `https://<publicKey>@<host>/<projectId>`.
 *
 * Diperiksa sederhana tapi ketat di bagian yang penting: skema https, ada
 * `@` pemisah kunci/host, dan ada segmen project di akhir. DSN asal-asalan
 * lebih baik ditolak (jadi no-op) daripada bikin SDK melempar tiap kali kirim.
 */
export function isValidDsn(dsn: string): boolean {
  const trimmed = dsn.trim();
  if (!trimmed.startsWith("https://")) return false;

  const at = trimmed.indexOf("@");
  if (at <= "https://".length) return false;

  const afterAt = trimmed.slice(at + 1);
  const slash = afterAt.indexOf("/");
  if (slash <= 0) return false;

  const host = afterAt.slice(0, slash);
  const projectId = afterAt.slice(slash + 1);
  if (host.length === 0) return false;
  if (projectId.length === 0 || !/^[0-9]+$/.test(projectId)) return false;

  return true;
}

const noop = (): void => {};

/** Bungkus error apa pun jadi objek yang aman dikirim (tanpa melempar). */
export function normalizeError(error: unknown): { message: string; name: string } {
  if (error instanceof Error) return { message: error.message, name: error.name };
  if (typeof error === "string") return { message: error, name: "Error" };
  try {
    return { message: JSON.stringify(error), name: "Error" };
  } catch {
    return { message: String(error), name: "Error" };
  }
}

export function initSentry(options: SentryInitOptions): SentryHandle {
  const dsn = options.dsn?.trim() ?? "";

  if (dsn.length === 0 || !isValidDsn(dsn)) {
    // Tanpa DSN (atau DSN tidak valid) → tidak ada apa-apa. Ini jalur normal
    // di dev & di klien yang mematikan telemetri.
    return {
      enabled: false,
      ready: Promise.resolve(),
      captureError: noop,
      captureMessage: noop,
    };
  }

  const loadSdk = options.loadSdk ?? defaultLoadSdk;
  let sdk: SentrySdk | null = null;

  const ready = loadSdk()
    .then((loaded) => {
      if (loaded === null) return;
      sdk = loaded;
      loaded.init({
        dsn,
        ...(options.environment !== undefined ? { environment: options.environment } : {}),
        ...(options.release !== undefined ? { release: options.release } : {}),
      });
    })
    .catch((error: unknown) => {
      // Pemuatan SDK gagal (paket tak ada / jaringan) — tetap no-op, jangan
      // sampai menjatuhkan aplikasi.
      options.onLoadError?.(error);
    });

  return {
    enabled: true,
    ready,
    captureError(error, context) {
      if (sdk === null) return;
      sdk.captureException(error, context);
    },
    captureMessage(message, level) {
      if (sdk === null) return;
      sdk.captureMessage(message, level);
    },
  };
}

/**
 * Pemuat default: impor dinamis paket Sentry. Kalau paketnya tidak ada, `catch`
 * di atas menanganinya; di sini cukup mengembalikan modulnya.
 *
 * ⚠️ Specifier **sengaja** lewat variabel + `@vite-ignore` — jangan diubah jadi
 * impor literal. `@sentry/browser` memang **bukan** dependensi (telemetri
 * opsional), jadi impor literal akan menggagalkan build. Ini beda dengan
 * segmenter/faceEnhance, yang paketnya wajib dan karena itu diimpor literal;
 * di sana `@vite-ignore` adalah bug. Di sini ia mekanismenya: tanpa paket,
 * impor gagal → `catch` → `null` → no-op, dan `initSentry` sudah lebih dulu
 * keluar saat DSN kosong sehingga pemuat ini tak pernah dipanggil tanpa DSN.
 */
async function defaultLoadSdk(): Promise<SentrySdk | null> {
  try {
    const specifier = "@sentry/browser";
    const mod = (await import(/* @vite-ignore */ specifier)) as unknown as SentrySdk;
    return typeof mod.init === "function" ? mod : null;
  } catch {
    return null;
  }
}
