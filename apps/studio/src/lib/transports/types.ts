/**
 * Kontrak transport kamera.
 *
 * Inti desainnya: **webcam dan capture card HDMI adalah hal yang sama di mata
 * browser** — dua-duanya device UVC, dua-duanya lewat `getUserMedia`. Yang beda
 * bukan jalur kodenya, tapi sifat device-nya (mirror default, resolusi, sinyal
 * bisa hilang). Karena itu `kind` cuma "uvc", dan yang membedakan adalah
 * `CameraDevice.source`.
 *
 * Transport lain (DSLR via WebUSB/PTP, PTP/IP, phone-as-camera) menyusul di
 * Fase 13 dengan kontrak yang sama, jadi UI tidak perlu tahu bedanya.
 */

import type { LumaGrid } from "./signalMonitor.ts";

/** Jalur teknis pengambilan gambar. Fase 1 hanya memakai `uvc`. */
export type TransportKind = "uvc" | "usb" | "network" | "webrtc";

/** Apa device ini secara fisik — inilah yang menentukan perilaku UI. */
export type DeviceSource = "webcam" | "capture-card";

export interface CameraDevice {
  /** `deviceId` dari `enumerateDevices()`. */
  id: string;
  /** Label yang bisa dibaca operator, sudah dirapikan. */
  label: string;
  source: DeviceSource;
  /** Cara device ini diklasifikasikan — ditampilkan di UI biar tidak "ajaib". */
  classification: DeviceClassification;
}

export interface CaptureOptions {
  width?: number;
  height?: number;
  frameRate?: number;
}

/** Satu hasil jepretan. Immutable — dipakai di state machine & disimpan apa adanya. */
export interface Frame {
  id: string;
  blob: Blob;
  width: number;
  height: number;
  /** Urutan ke-berapa dalam sesi (0-based). Retake menimpa index yang sama. */
  shotIndex: number;
  capturedAt: number;
  source: DeviceSource;
  /** Jalur still yang benar-benar dipakai — `takePhoto()` atau fallback canvas. */
  strategy: StillStrategy;
}

export type StillStrategy = "image-capture" | "canvas";

export interface CameraTransport {
  readonly kind: TransportKind;

  /** Device yang tersedia saat ini. Label bisa kosong sebelum izin diberikan. */
  list(): Promise<CameraDevice[]>;

  /** Buka stream dari device terpilih. Melempar `CaptureError` kalau gagal. */
  connect(deviceId: string, options?: CaptureOptions): Promise<void>;

  /** Stream aktif, atau `null` kalau belum tersambung. */
  stream(): MediaStream | null;

  /** Track video aktif, untuk `applyConstraints` dan still capture. */
  track(): MediaStreamTrack | null;

  /** Jepret satu frame diam. */
  capture(shotIndex: number): Promise<Frame>;

  /** Ubah resolusi/framerate pada stream yang sedang jalan. */
  applyOptions(options: CaptureOptions): Promise<void>;

  disconnect(): Promise<void>;

  // ── opsional: hanya relevan untuk transport berbasis elemen video ────
  // Semuanya `?` supaya transport yang tidak punya konsep ini (mis. PTP/IP di
  // Fase 13) tetap memenuhi kontrak. Pemanggil wajib memeriksa keberadaannya.

  /** Elemen video yang menerima stream — UI memasangnya ke DOM. */
  videoElement?(): HTMLVideoElement | null;

  /**
   * Device yang sedang tersambung, atau `null` kalau belum ada.
   *
   * Dipakai untuk memutuskan perilaku yang bergantung pada jenis device
   * (mirror default, deteksi sinyal hilang) tanpa harus menebak dari daftar
   * yang mungkin belum terisi.
   */
  currentDevice?(): CameraDevice | null;

  /** Tunggu frame pertama benar-benar valid (warm-up capture card). */
  waitReady?(timeoutMs?: number): Promise<boolean>;

  /** Sampel luma untuk `SignalMonitor`. */
  lumaSampler?(): (() => LumaGrid | null) | null;

  /** Berlangganan kabar "device dicabut / track berakhir". */
  onEnded?(listener: (deviceId: string | null) => void): () => void;

  /** Batas kemampuan device, atau `null` kalau browser tidak menyediakannya. */
  capabilities?(): MediaTrackCapabilities | null;

  /** Setelan nyata stream yang sedang jalan. */
  settings?(): MediaTrackSettings | null;

  /** Ukuran nyata frame yang sedang diterima. */
  frameSize?(): { width: number; height: number };
}

/** Hasil klasifikasi device, lengkap dengan alasannya supaya bisa diaudit. */
export interface DeviceClassification {
  source: DeviceSource;
  /** Skor heuristik; makin tinggi makin yakin. 0 = tidak ada petunjuk. */
  score: number;
  /** Kata kunci yang cocok, untuk ditampilkan di UI. */
  matched: string[];
  /** Operator boleh menimpanya; nilai ini yang dipakai kalau di-override. */
  confidence: "hint" | "override" | "default";
}

export function defaultMirrorFor(source: DeviceSource): boolean {
  // Webcam menghadap kita → mirror itu yang diharapkan orang.
  // Capture card menerima feed dari kamera yang sudah orientasi benar →
  // mirror malah membalik teks/logo di hasil.
  return source === "webcam";
}
