/**
 * Transport palsu untuk tes, CI, dan demo tanpa kamera.
 *
 * Bukan cuma stub: ia meniru sifat-sifat yang justru bikin capture card
 * merepotkan — resolusi terbatas, sinyal bisa diputus, kamera bisa tidur.
 * Dengan begitu seluruh alur capture bisa diuji otomatis tanpa hardware, dan
 * operator bisa mencoba UI di laptop yang tidak punya capture card.
 *
 * Dipakai lewat `?fake=webcam` atau `?fake=capture-card` di studio app.
 */

import { DEFAULT_SAMPLER_SIZE } from "./lumaSampler.ts";
import { rgbaToLuma, type LumaGrid } from "./signalMonitor.ts";
import type { ResolutionPreset } from "./resolutions.ts";
import { RESOLUTION_PRESETS } from "./resolutions.ts";
import type {
  CameraDevice,
  CameraTransport,
  CaptureOptions,
  DeviceSource,
  Frame,
  StillStrategy,
  TransportKind,
} from "./types.ts";

/**
 * Gambar palsu yang **benar-benar bisa didekode**.
 *
 * Kalau `capture()` mengembalikan byte teks ber-`content-type: image/jpeg`,
 * `createImageBitmap` gagal → thumbnail tidak pernah dibuat → jalur thumbnail
 * tidak pernah ikut teruji, dan halaman galeri menunjuk objek yang tidak ada.
 * Jadi gambar digambar sungguhan di canvas lalu dikodekan ulang jadi JPEG.
 * Kalau canvas tidak tersedia (Node), jatuh ke byte teks — capture tetap
 * mengembalikan sesuatu, hanya tidak bisa didekode.
 */
async function fakeFrameBlob(
  payload: string,
  width: number,
  height: number,
): Promise<Blob> {
  if (typeof document === "undefined") {
    return new Blob([payload], { type: "image/jpeg" });
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) return new Blob([payload], { type: "image/jpeg" });

  // Warna diturunkan dari payload supaya tiap jepretan terlihat berbeda.
  let hash = 0;
  for (const char of payload) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  context.fillStyle = `hsl(${hash % 360} 60% 45%)`;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#fff";
  context.font = "16px sans-serif";
  context.fillText(payload, 8, 24);

  return await new Promise<Blob>((resolve) => {
    canvas.toBlob(
      (result) => resolve(result ?? new Blob([payload], { type: "image/jpeg" })),
      "image/jpeg",
      0.8,
    );
  });
}

export interface FakeDeviceSpec {
  id: string;
  label: string;
  /** Ditentukan langsung — tidak lewat heuristik, supaya tes tidak rapuh. */
  source: DeviceSource;
  presets: readonly ResolutionPreset[];
  frameRate: number;
  hasAudio: boolean;
  /** Capture card butuh warm-up; webcam instan. */
  warmupMs: number;
}

function preset(label: string): ResolutionPreset {
  const found = RESOLUTION_PRESETS.find((candidate) => candidate.label === label);
  if (found === undefined) throw new Error(`preset ${label} tidak ada`);
  return found;
}

export const FAKE_WEBCAM: FakeDeviceSpec = {
  id: "fake-webcam",
  label: "Fake Webcam 720p (integrated)",
  source: "webcam",
  presets: [preset("720p")],
  frameRate: 30,
  hasAudio: false,
  warmupMs: 0,
};

export const FAKE_CAPTURE_CARD: FakeDeviceSpec = {
  id: "fake-hdmi-capture",
  label: "Fake HDMI Capture Card 1080p60",
  source: "capture-card",
  presets: [preset("720p"), preset("1080p")],
  frameRate: 60,
  hasAudio: true,
  warmupMs: 120,
};

export const FAKE_DEVICES: readonly FakeDeviceSpec[] = [FAKE_WEBCAM, FAKE_CAPTURE_CARD];

export function fakeSpecById(id: string): FakeDeviceSpec | null {
  return FAKE_DEVICES.find((spec) => spec.id === id) ?? null;
}

export interface FakeTransportOptions {
  specs?: readonly FakeDeviceSpec[];
  now?: () => number;
  newId?: () => string;
  /** Ukuran grid luma yang dihasilkan sampler. */
  samplerSize?: { width: number; height: number };
}

export class FakeTransport implements CameraTransport {
  readonly kind: TransportKind = "uvc";

  private readonly specs: readonly FakeDeviceSpec[];
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly samplerSize: { width: number; height: number };

  private activeSpec: FakeDeviceSpec | null = null;
  private width = 0;
  private height = 0;
  private frameRate = 0;

  /** Sinyal video ada? Diputus oleh `cutSignal()`. */
  private signal = true;
  /** Sinyal balik tapi frame pertama belum valid — meniru warm-up capture card. */
  private warmingUp = false;
  private warmupUntil = 0;
  private ready = false;

