/**
 * `CaptureSession` — orkestrator sesi foto.
 *
 * Menyatukan: transport kamera, state machine, pemantau sinyal, timer
 * countdown, penyimpanan frame, dan listener `devicechange`. **Tidak tahu apa
 * pun tentang React** — UI berlangganan lewat `subscribe()`/`getSnapshot()`,
 * jadi kelas ini bisa diuji penuh di Node dengan `FakeTransport`.
 *
 * Pembagian tanggung jawab:
 * - keputusan alur  → `stateMachine.ts` (murni, bisa diuji)
 * - akses kamera    → `transports/*`
 * - efek samping    → di sini (timer, IndexedDB, event bus, devicechange)
 */

import { cropBlobToRatio, type CroppedBlob } from "./frameCrop.ts";
import { EventBus } from "./eventBus.ts";
import type { FrameStore, StoredFrame } from "./frameStore.ts";
import type { AspectRatioId } from "./aspectRatio.ts";
import {
  allCaptured,
  initialSnapshot,
  isWaiting,
  reduceSession,
  type SessionConfig,
  type SessionEvent,
  type SessionSnapshot,
} from "./stateMachine.ts";
import {
  SignalMonitor,
  type SignalDetail,
  type SignalState,
  type SignalThresholds,
} from "../transports/signalMonitor.ts";
import {
  CaptureError,
  captureError,
  mapMediaError,
  preflight,
} from "../transports/errors.ts";
import {
  defaultMirrorFor,
  type CameraDevice,
  type CameraTransport,
  type Frame,
} from "../transports/types.ts";

export interface CaptureEvents {
  "session:changed": SessionSnapshot;
  "frame:captured": Frame;
  "devices:changed": CameraDevice[];
  "device:lost": { deviceId: string | null };
  "signal:changed": { state: SignalState; detail: SignalDetail };
  error: CaptureError;
  "session:composed": { frames: Frame[] };
  "mirror:changed": boolean;
  "aspect:changed": AspectRatioId;
}

export interface CaptureSessionOptions {
  transport: CameraTransport;
  store: FrameStore;
  bus?: EventBus<CaptureEvents>;
  /** Sumber event `devicechange`. `null` = tidak dipantau (mis. di tes). */
  mediaDevices?: MediaDevices | null;
  now?: () => number;
  newId?: () => string;
  /** Timer yang bisa disuntik supaya countdown deterministik di tes. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /**
   * Cek lingkungan sebelum menyentuh kamera.
   *
   * Bisa disuntik karena `preflight()` aslinya membaca `navigator.mediaDevices`
   * — dan di Node `navigator` ada tapi `mediaDevices` tidak, sehingga tes akan
   * selalu berhenti di "unsupported" sebelum sempat menguji apa pun.
   */
  preflight?: () => CaptureError | null;
  /** Penjadwal untuk `SignalMonitor` — disuntik agar tes bebas timer nyata. */
  signalSchedule?: (fn: () => void, ms: number) => () => void;
  /** Interval langkah countdown. */
  tickMs?: number;
  signalIntervalMs?: number;
  thresholds?: SignalThresholds;
  config?: Partial<SessionConfig>;
  /** Crop hasil ke rasio. Bisa diganti di tes supaya tidak butuh DOM. */
  crop?: (blob: Blob, id: AspectRatioId) => Promise<CroppedBlob>;
  /** Penyimpanan id sesi (localStorage). `null` = jangan persist. */
  sessionStorage?: Pick<Storage, "getItem" | "setItem"> | null;
}

const SESSION_KEY = "foto-booth:session-id";

