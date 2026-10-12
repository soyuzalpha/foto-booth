/**
 * Transport UVC — melayani **webcam dan capture card HDMI** dengan satu jalur
 * kode, karena di mata browser keduanya device yang sama.
 *
 * Yang membedakan keduanya ditangani di tempat lain:
 * - `deviceProfile.ts` → klasifikasi + mirror default
 * - `signalMonitor.ts` → deteksi sinyal hilang (relevan untuk capture card)
 * - `stillCapture.ts` → jalur still + warm-up
 *
 * `mediaDevices` disuntikkan (bukan dipakai langsung dari `navigator`) supaya
 * seluruh perilakunya bisa diuji tanpa kamera.
 */

import { describeDevice } from "./deviceProfile.ts";
import { captureError, mapMediaError, preflight } from "./errors.ts";
import { createLumaSampler } from "./lumaSampler.ts";
import { captureStill, waitForVideoReady } from "./stillCapture.ts";
import type { LumaGrid } from "./signalMonitor.ts";
import type {
  CameraDevice,
  CameraTransport,
  CaptureOptions,
  DeviceSource,
  Frame,
  StillStrategy,
  TransportKind,
} from "./types.ts";

export interface UvcTransportDeps {
  mediaDevices: MediaDevices;
  /** Pabrik elemen video. Default `document.createElement("video")`. */
  createVideo?: () => HTMLVideoElement;
  now?: () => number;
  newId?: () => string;
}

function defaultVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  return video;
}