  /** Nilai luma yang dikembalikan sampler saat sinyal hidup. */
  private lumaValue = 128;
  /** Adegan dibekukan? Lihat `freezeScene()`. */
  private frozen = false;
  /** Penghitung sampel — dipakai untuk membuat feed terlihat berubah. */
  private sampleTick = 0;
  private connected = false;
  /** Device yang sudah dicabut — hilang dari `list()`, tidak bisa disambung. */
  private readonly removed = new Set<string>();

  private readonly endedListeners = new Set<(deviceId: string | null) => void>();

  constructor(options: FakeTransportOptions = {}) {
    this.specs = options.specs ?? FAKE_DEVICES;
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => `fake-frame-${this.frameCount}`);
    this.samplerSize = options.samplerSize ?? DEFAULT_SAMPLER_SIZE;
    this.frameCount = 0;
  }

  private frameCount: number;

  // ── kontrol untuk tes ────────────────────────────────────────────────

  /** Cabut "kabel HDMI": sampler jadi hitam, capture ditolak. */
  cutSignal(): void {
    this.signal = false;
    this.ready = false;
  }

  /** Colok balik: sinyal ada, tapi butuh warm-up dulu. */
  restoreSignal(): void {
    this.signal = true;
    this.warmingUp = true;
    this.warmupUntil = this.now() + (this.activeSpec?.warmupMs ?? 0);
    this.ready = (this.activeSpec?.warmupMs ?? 0) === 0;
  }

  /** Majukan waktu warm-up (dipakai tes dengan jam palsu). */
  finishWarmup(): void {
    this.warmingUp = false;
    this.warmupUntil = 0;
    this.ready = this.signal;
  }

  setLuma(value: number): void {
    this.lumaValue = value;
  }

  /**
   * Bekukan adegan: sampler mengembalikan grid **identik** tiap sampel.
   *
   * Ini meniru kamera yang diarahkan ke ruangan yang memang tidak berubah —
   * bukan kerusakan. Tanpa knob ini, `FakeTransport` selalu menyelang-seling
   * luma-nya sehingga `SignalMonitor` tidak pernah melihat feed "beku", dan
   * bug webcam-tertutup-overlay lolos dari seluruh suite.
   */
  freezeScene(): void {
    this.frozen = true;
  }

  /** Hidupkan lagi selang-seling luma. */
  unfreezeScene(): void {
    this.frozen = false;
  }

  /** Device yang dicabut saat app sedang jalan. */
  removeDevice(id: string): void {
    this.removed.add(id);

    if (this.activeSpec?.id === id) {
      this.connected = false;
      this.signal = false;
      this.ready = false;
      for (const listener of this.endedListeners) listener(id);
    }
  }

  /** Colok balik device yang tadi dicabut. */
  reinsertDevice(id: string): void {
    this.removed.delete(id);
  }

  onEnded(listener: (deviceId: string | null) => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  // ── CameraTransport ─────────────────────────────────────────────────

  async list(): Promise<CameraDevice[]> {
    // Device yang dicabut **hilang dari daftar** — persis seperti
    // `enumerateDevices()` setelah kabel USB ditarik. Kalau fake tetap
    // melaporkannya, jalur "device hilang di tengah sesi" tidak pernah teruji.
    return this.specs
      .filter((spec) => !this.removed.has(spec.id))
      .map((spec) => this.toDevice(spec));
  }

  /** Device yang sedang tersambung, atau `null`. Lihat `CameraTransport`. */
  currentDevice(): CameraDevice | null {
    if (!this.connected || this.activeSpec === null) return null;
    return this.toDevice(this.activeSpec);
  }

  private toDevice(spec: FakeDeviceSpec): CameraDevice {
    return {
      id: spec.id,
      label: spec.label,
      source: spec.source,
      classification: {
        source: spec.source,
        score: 1,
        matched: ["fake"],
        confidence: "hint" as const,
      },
    };
  }

  async connect(deviceId: string, options: CaptureOptions = {}): Promise<void> {
    const spec = this.specs.find((candidate) => candidate.id === deviceId);

    if (spec === undefined || this.removed.has(deviceId)) {
      // Nama `DOMException` asli supaya jalur `mapMediaError` ikut teruji.
      const error = new Error(`FakeTransport: device ${deviceId} tidak ada`);
      error.name = "NotFoundError";
      throw error;
    }

    this.activeSpec = spec;
    this.connected = true;
    this.signal = true;

    const requested = this.pickPreset(spec, options.width, options.height);
    this.width = requested.width;
    this.height = requested.height;
    this.frameRate = options.frameRate ?? spec.frameRate;

    this.warmingUp = spec.warmupMs > 0;
    this.warmupUntil = this.now() + spec.warmupMs;
    this.ready = spec.warmupMs === 0;
  }

  /** Tiruan semantik `ideal`: ambil preset terbesar yang tidak melebihi permintaan. */
  private pickPreset(
    spec: FakeDeviceSpec,
    width?: number,
    height?: number,
  ): ResolutionPreset {
    if (width === undefined || height === undefined) {
      const largest = spec.presets[spec.presets.length - 1];
      if (largest === undefined) throw new Error("spec tanpa preset");
      return largest;
    }

    let chosen = spec.presets[0];
    if (chosen === undefined) throw new Error("spec tanpa preset");

    for (const candidate of spec.presets) {
      if (candidate.width <= width && candidate.height <= height) chosen = candidate;
    }

    return chosen;
  }

  stream(): MediaStream | null {
    return this.connected ? ({} as MediaStream) : null;
  }

  track(): MediaStreamTrack | null {
    return this.connected ? ({} as MediaStreamTrack) : null;
  }

  async applyOptions(options: CaptureOptions): Promise<void> {
    const spec = this.activeSpec;
    if (spec === null || !this.connected) throw new Error("belum tersambung");

    if (options.width !== undefined || options.height !== undefined) {
      const chosen = this.pickPreset(spec, options.width, options.height);
      this.width = chosen.width;
      this.height = chosen.height;
    }

    if (options.frameRate !== undefined) {
      this.frameRate = Math.min(options.frameRate, spec.frameRate);
    }
  }

  /** Setara `track.getSettings()` — inilah yang dibaca validasi resolusi. */
  settings(): MediaTrackSettings {
    return { width: this.width, height: this.height, frameRate: this.frameRate };
  }

  frameSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  capabilities(): MediaTrackCapabilities {
    const spec = this.activeSpec;
    const largest = spec?.presets[spec.presets.length - 1];
    return {
      width: { max: largest?.width ?? 0 },
      height: { max: largest?.height ?? 0 },
      frameRate: { max: spec?.frameRate ?? 0 },
    };
  }

  async capture(shotIndex: number): Promise<Frame> {
    if (!this.connected) throw new Error("belum tersambung");

    if (!this.signal) {
      throw new Error("tidak ada sinyal — capture card tidak mengirim gambar");
    }

    if (this.warmingUp && this.now() < this.warmupUntil) {
      throw new Error("masih warm-up — frame pertama belum valid");
    }
    this.ready = true;

    const spec = this.activeSpec;
    const strategy: StillStrategy = "canvas";
    const payload = `fake-frame-${shotIndex}-${this.width}x${this.height}-${this.now()}`;
    this.frameCount += 1;

    return {
      id: this.newId(),
      blob: await fakeFrameBlob(payload, this.width, this.height),
      width: this.width,
      height: this.height,
      shotIndex,
      capturedAt: this.now(),
      source: spec?.source ?? "webcam",
      strategy,
    };
  }

  /** Sampler yang bisa diprogram: hitam saat sinyal diputus, siap saat warm-up. */
  lumaSampler(): () => LumaGrid | null {
    return (): LumaGrid | null => {
      if (!this.connected) return null;
      if (!this.signal) return this.uniformGrid(0);
      if (this.warmingUp && this.now() < this.warmupUntil) return null;
      // Nilai diselang-seling supaya gambar terlihat "hidup". Sampler yang
      // selalu mengembalikan grid identik akan dituduh **beku** oleh
      // `SignalMonitor` — dan tuduhan itu benar; yang salah adalah feed-nya,
      // bukan pemantau sinyalnya. Feed kamera nyata selalu berubah.
      //
      // Kecuali saat `freezeScene()` dipanggil: di situ kita memang ingin
      // meniru kamera yang menghadap ruangan yang benar-benar tidak berubah,
      // supaya jalur "webcam dituduh tanpa sinyal" bisa diuji.
      if (this.frozen) return this.uniformGrid(this.lumaValue);

      this.sampleTick += 1;
      return this.uniformGrid(this.lumaValue + (this.sampleTick % 2 === 0 ? 0 : 8));
    };
  }

  private uniformGrid(value: number): LumaGrid {
    const cells = this.samplerSize.width * this.samplerSize.height;
    const rgba = new Uint8ClampedArray(cells * 4);
    for (let i = 0; i < cells; i += 1) {
      rgba[i * 4] = value;
      rgba[i * 4 + 1] = value;
      rgba[i * 4 + 2] = value;
      rgba[i * 4 + 3] = 255;
    }
    return rgbaToLuma(rgba);
  }

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Tiruan warm-up capture card.
   *
   * Sengaja **tidak** benar-benar menunggu waktu nyata: tes memajukan jam lewat
   * `finishWarmup()`, jadi suite tidak melambat 1–3 detik per kasus.
   */
  async waitReady(): Promise<boolean> {
    return this.ready;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.activeSpec = null;
    this.signal = true;
    this.ready = false;
    this.warmingUp = false;
    this.width = 0;
    this.height = 0;
    this.frameRate = 0;
    this.endedListeners.clear();
  }
}