function defaultTimer(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

function defaultId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export class CaptureSession {
  private readonly transport: CameraTransport;
  private readonly store: FrameStore;
  private readonly bus: EventBus<CaptureEvents>;
  private readonly mediaDevices: MediaDevices | null;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly preflight: () => CaptureError | null;
  private readonly tickMs: number;
  private readonly crop: (blob: Blob, id: AspectRatioId) => Promise<CroppedBlob>;
  private readonly sessionStorage: Pick<Storage, "getItem" | "setItem"> | null;
  private readonly signalOptions: {
    intervalMs?: number;
    thresholds?: SignalThresholds;
    schedule?: (fn: () => void, ms: number) => () => void;
  };

  private snapshotValue: SessionSnapshot;
  private devicesValue: CameraDevice[] = [];
  private readonly framesById = new Map<string, Frame>();
  private sessionIdValue: string;

  private monitor: SignalMonitor | null = null;
  private cancelTick: (() => void) | null = null;
  private unsubscribeEnded: (() => void) | null = null;
  private readonly onDeviceChange: () => void;

  private lastTickAt = 0;
  private performing = false;
  private destroyedValue = false;

  private mirrorOverride: boolean | null = null;
  /** Device tempat override itu dipasang. Override tidak boleh menyeberang device. */
  private mirrorOverrideDevice: string | null = null;
  private aspectValue: AspectRatioId = "original";

  constructor(options: CaptureSessionOptions) {
    this.transport = options.transport;
    this.store = options.store;
    this.bus = options.bus ?? new EventBus<CaptureEvents>();
    this.mediaDevices = options.mediaDevices ?? null;
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? defaultId;
    this.setTimer = options.setTimer ?? defaultTimer;
    this.preflight = options.preflight ?? preflight;
    this.tickMs = options.tickMs ?? 100;
    this.crop = options.crop ?? ((blob, id) => cropBlobToRatio(blob, id));
    this.sessionStorage = options.sessionStorage === undefined ? safeLocalStorage() : options.sessionStorage;
    this.signalOptions = {
      ...(options.signalIntervalMs !== undefined ? { intervalMs: options.signalIntervalMs } : {}),
      ...(options.thresholds !== undefined ? { thresholds: options.thresholds } : {}),
      ...(options.signalSchedule !== undefined ? { schedule: options.signalSchedule } : {}),
    };

    this.snapshotValue = initialSnapshot(options.config ?? undefined);
    this.sessionIdValue = this.restoreSessionId();

    this.onDeviceChange = () => {
      void this.refreshDevices();
    };

    // Identitas stabil untuk `useSyncExternalStore` (dan aman dilepas-pasang).
    this.getSnapshot = this.getSnapshot.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.on = this.on.bind(this);
  }

  // ── pembacaan untuk UI ────────────────────────────────────────────────

  /**
   * Stabil antar-dispatch — aman untuk `useSyncExternalStore`.
   *
   * `subscribe`/`getSnapshot` sengaja metode biasa lalu di-bind di konstruktor
   * (bukan arrow field): arrow field diinisialisasi **sebelum** badan
   * konstruktor, jadi `this.bus` belum ada saat itu.
   */
  getSnapshot(): SessionSnapshot {
    return this.snapshotValue;
  }

  subscribe(listener: () => void): () => void {
    return this.bus.on("session:changed", listener);
  }

  on<K extends keyof CaptureEvents>(
    event: K,
    listener: (payload: CaptureEvents[K]) => void,
  ): () => void {
    return this.bus.on(event, listener);
  }

  get devices(): CameraDevice[] {
    return this.devicesValue;
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  /** Sudah dibuang? Dipakai UI supaya aman terhadap double-mount React. */
  get destroyed(): boolean {
    return this.destroyedValue;
  }

  /** Elemen video transport (kalau ada) — UI memasangnya ke DOM. */
  videoElement(): HTMLVideoElement | null {
    return this.transport.videoElement?.() ?? null;
  }

  /**
   * Stream kamera yang sedang aktif, atau `null`.
   *
   * Dipakai perekam video (Fase 7): `MediaRecorder` butuh `MediaStream`, bukan
   * elemen `<video>`. Elemennya cuma tempat menampilkan; stream-nya milik
   * transport, dan di sini ia diteruskan apa adanya — tanpa disalin, karena
   * `MediaStream` yang disalin tidak ikut membawa track baru.
   */
  stream(): MediaStream | null {
    return this.transport.stream();
  }

  /** Setelan nyata stream — dipakai validasi resolusi. */
  settings(): MediaTrackSettings | null {
    return this.transport.settings?.() ?? null;
  }

  frameSize(): { width: number; height: number } {
    return this.transport.frameSize?.() ?? { width: 0, height: 0 };
  }

  /** Frame yang sudah dijepret, urut slot. */
  frames(): Frame[] {
    return this.snapshotValue.frames
      .map((id) => (id === null ? undefined : this.framesById.get(id)))
      .filter((frame): frame is Frame => frame !== undefined);
  }

  frameAt(index: number): Frame | null {
    const id = this.snapshotValue.frames[index];
    return id === null || id === undefined ? null : (this.framesById.get(id) ?? null);
  }

  /** Mirror yang benar-benar dipakai: override operator, atau default per device. */
  mirror(): boolean {
    if (this.mirrorOverride !== null) return this.mirrorOverride;
    const deviceId = this.snapshotValue.deviceId;
    const device = this.devicesValue.find((candidate) => candidate.id === deviceId);
    return device === undefined ? false : defaultMirrorFor(device.source);
  }

  get aspect(): AspectRatioId {
    return this.aspectValue;
  }

  // ── siklus hidup ──────────────────────────────────────────────────────

  /** Siapkan device + pulihkan sesi yang belum selesai dari penyimpanan. */
  async init(): Promise<void> {
    this.attachDeviceChange();
    await this.refreshDevices();
    await this.restoreFrames();
  }

  async connect(deviceId: string, options?: { width?: number; height?: number; frameRate?: number }): Promise<void> {
    const blocked = this.preflight();
    if (blocked !== null) {
      this.emitError(blocked);
      this.dispatch({ type: "fail", code: blocked.code });
      throw blocked;
    }

    try {
      await this.transport.connect(deviceId, options ?? {});
    } catch (error) {
      const mapped = error instanceof CaptureError ? error : mapMediaError(error);
      this.emitError(mapped);
      this.dispatch({ type: "fail", code: mapped.code });
      throw mapped;
    }

    this.dispatch({ type: "device", deviceId });
    this.attachEndedListener();
    this.startSignalMonitor();

    // Sebelum izin diberikan, UI hanya punya id kosong — `currentDevice()`
    // memegang id asli yang baru saja dibuka track-nya. Tanpa langkah ini
    // `snapshot.deviceId` tetap `""`: dropdown tidak punya opsi yang cocok,
    // jadi tampil seolah tidak ada device yang terpilih.
    const resolvedId = this.transport.currentDevice?.()?.id ?? deviceId;
    if (resolvedId !== deviceId) {
      this.dispatch({ type: "device", deviceId: resolvedId });
      // Izin baru diberikan → label device baru muncul. Segarkan daftar supaya
      // operator melihat nama kamera aslinya, bukan "izin belum diberikan".
      await this.refreshDevices();
    }

    // Override mirror itu keputusan **per device**, bukan preferensi global.
    // Kalau dibiarkan menempel, operator yang menyalakan mirror di webcam akan
    // membawa setting itu ke capture card — dan justru di situlah mirror mati
    // itu wajib. Foto tamu jadi kebalik tanpa ada yang sadar.
    if (this.mirrorOverrideDevice !== null && this.mirrorOverrideDevice !== resolvedId) {
      this.mirrorOverride = null;
      this.mirrorOverrideDevice = null;
    }

    this.bus.emit("mirror:changed", this.mirror());

    // Warm-up: jangan biarkan operator menjepret sebelum frame pertama valid.
    const ready = await (this.transport.waitReady?.() ?? Promise.resolve(true));
    if (!ready) {
      const warn = captureError("device-busy", "warmup-timeout");
      this.emitError(warn);
    }
  }

  async disconnect(): Promise<void> {
    this.stopSignalMonitor();
    this.cancelTick?.();
    this.cancelTick = null;
    this.unsubscribeEnded?.();
    this.unsubscribeEnded = null;

    await this.transport.disconnect();
    this.dispatch({ type: "device", deviceId: null });
    this.dispatch({ type: "reset" });
  }

  async destroy(): Promise<void> {
    this.destroyedValue = true;
    this.detachDeviceChange();
    await this.disconnect();
    this.bus.clear();
  }

  // ── aksi operator ─────────────────────────────────────────────────────

  /** Siapkan sesi baru untuk device yang tersambung. */
  arm(overrides?: Partial<SessionConfig>): void {
    const deviceId = this.snapshotValue.deviceId;
    if (deviceId === null) {
      const error = captureError("device-missing");
      this.emitError(error);
      this.dispatch({ type: "fail", code: error.code });
      return;
    }

    this.dispatch(
      overrides === undefined
        ? { type: "arm", deviceId }
        : { type: "arm", deviceId, config: overrides },
    );
  }

  /** Mulai rangkaian jepretan (countdown lalu capture otomatis). */
  begin(): void {
    this.dispatch({ type: "begin" });
  }

  /** Ambil ulang satu slot tanpa mengulang seluruh sesi. */
  retake(index: number): void {
    this.dispatch({ type: "retake", index });
  }

  /**
   * Coba lagi setelah sesi berhenti di `stalled`.
   *
   * Tanpa ini, satu-satunya jalan keluar dari `stalled` adalah `reset()` yang
   * membuang seluruh frame — operator tidak boleh dipaksa kehilangan foto tamu
   * hanya karena kabel sempat longgar.
   */
  retry(): void {
    this.dispatch({ type: "resume" });
  }

  /** Terima hasil review → lanjut ke tahap processing. */
  accept(): void {
    if (!allCaptured(this.snapshotValue.frames)) {
      this.emitError(captureError("unknown", "belum semua slot terisi"));
      return;
    }

    this.dispatch({ type: "accept" });
    this.bus.emit("session:composed", { frames: this.frames() });
  }

  /** Tandai tahap processing selesai (dipanggil Fase 2 setelah compose). */
  markProcessed(): void {
    this.dispatch({ type: "processed" });
  }

  reset(): void {
    this.dispatch({ type: "reset" });
  }

  setConfig(config: Partial<SessionConfig>): void {
    this.dispatch({ type: "config", config });
  }

  setMirrorOverride(value: boolean | null): void {
    this.mirrorOverride = value;
    // Catat device-nya. `null` (kembali ke default) tidak mengikat ke device mana pun.
    this.mirrorOverrideDevice = value === null ? null : this.snapshotValue.deviceId;
    this.bus.emit("mirror:changed", this.mirror());
  }

  setAspect(id: AspectRatioId): void {
    this.aspectValue = id;
    // Rasio adalah setelan sesi, bukan state alur — jadi tidak lewat state
    // machine, tapi tetap harus memberi tahu UI. Tanpa emit ini, pilihan rasio
    // tidak akan pernah terlihat berubah di layar.
    this.bus.emit("aspect:changed", id);
  }

  /** Ubah resolusi stream yang sedang jalan. */
  async setResolution(width: number, height: number): Promise<void> {
    try {
      await this.transport.applyOptions({ width, height });
    } catch (error) {
      const mapped = error instanceof CaptureError ? error : mapMediaError(error);
      this.emitError(mapped);
      throw mapped;
    }
  }

  // ── device ────────────────────────────────────────────────────────────

  async refreshDevices(): Promise<CameraDevice[]> {
    try {
      this.devicesValue = await this.transport.list();
    } catch {
      this.devicesValue = [];
    }

    // Device yang sedang dipakai hilang (dicabut) → beri tahu UI, jangan diam.
    const deviceId = this.snapshotValue.deviceId;
    if (deviceId !== null && !this.devicesValue.some((device) => device.id === deviceId)) {
      this.stopSignalMonitor();
      this.unsubscribeEnded?.();
      this.unsubscribeEnded = null;
      await this.transport.disconnect().catch(() => undefined);
      this.dispatch({ type: "signal", signal: "no-signal" });
      this.dispatch({ type: "device", deviceId: null });
      this.dispatch({ type: "fail", code: "device-missing" });
      this.bus.emit("device:lost", { deviceId });
    }

    this.bus.emit("devices:changed", this.devicesValue);
    return this.devicesValue;
  }

  private attachDeviceChange(): void {
    this.mediaDevices?.addEventListener("devicechange", this.onDeviceChange);
  }

  private detachDeviceChange(): void {
    this.mediaDevices?.removeEventListener("devicechange", this.onDeviceChange);
  }

  private attachEndedListener(): void {
    this.unsubscribeEnded?.();

    // Cukup panggil `refreshDevices()`: dialah pemilik tunggal peristiwa
    // `device:lost`. Kalau listener ini ikut meng-emit, UI menerima pesan
    // ganda untuk satu kejadian yang sama.
    this.unsubscribeEnded = this.transport.onEnded?.(() => {
      void this.refreshDevices();
    }) ?? null;
  }

  // ── pemantau sinyal ───────────────────────────────────────────────────

  private startSignalMonitor(): void {
    this.stopSignalMonitor();

    // Deteksi sinyal hilang itu **khusus capture card** — dan bukan detail
    // kosmetik. Heuristiknya (frame hitam: luma <= 8, frame beku: delta <= 1.2
    // selama 4 sampel) tidak berlaku untuk webcam: ruangan redup menjatuhkan
    // luma di bawah ambang hitam, dan orang yang duduk manis menghasilkan frame
    // "beku". Keduanya lalu dinyatakan `no-signal`, dan akibatnya berlipat:
    // panel merah menutupi preview (operator mengira kamera tidak terbuka) dan
    // `stateMachine` menahan countdown di 0 selamanya, jadi sesi tidak pernah
    // menjepret satu frame pun.
    //
    // Webcam memang tidak butuh deteksi ini: kalau kabelnya lepas, track-nya
    // `ended` dan jalur `device:lost` yang sudah ada yang menanganinya.
    if (!this.isCaptureCard()) {
      // Harus eksplisit `ok`, bukan dibiarkan `unknown`: UI menampilkan badge
      // sinyal, dan "belum ada pendapat" bukan jawaban yang benar di sini.
      this.dispatch({ type: "signal", signal: "ok" });
      return;
    }

    const sample = this.transport.lumaSampler?.() ?? null;
    if (sample === null) return;

    this.monitor = new SignalMonitor({
      sample,
      onChange: (state, detail) => {
        this.bus.emit("signal:changed", { state, detail });
        this.dispatch({ type: "signal", signal: state });
      },
      ...this.signalOptions,
    });

    this.monitor.start();
  }

  /**
   * Device terpilih sekarang ini capture card?
   *
   * Sumber utamanya daftar device yang sudah diklasifikasi. Kalau device belum
   * ada di daftar — `connect()` dipanggil langsung tanpa `refreshDevices()`,
   * atau label masih kosong sebelum izin diberikan — transport ditanya sebagai
   * cadangan. Default-nya `webcam`, dan itu memang pilihan paling aman: tidak
   * memasang overlay "cek kabel HDMI" pada kamera biasa.
   */
  private isCaptureCard(): boolean {
    const deviceId = this.snapshotValue.deviceId;
    if (deviceId === null) return false;

    const listed = this.devicesValue.find((candidate) => candidate.id === deviceId);
    if (listed !== undefined) return listed.source === "capture-card";

    const connected = this.transport.currentDevice?.() ?? null;
    return connected?.source === "capture-card";
  }

  private stopSignalMonitor(): void {
    this.monitor?.stop();
    this.monitor = null;
  }

  // ── inti alur ─────────────────────────────────────────────────────────

  private dispatch(event: SessionEvent): void {
    if (this.destroyedValue) return;

    const next = reduceSession(this.snapshotValue, event);
    if (next === this.snapshotValue) return;

    this.snapshotValue = next;
    this.bus.emit("session:changed", next);
    this.afterDispatch();
  }

  /**
   * Reaksi terhadap perubahan state.
   *
   * `capturing` selalu berujung pada jepretan nyata, dan `countdown` selalu
   * berjalan dengan timer — jadi alur tidak pernah bergantung pada UI yang
   * rajin memanggil metode.
   */
  private afterDispatch(): void {
    this.cancelTick?.();
    this.cancelTick = null;

    if (this.destroyedValue) return;

    if (this.snapshotValue.state === "capturing") {
      void this.performCapture();
      return;
    }

    // Countdown dan jeda offset shutter sama-sama state bertimer: tanpa tick,
    // sesi akan diam di situ selamanya. Daftarnya diambil dari `isWaiting`
    // supaya tidak ada dua tempat yang tahu "state mana yang menunggu".
    if (isWaiting(this.snapshotValue.state)) {
      this.scheduleTick();
      return;
    }

    // Review ber-timer (kiosk): tanpa ini layar review akan diam selamanya.
    if (this.snapshotValue.state === "review" && this.snapshotValue.config.reviewMs > 0) {
      this.scheduleTick();
    }
  }

  private scheduleTick(): void {
    if (this.cancelTick !== null) return;

    this.lastTickAt = this.now();
    this.cancelTick = this.setTimer(() => {
      this.cancelTick = null;

      const now = this.now();
      const elapsed = Math.max(0, now - this.lastTickAt);
      this.lastTickAt = now;

      this.dispatch({ type: "tick", elapsedMs: elapsed });
    }, this.tickMs);
  }

  private async performCapture(): Promise<void> {
    if (this.performing) return;
    this.performing = true;

    const shotIndex = this.snapshotValue.shotIndex;

    try {
      const raw = await this.transport.capture(shotIndex);
      const frame = await this.withAspect(raw);

      this.framesById.set(frame.id, frame);
      await this.persist(frame);

      this.dispatch({ type: "frame-captured", id: frame.id });
      this.bus.emit("frame:captured", frame);
    } catch (error) {
      const mapped = error instanceof CaptureError ? error : mapMediaError(error);
      this.bus.emit("error", mapped);

      // State machine yang memutuskan: ulangi otomatis, atau berhenti di
      // `stalled` dan tunggu operator. Tidak ada bookkeeping retry di sini —
      // dua tempat yang menghitung hal yang sama pasti akan berbeda.
      this.dispatch({ type: "capture-failed", code: mapped.code });
    } finally {
      this.performing = false;
    }
  }

  /** Terapkan rasio yang dipilih ke hasil jepretan. */
  private async withAspect(frame: Frame): Promise<Frame> {
    if (this.aspectValue === "original") return frame;

    try {
      const cropped = await this.crop(frame.blob, this.aspectValue);
      return { ...frame, blob: cropped.blob, width: cropped.width, height: cropped.height };
    } catch (error) {
      // Crop gagal bukan alasan kehilangan foto — simpan versi penuh.
      this.bus.emit(
        "error",
        captureError("unknown", error instanceof Error ? error.name : "crop-gagal"),
      );
      return frame;
    }
  }

  private async persist(frame: Frame): Promise<void> {
    const stored: StoredFrame = {
      id: frame.id,
      sessionId: this.sessionIdValue,
      shotIndex: frame.shotIndex,
      blob: frame.blob,
      width: frame.width,
      height: frame.height,
      source: frame.source,
      strategy: frame.strategy,
      capturedAt: frame.capturedAt,
    };

    try {
      await this.store.put(stored);
    } catch (error) {
      // Penyimpanan penuh / diblokir: sesi tetap jalan, tapi beri tahu.
      this.bus.emit(
        "error",
        captureError("unknown", error instanceof Error ? error.name : "gagal-simpan"),
      );
    }
  }

  /**
   * Muat ulang frame sesi ini dari penyimpanan.
   *
   * Inilah yang membuat "refresh di tengah sesi → frame tidak hilang" benar-
   * benar berlaku, bukan cuma di dokumen.
   */
  async restoreFrames(): Promise<Frame[]> {
    let stored: StoredFrame[];
    try {
      stored = await this.store.all(this.sessionIdValue);
    } catch {
      return [];
    }

    if (stored.length === 0) return [];

    const frames: Frame[] = stored
      .slice()
      .sort((a, b) => a.shotIndex - b.shotIndex)
      .map((entry) => ({
        id: entry.id,
        blob: entry.blob,
        width: entry.width,
        height: entry.height,
        shotIndex: entry.shotIndex,
        capturedAt: entry.capturedAt,
        source: entry.source,
        strategy: entry.strategy,
      }));

    for (const frame of frames) this.framesById.set(frame.id, frame);

    const slots: (string | null)[] = Array.from(
      { length: this.snapshotValue.config.shotCount },
      () => null,
    );
    for (const frame of frames) {
      if (frame.shotIndex >= 0 && frame.shotIndex < slots.length) {
        slots[frame.shotIndex] = frame.id;
      }
    }

    this.dispatch({ type: "restore", frames: slots });
    return frames;
  }

  /** Mulai sesi baru: id baru + kosongkan slot (frame lama tetap di store). */
  newSession(): void {
    this.sessionIdValue = this.newId();
    this.writeSessionId();
    this.reset();
  }

  private restoreSessionId(): string {
    const existing = this.sessionStorage?.getItem(SESSION_KEY) ?? null;
    if (existing !== null && existing.trim() !== "") return existing;

    const created = this.newId();
    this.sessionStorage?.setItem(SESSION_KEY, created);
    return created;
  }

  private writeSessionId(): void {
    this.sessionStorage?.setItem(SESSION_KEY, this.sessionIdValue);
  }

  private emitError(error: CaptureError): void {
    this.bus.emit("error", error);
  }
}

function safeLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Mode privat / iframe terkunci → localStorage melempar saat diakses.
    return null;
  }
}