function defaultId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `frame-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export class UvcTransport implements CameraTransport {
  readonly kind: TransportKind = "uvc";

  private readonly deps: Required<UvcTransportDeps>;
  private mediaStream: MediaStream | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private device: CameraDevice | null = null;

  private readonly endedListeners = new Set<(deviceId: string | null) => void>();

  constructor(deps: UvcTransportDeps) {
    this.deps = {
      mediaDevices: deps.mediaDevices,
      createVideo: deps.createVideo ?? defaultVideo,
      now: deps.now ?? (() => Date.now()),
      newId: deps.newId ?? defaultId,
    };
  }

  /** Elemen video yang dipakai transport. UI memasangnya ke DOM. */
  videoElement(): HTMLVideoElement | null {
    return this.videoEl;
  }

  currentDevice(): CameraDevice | null {
    return this.device;
  }

  async list(): Promise<CameraDevice[]> {
    const devices = await this.deps.mediaDevices.enumerateDevices();

    return devices
      .filter((device) => device.kind === "videoinput")
      .map((device) => describeDevice(device.deviceId, device.label));
  }

  async connect(deviceId: string, options: CaptureOptions = {}): Promise<void> {
    // Konteks tidak aman / browser tidak dukung — lebih baik gagal dengan
    // pesan yang bisa ditindaklanjuti daripada `getUserMedia` yang membingungkan.
    const blocked = preflight();
    if (blocked !== null) throw blocked;

    await this.disconnect();

    const constraints: MediaStreamConstraints = {
      video: {
        deviceId: { exact: deviceId },
        ...(options.width !== undefined ? { width: { ideal: options.width } } : {}),
        ...(options.height !== undefined ? { height: { ideal: options.height } } : {}),
        ...(options.frameRate !== undefined ? { frameRate: { ideal: options.frameRate } } : {}),
      },
      // Fase 1 hanya foto diam. Audio (yang sering ikut di capture card) belum
      // dipakai — video + guestbook ada di Fase 7.
      audio: false,
    };

    let stream: MediaStream;
    try {
      stream = await this.deps.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      throw mapMediaError(error);
    }

    const [track] = stream.getVideoTracks();
    if (track === undefined) {
      for (const t of stream.getTracks()) t.stop();
      throw captureError("device-missing");
    }

    this.mediaStream = stream;
    this.videoTrack = track;

    const video = this.deps.createVideo();
    video.srcObject = stream;
    this.videoEl = video;

    // Kalau device dicabut, track berakhir — beri tahu pemiliknya supaya UI
    // bisa menampilkan "kamera terputus" alih-alih gambar beku.
    const onEnded = (): void => {
      for (const listener of this.endedListeners) listener(this.device?.id ?? null);
    };
    track.addEventListener("ended", onEnded);

    try {
      await video.play();
    } catch {
      // Autoplay bisa ditolak sebelum ada interaksi pengguna. Stream tetap
      // valid dan frame tetap bisa digambar — jangan gagalkan connect.
    }

    const devices = await this.list();
    const found = devices.find((candidate) => candidate.id === deviceId);
    const rawLabel = devices.length === 0 ? "" : (found?.label ?? "");
    this.device = describeDevice(deviceId, rawLabel);
  }

  stream(): MediaStream | null {
    return this.mediaStream;
  }

  track(): MediaStreamTrack | null {
    return this.videoTrack;
  }

  /** Batas kemampuan device, atau `null` kalau browser tidak menyediakannya. */
  capabilities(): MediaTrackCapabilities | null {
    const track = this.videoTrack;
    if (track === null || typeof track.getCapabilities !== "function") return null;
    return track.getCapabilities();
  }

  settings(): MediaTrackSettings | null {
    return this.videoTrack?.getSettings() ?? null;
  }

  /** Ukuran nyata frame yang sedang diterima — dibaca dari elemen video. */
  frameSize(): { width: number; height: number } {
    return {
      width: this.videoEl?.videoWidth ?? 0,
      height: this.videoEl?.videoHeight ?? 0,
    };
  }

  async applyOptions(options: CaptureOptions): Promise<void> {
    const track = this.videoTrack;
    if (track === null) throw captureError("device-missing");

    const constraints: MediaTrackConstraints = {};
    if (options.width !== undefined) constraints.width = { ideal: options.width };
    if (options.height !== undefined) constraints.height = { ideal: options.height };
    if (options.frameRate !== undefined) constraints.frameRate = { ideal: options.frameRate };

    if (Object.keys(constraints).length === 0) return;

    try {
      await track.applyConstraints(constraints);
    } catch (error) {
      throw mapMediaError(error);
    }
  }

  async capture(shotIndex: number): Promise<Frame> {
    const video = this.videoEl;
    if (video === null || this.videoTrack === null) throw captureError("device-missing");

    let still: { blob: Blob; width: number; height: number; strategy: StillStrategy };
    try {
      still = await captureStill(this.videoTrack, video);
    } catch (error) {
      throw captureError("unknown", error instanceof Error ? error.name : null);
    }

    const source: DeviceSource = this.device?.source ?? "webcam";

    return {
      id: this.deps.newId(),
      blob: still.blob,
      width: still.width,
      height: still.height,
      shotIndex,
      capturedAt: this.deps.now(),
      source,
      strategy: still.strategy,
    };
  }

  /** Fungsi sampel luma untuk `SignalMonitor`, atau `null` sebelum tersambung. */
  lumaSampler(): (() => LumaGrid | null) | null {
    const video = this.videoEl;
    if (video === null) return null;
    return createLumaSampler(video);
  }

  /**
   * Tunggu frame pertama benar-benar valid.
   *
   * Ini yang mencegah "foto hitam pertama setelah colok HDMI" — capture card
   * butuh 1–3 detik sebelum mengirim frame yang bisa digambar.
   */
  async waitReady(timeoutMs = 4000): Promise<boolean> {
    const video = this.videoEl;
    if (video === null) return false;
    return waitForVideoReady(video, { timeoutMs });
  }

  /** Berlangganan kabar "device dicabut / track berakhir". */
  onEnded(listener: (deviceId: string | null) => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    if (this.mediaStream !== null) {
      for (const track of this.mediaStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Track sudah mati — tidak apa-apa.
        }
      }
    }

    if (this.videoEl !== null) {
      this.videoEl.srcObject = null;
    }

    this.mediaStream = null;
    this.videoTrack = null;
    this.videoEl = null;
    this.device = null;
    this.endedListeners.clear();
  }
}
