/**
 * Error kamera yang bisa dibaca manusia.
 *
 * `getUserMedia` gagal dengan `DOMException` yang namanya kriptik
 * (`NotReadableError`? `TrackStartError`?) dan pesannya beda-beda per browser.
 * Operator booth tidak boleh melihat itu. Di sini semuanya dipetakan ke kode
 * yang stabil + kalimat yang menjelaskan **apa yang harus dilakukan**.
 */

export type CaptureErrorCode =
  | "insecure-context"
  | "permission-denied"
  | "device-missing"
  | "device-busy"
  | "overconstrained"
  | "unsupported"
  | "unknown";

export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  /** Nama error asli dari browser, untuk log — bukan untuk ditampilkan. */
  readonly cause_name: string | null;

  constructor(code: CaptureErrorCode, message: string, causeName: string | null = null) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
    this.cause_name = causeName;
  }
}

const MESSAGES: Record<CaptureErrorCode, string> = {
  "insecure-context":
    "Kamera butuh koneksi aman (HTTPS atau localhost). Lewat http://<IP-LAN> browser menyembunyikan kamera sepenuhnya.",
  "permission-denied":
    "Izin kamera ditolak. Buka pengaturan situs di browser dan izinkan akses kamera, lalu coba lagi.",
  "device-missing":
    "Kamera tidak ditemukan. Pastikan capture card / webcam terpasang dan kabelnya tidak lepas.",
  "device-busy":
    "Kamera sedang dipakai aplikasi lain (atau belum dilepas). Tutup aplikasi lain yang memakai kamera, lalu sambungkan ulang.",
  overconstrained:
    "Resolusi yang diminta tidak didukung kamera ini. Pilih mode lain.",
  unsupported: "Browser ini tidak mendukung akses kamera.",
  unknown: "Kamera gagal dibuka karena sebab yang tidak dikenal.",
};

export function captureError(
  code: CaptureErrorCode,
  causeName: string | null = null,
  detail?: string,
): CaptureError {
  const base = MESSAGES[code];
  return new CaptureError(code, detail === undefined ? base : `${base} (${detail})`, causeName);
}

/** Nama `DOMException` → kode kita. Dikumpulkan dari Chrome, Firefox, Safari. */
const BY_NAME: Record<string, CaptureErrorCode> = {
  NotAllowedError: "permission-denied",
  PermissionDeniedError: "permission-denied",
  SecurityError: "permission-denied",
  NotFoundError: "device-missing",
  DevicesNotFoundError: "device-missing",
  OverconstrainedError: "overconstrained",
  ConstraintNotSatisfiedError: "overconstrained",
  NotReadableError: "device-busy",
  TrackStartError: "device-busy",
  SourceUnavailableError: "device-busy",
  AbortError: "device-busy",
  TypeError: "device-missing",
  NotSupportedError: "unsupported",
};

export function mapMediaError(error: unknown): CaptureError {
  const name =
    error instanceof Error ? error.name : error === null ? null : typeof error;

  if (name !== null && name in BY_NAME) {
    const code = BY_NAME[name];
    if (code !== undefined) return captureError(code, name);
  }

  return captureError("unknown", name);
}

/**
 * Cek lingkungan sebelum menyentuh `getUserMedia`.
 *
 * `navigator.mediaDevices` sengaja **tidak ada** di konteks tidak aman, jadi
 * "undefined" di sini hampir selalu berarti HTTP, bukan browser kuno. Membedakan
 * keduanya penting: satu bisa diperbaiki operator, satu tidak.
 */
export function preflight(): CaptureError | null {
  if (typeof navigator === "undefined") return captureError("unsupported");

  // `window` tidak ada di Node — jangan pernah menyentuhnya tanpa cek.
  const secureContext = typeof window === "undefined" ? true : window.isSecureContext !== false;

  if (!secureContext) return captureError("insecure-context");

  if (navigator.mediaDevices === undefined) return captureError("unsupported");

  return null;
}
