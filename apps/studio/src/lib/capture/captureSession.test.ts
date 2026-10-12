/**
 * Tes `CaptureSession` — orkestrator, bukan state machine.
 *
 * Yang diuji di sini adalah **sambungan**-nya: apakah countdown benar-benar
 * berjalan sendiri tanpa UI, apakah frame benar-benar tersimpan sebelum sesi
 * selesai, apakah kabel yang dicabut tidak menghasilkan foto hitam, dan apakah
 * `stalled` bisa keluar tanpa membuang foto.
 *
 * Semua ketergantungan luar disuntik: `FakeTransport` (kamera), `FakeClock`
 * (waktu), `MemoryFrameStore` (penyimpanan), `preflight` (lingkungan). Tidak
 * ada `setTimeout` nyata dan tidak ada DOM — jadi suite ini jalan di CI.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CaptureSession } from "./captureSession.ts";
import { MemoryFrameStore } from "./frameStore.ts";
import { FakeTransport, FAKE_CAPTURE_CARD, FAKE_WEBCAM } from "../transports/fakeTransport.ts";
import type {
  CameraDevice,
  CameraTransport,
  CaptureOptions,
  Frame,
} from "../transports/types.ts";
import type { LumaGrid } from "../transports/signalMonitor.ts";
import { captureError } from "../transports/errors.ts";
import { createFakeClock, flush, type FakeClock } from "../testing/fakeClock.ts";

// ── alat bantu ──────────────────────────────────────────────────────────

/** `MediaDevices` secukupnya: yang dipakai cuma `addEventListener`. */
class FakeMediaDevices {
  private readonly listeners = new Set<() => void>();

  addEventListener(type: string, listener: () => void): void {
    if (type === "devicechange") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "devicechange") this.listeners.delete(listener);
  }

  fire(): void {
    for (const listener of [...this.listeners]) listener();
  }

  get count(): number {
    return this.listeners.size;
  }
}

/** `localStorage` secukupnya, supaya id sesi bisa diuji tanpa browser. */
class FakeSessionStorage {
  private readonly values = new Map<string, string>();

  constructor(seed?: string) {
    if (seed !== undefined) this.values.set("foto-booth:session-id", seed);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

/**
 * Transport yang bisa dipaksa gagal menjepret.
 *
 * `FakeTransport` hanya menolak jepretan kalau sinyalnya diputus — dan sinyal
 * yang diputus juga membuat pemantau sinyal menahan sesi, jadi jalur retry
 * tidak pernah tersentuh. Untuk menguji retry kita perlu kegagalan **saat
 * sinyal sehat**, persis seperti `device-busy` di lapangan.
 */
class FlakyTransport implements CameraTransport {
  readonly kind = "uvc" as const;

  failNext = 0;

  private readonly inner: FakeTransport;

  constructor(inner: FakeTransport) {
    this.inner = inner;
  }

  list(): Promise<CameraDevice[]> {
    return this.inner.list();
  }

  connect(deviceId: string, options?: CaptureOptions): Promise<void> {
    return this.inner.connect(deviceId, options);
  }

  stream(): MediaStream | null {
    return this.inner.stream();
  }

  track(): MediaStreamTrack | null {
    return this.inner.track();
  }

  async capture(shotIndex: number): Promise<Frame> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("device sibuk sesaat");
    }
    return this.inner.capture(shotIndex);
  }

  applyOptions(options: CaptureOptions): Promise<void> {
    return this.inner.applyOptions(options);
  }

  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }

  waitReady(): Promise<boolean> {
    return this.inner.waitReady();
  }

  lumaSampler(): (() => LumaGrid | null) | null {
    return this.inner.lumaSampler();
  }

  onEnded(listener: (deviceId: string | null) => void): () => void {
    return this.inner.onEnded(listener);
  }

  settings(): MediaTrackSettings {
    return this.inner.settings();
  }

  frameSize(): { width: number; height: number } {
    return this.inner.frameSize();
  }
}

interface Harness {
  session: CaptureSession;
  transport: FakeTransport;
  flaky: FlakyTransport;
  store: MemoryFrameStore;
  clock: FakeClock;
  mediaDevices: FakeMediaDevices;
  errors: string[];
  mirrorEvents: boolean[];
  lostEvents: (string | null)[];
  /** Jalankan countdown/jeda sampai sesi berhenti bergerak. */
  settle(steps?: number): Promise<void>;
}

function harness(options: {
  spec?: typeof FAKE_WEBCAM;
  /** Beberapa device sekaligus — untuk menguji perpindahan device. */
  specs?: readonly (typeof FAKE_WEBCAM)[];
  shotCount?: number;
  countdownMs?: number;
  intervalMs?: number;
  reviewMs?: number;
  blocked?: boolean;
} = {}): Harness {
  const specs = options.specs ?? [options.spec ?? FAKE_WEBCAM];
  const clock = createFakeClock(1_000);
  const transport = new FakeTransport({
    specs,
    now: clock.now,
    newId: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `frame-${n}`;
      };
    })(),
  });
  const flaky = new FlakyTransport(transport);
  const store = new MemoryFrameStore();
  const mediaDevices = new FakeMediaDevices();

  let idCounter = 0;

  const session = new CaptureSession({
    transport: flaky,
    store,
    mediaDevices: mediaDevices as unknown as MediaDevices,
    now: clock.now,
    newId: () => {
      idCounter += 1;
      return `sesi-${idCounter}`;
    },
    setTimer: clock.setTimer,
    signalSchedule: clock.setTimer,
    signalIntervalMs: 500,
    tickMs: 100,
    sessionStorage: new FakeSessionStorage(),
    preflight: () => (options.blocked === true ? captureError("insecure-context") : null),
    config: {
      shotCount: options.shotCount ?? 3,
      countdownMs: options.countdownMs ?? 1_000,
      intervalMs: options.intervalMs ?? 500,
      reviewMs: options.reviewMs ?? 0,
    },
  });

  const errors: string[] = [];
  const mirrorEvents: boolean[] = [];
  const lostEvents: (string | null)[] = [];

  session.on("error", (error) => errors.push(error.code));
  session.on("mirror:changed", (value) => mirrorEvents.push(value));
  session.on("device:lost", ({ deviceId }) => lostEvents.push(deviceId));

  /** Majukan jam, lalu biarkan jepretan async selesai. */
  const settle = async (steps = 12): Promise<void> => {
    for (let i = 0; i < steps; i += 1) {
      clock.advance(2_000);
      await flush(8);
    }
  };

  return { session, transport, flaky, store, clock, mediaDevices, errors, mirrorEvents, lostEvents, settle };
}

// ── koneksi & preflight ─────────────────────────────────────────────────

test("connect menolak lebih awal kalau lingkungan tidak aman", async () => {
  const h = harness({ blocked: true });
  await h.session.init();

  // Inilah gunanya seam: perilaku "HTTP, bukan localhost" diuji tanpa
  // menyentuh `navigator`, yang tidak bisa ditimpa di Node.
  await assert.rejects(() => h.session.connect(FAKE_WEBCAM.id));

  assert.deepEqual(h.errors, ["insecure-context"]);
  assert.equal(h.session.getSnapshot().state, "idle");
  assert.equal(h.session.getSnapshot().error, "insecure-context");
});

test("connect menyiapkan device, daftar device, dan listener devicechange", async () => {
  const h = harness();
  await h.session.init();

  assert.equal(h.mediaDevices.count, 1, "devicechange dipantau");

  await h.session.connect(FAKE_WEBCAM.id);

  assert.equal(h.session.getSnapshot().deviceId, FAKE_WEBCAM.id);
  assert.equal(h.session.devices.length, 1);
  assert.equal(h.session.devices[0]?.source, "webcam");
  assert.deepEqual(h.errors, [], "tanpa peringatan warm-up untuk webcam");
});

test("capture card default tidak di-mirror, webcam di-mirror", async () => {
  const webcam = harness({ spec: FAKE_WEBCAM });
  await webcam.session.init();
  await webcam.session.connect(FAKE_WEBCAM.id);
  assert.equal(webcam.session.mirror(), true, "webcam menghadap operator");

  const card = harness({ spec: FAKE_CAPTURE_CARD });
  await card.session.init();
  await card.session.connect(FAKE_CAPTURE_CARD.id);
  assert.equal(card.session.mirror(), false, "mirror akan membalik teks di hasil");

  card.session.setMirrorOverride(true);
  assert.equal(card.session.mirror(), true, "operator boleh menimpanya");
  assert.deepEqual(card.mirrorEvents, [false, true], "perubahan mirror diberitakan ke UI");
});

test("override mirror tidak menyeberang device", async () => {
  // Kalau menempel, operator yang menyalakan mirror di webcam akan membawa
  // setting itu ke capture card — dan hasil foto tamu jadi kebalik.
  const h = harness({ specs: [FAKE_WEBCAM, FAKE_CAPTURE_CARD] });
  await h.session.init();
  await h.session.connect(FAKE_WEBCAM.id);

  h.session.setMirrorOverride(true);
  assert.equal(h.session.mirror(), true);

  await h.session.connect(FAKE_CAPTURE_CARD.id);
  assert.equal(h.session.mirror(), false, "capture card kembali ke default-nya");

  // Override untuk device yang sama tetap dihormati.
  h.session.setMirrorOverride(true);
  await h.session.connect(FAKE_CAPTURE_CARD.id);
  assert.equal(h.session.mirror(), true, "device yang sama tidak menghapus override");
});

// ── deteksi sinyal: hanya untuk capture card ────────────────────────────

test("webcam dengan adegan statis dan redup tidak pernah dituduh tanpa sinyal", async () => {
  // Inilah bug yang dilaporkan: pilih webcam bawaan laptop, dan kamera
  // seolah tidak terbuka. Padahal kameranya hidup — yang salah adalah
  // `SignalMonitor` (khusus capture card) ikut dipasang di webcam, lalu
  // ruangan redup (luma di bawah ambang hitam) atau orang yang duduk manis
  // (frame identik = "beku") dituduh `no-signal`. Akibatnya berlipat: panel
  // merah menutupi preview, dan countdown ditahan di 0 sehingga tidak ada
  // satu frame pun yang dijepret.
  const h = harness({ shotCount: 3 });
  await h.session.init();
  await h.session.connect(FAKE_WEBCAM.id);

  h.transport.freezeScene();
  h.transport.setLuma(4);

  h.session.arm();
  h.session.begin();
  await h.settle();

  assert.equal(h.session.getSnapshot().signal, "ok", "webcam tidak boleh masuk jalur sinyal-hilang");
  assert.equal(h.session.getSnapshot().state, "review", "sesi harus selesai, bukan menggantung");
  assert.equal(
    h.session.getSnapshot().frames.filter((id) => id !== null).length,
    3,
    "semua slot terisi — bukan 0 frame seperti sebelum diperbaiki",
  );
});

test("capture card yang kabelnya dicabut tetap ditahan di countdown", async () => {
  // Kebalikannya harus tetap berlaku: capture card memang tidak punya sinyal
  // saat kabel HDMI dicabut, dan frame hitamnya tidak boleh dijepret. Kalau
  // tes ini ikut hijau dengan pemantau dimatikan, berarti kita memperbaiki
  // webcam dengan merusak capture card.
  const h = harness({ spec: FAKE_CAPTURE_CARD, shotCount: 2 });
  await h.session.init();
  await h.session.connect(FAKE_CAPTURE_CARD.id);
  h.transport.finishWarmup();

  h.transport.cutSignal();
  h.session.arm();
  h.session.begin();
  await h.settle();

  assert.equal(h.session.getSnapshot().signal, "no-signal", "capture card tetap dipantau");
  assert.equal(h.session.getSnapshot().state, "countdown", "ditahan, tidak menjepret frame hitam");
  assert.equal(
    h.session.getSnapshot().frames.filter((id) => id !== null).length,
    0,
    "tidak ada frame hitam yang tersimpan",
  );
});

test("capture card yang belum warm-up memunculkan peringatan, bukan jepretan gagal", async () => {
  const h = harness({ spec: FAKE_CAPTURE_CARD });
  await h.session.init();
  await h.session.connect(FAKE_CAPTURE_CARD.id);

  assert.deepEqual(h.errors, ["device-busy"], "operator diberi tahu, sesi tidak mati");

  // Setelah warm-up selesai, jepretan jalan normal.
  h.transport.finishWarmup();
  h.session.arm();
  h.session.begin();
  await h.settle();

  assert.equal(h.session.getSnapshot().state, "review");
});

// ── sesi penuh ──────────────────────────────────────────────────────────

test("countdown berjalan sendiri: tanpa UI memanggil apa pun, semua slot terisi", async () => {
  const h = harness({ shotCount: 3 });
  await h.session.init();
  await h.session.connect(FAKE_WEBCAM.id);

  h.session.arm();
  h.session.begin();
  assert.equal(h.session.getSnapshot().state, "countdown");

  await h.settle();

  const snapshot = h.session.getSnapshot();
  assert.equal(snapshot.state, "review");
  assert.equal(h.session.frames().length, 3, "tiga slot terisi");
  assert.deepEqual(
    h.session.frames().map((frame) => frame.shotIndex),
    [0, 1, 2],
  );
  assert.deepEqual(h.errors, []);
});

test("frame tersimpan ke storage SEBELUM sesi selesai — refresh tidak menghilangkan foto", async () => {
  const h = harness({ shotCount: 3 });
  await h.session.init();
  await h.session.connect(FAKE_WEBCAM.id);

  h.session.arm();
  h.session.begin();

  // Maju satu jepretan saja, lalu periksa storage.
  h.clock.advance(1_000);
  await flush(8);

  assert.equal(h.store.size, 1, "satu jepretan = satu frame tersimpan");
  assert.equal(h.session.getSnapshot().state, "countdown", "sesi masih jalan");

  await h.settle();
  assert.equal(h.store.size, 3);
});

test("restoreFrames mengembalikan sesi yang terputus ke tahap review", async () => {
  const h = harness({ shotCount: 2 });
  await h.session.init();
  await h.session.connect(FAKE_WEBCAM.id);

  // Tirukan refresh: frame sudah ada di storage, tapi state masih idle.
  for (const index of [0, 1]) {
    await h.store.put({
      id: `lama-${index}`,
      sessionId: h.session.sessionId,
      shotIndex: index,
      blob: new Blob(["x"], { type: "image/jpeg" }),
      width: 1280,
      height: 720,
      source: "webcam",
      strategy: "canvas",
      capturedAt: index * 1_000,
    });
  }

  const restored = await h.session.restoreFrames();

  assert.equal(restored.length, 2);
  assert.equal(h.session.getSnapshot().state, "review", "tidak perlu mengulang sesi");
  assert.deepEqual(h.session.frames().map((frame) => frame.id), ["lama-0", "lama-1"]);
});

test("frame sesi lama tidak bocor ke sesi baru", async () => {
  const h = harness({ shotCount: 2 });
  await h.session.init();
  await h.session.connect(FAKE_WEBCAM.id);

  h.session.arm();
  h.session.begin();
  await h.settle();
  assert.equal(h.store.size, 2);

  const idLama = h.session.sessionId;
  h.session.newSession();
  await h.session.restoreFrames();

  assert.notEqual(h.session.sessionId, idLama, "sesi baru = id baru");
  assert.equal(h.session.frames().length, 0, "slot kosong lagi");
  assert.equal((await h.store.all(idLama)).length, 2, "frame sesi lama tetap ada di storage");
});

// ── sinyal hilang ───────────────────────────────────────────────────────

test("kabel dicabut di tengah countdown: tidak ada frame hitam yang tersimpan", async () => {
  // Deteksi sinyal hilang itu urusan **capture card** — di situlah kabel HDMI
  // bisa benar-benar lepas. Webcam bawaan tidak punya kabel untuk dicabut,
  // jadi mengujinya di sana hanya mengunci perilaku yang salah.
  const h = harness({ spec: FAKE_CAPTURE_CARD, shotCount: 1, countdownMs: 1_000 });
  await h.session.init();
  await h.session.connect(FAKE_CAPTURE_CARD.id);
  h.transport.finishWarmup();

  h.session.arm();
  h.session.begin();

  // Cabut sebelum countdown habis.
  h.transport.cutSignal();
  h.clock.advance(500);
  await flush(8);
  h.clock.advance(2_000);
  await flush(8);

  const snapshot = h.session.getSnapshot();
  assert.equal(snapshot.signal, "no-signal");
  assert.equal(snapshot.state, "countdown", "tertahan, bukan menjepret layar hitam");
  assert.equal(snapshot.waitRemainingMs, 0, "hitungan sudah habis, tinggal tunggu sinyal");
  assert.equal(h.store.size, 0, "tidak ada frame hitam masuk storage");
});

test("kabel dipasang lagi: sesi lanjut sendiri tanpa aksi operator", async () => {
  const h = harness({ spec: FAKE_CAPTURE_CARD, shotCount: 1, countdownMs: 1_000 });
  await h.session.init();
  await h.session.connect(FAKE_CAPTURE_CARD.id);
  h.transport.finishWarmup();

  h.session.arm();
  h.session.begin();
  h.transport.cutSignal();
  h.clock.advance(1_500);
  await flush(8);
  assert.equal(h.session.getSnapshot().state, "countdown");

  h.transport.restoreSignal();
  h.transport.finishWarmup();
  h.clock.advance(500);
  await flush(8);
  await h.settle(3);

  assert.equal(h.session.getSnapshot().signal, "ok");
  assert.equal(h.session.getSnapshot().state, "review");
  assert.equal(h.store.size, 1, "frame yang tersimpan adalah frame sungguhan");
});

// ── device dicabut ──────────────────────────────────────────────────────

test("device dicabut: sesi ditandai gagal, UI diberi tahu lewat device:lost", async () => {
  const h = harness();
  await h.session.init();
  await h.session.connect(FAKE_WEBCAM.id);
  h.session.arm();

  h.transport.removeDevice(FAKE_WEBCAM.id);
  await flush(8);

  const snapshot = h.session.getSnapshot();
  assert.equal(snapshot.deviceId, null);
  assert.equal(snapshot.error, "device-missing");
  assert.deepEqual(h.lostEvents, [FAKE_WEBCAM.id], "UI perlu tahu supaya bisa menampilkan pesan");
});

test("devicechange dari browser memicu pemindaian ulang daftar device", async () => {
  const h = harness();
  await h.session.init();

  h.mediaDevices.fire();
  await flush(8);

  assert.equal(h.session.devices.length, 1);
});

// ── retry & stalled ─────────────────────────────────────────────────────

test("jepretan gagal diulang otomatis, bukan langsung menyerah", async () => {
  const h = harness({ shotCount: 1, countdownMs: 1_000 });
  await h.session.init();
  await h.session.connect(FAKE_WEBCAM.id);

  h.session.arm();
  h.session.begin();

  h.flaky.failNext = 1;
  await h.settle();

  assert.equal(h.session.getSnapshot().state, "review", "percobaan kedua berhasil");
  assert.deepEqual(h.errors, ["unknown"], "kegagalan tetap dilaporkan, tapi tidak mematikan sesi");
});

test("kegagalan berulang → stalled, lalu retry() keluar TANPA membuang foto", async () => {
  const h = harness({ shotCount: 3, countdownMs: 1_000, intervalMs: 500 });
  await h.session.init();
  await h.session.connect(FAKE_WEBCAM.id);

  h.session.arm();
  h.session.begin();

  // Slot 0 berhasil lebih dulu supaya ada foto yang harus dipertahankan.
  await h.settle(1);
  const terisi = h.session.frames().length;
  assert.equal(terisi, 1, "satu foto sudah jadi");

  h.flaky.failNext = 5;
  await h.settle();

  const stalled = h.session.getSnapshot();
  assert.equal(stalled.state, "stalled", "berhenti mencoba otomatis");
  assert.equal(stalled.failures, 3, "batas percobaan dipegang state machine");

  h.session.retry();

  const resumed = h.session.getSnapshot();
  assert.equal(resumed.state, "countdown");
  assert.equal(resumed.failures, 0);
  assert.equal(h.session.frames().length, terisi, "foto yang sudah jadi tidak hilang");

  h.flaky.failNext = 0;
  await h.settle();

  assert.equal(h.session.getSnapshot().state, "review");
  assert.equal(h.session.frames().length, 3, "sesi tetap bisa diselesaikan");
});

// ── rasio & resolusi ────────────────────────────────────────────────────

test("setAspect menerapkan crop ke hasil jepretan", async () => {
  const clock = createFakeClock(1_000);
  const transport = new FakeTransport({ specs: [FAKE_WEBCAM], now: clock.now });
  const cropped: string[] = [];

  const session = new CaptureSession({
    transport,
    store: new MemoryFrameStore(),
    now: clock.now,
    setTimer: clock.setTimer,
    signalSchedule: clock.setTimer,
    signalIntervalMs: 500,
    sessionStorage: new FakeSessionStorage(),
    preflight: () => null,
    config: { shotCount: 1, countdownMs: 500, intervalMs: 0, reviewMs: 0 },
    crop: async (blob, id) => {
      cropped.push(id);
      return { blob, width: 1080, height: 1350 };
    },
  });

  await session.init();
  await session.connect(FAKE_WEBCAM.id);
  session.setAspect("1:1");
  session.arm();
  session.begin();

  for (let i = 0; i < 8; i += 1) {
    clock.advance(1_000);
    await flush(8);
  }

  assert.deepEqual(cropped, ["1:1"], "crop dipanggil sekali per jepretan");
  const frame = session.frames()[0];
  assert.equal(frame?.width, 1080);
  assert.equal(frame?.height, 1350);
});

test("setResolution meneruskan permintaan ke transport dan melaporkan kegagalan", async () => {
  const h = harness({ spec: FAKE_CAPTURE_CARD });
  await h.session.init();
  await h.session.connect(FAKE_CAPTURE_CARD.id);
  h.transport.finishWarmup();

  await h.session.setResolution(1920, 1080);

  // Capture card palsu punya 720p + 1080p; permintaan 1080p harus dihormati.
  assert.equal(h.session.settings()?.width, 1920);
  assert.equal(h.session.settings()?.height, 1080);
  assert.deepEqual(h.session.frameSize(), { width: 1920, height: 1080 });

  await h.session.disconnect();
  await assert.rejects(() => h.session.setResolution(1280, 720));
  assert.deepEqual(h.errors, ["device-busy", "unknown"], "kegagalan resolusi diberitakan");
});

// ── langganan UI ────────────────────────────────────────────────────────

test("getSnapshot/subscribe stabil dan hanya memberi tahu saat state berubah", async () => {
  const h = harness({ shotCount: 1, countdownMs: 0, intervalMs: 0 });
  await h.session.init();
  await h.session.connect(FAKE_WEBCAM.id);

  // `useSyncExternalStore` memanggil ini di setiap render — identitasnya harus tetap.
  const getSnapshot = h.session.getSnapshot;
  assert.equal(getSnapshot, h.session.getSnapshot, "metode di-bind sekali di konstruktor");
  assert.equal(h.session.subscribe, h.session.subscribe);

  let notifications = 0;
  const unsubscribe = h.session.subscribe(() => {
    notifications += 1;
  });

  h.session.arm();
  h.session.begin();
  await h.settle(2);

  assert.ok(notifications > 0, "UI diberi tahu ada perubahan");
  const sebelum = notifications;

  // Event yang tidak mengubah state tidak boleh menambah notifikasi.
  h.session.setAspect("16:9");
  assert.equal(notifications, sebelum, "state tidak berubah → tidak ada re-render");

  unsubscribe();
  h.session.reset();
  assert.equal(notifications, sebelum, "langganan yang dilepas tidak dipanggil lagi");
});

test("accept hanya jalan kalau semua slot terisi", async () => {
  const h = harness({ shotCount: 2 });
  await h.session.init();
  await h.session.connect(FAKE_WEBCAM.id);
  h.session.arm();

  h.session.accept();
  assert.equal(h.session.getSnapshot().state, "armed", "slot masih kosong");
  assert.deepEqual(h.errors, ["unknown"], "operator diberi tahu kenapa");

  h.session.begin();
  await h.settle();

  const composed: Frame[][] = [];
  h.session.on("session:composed", ({ frames }) => composed.push(frames));
  h.session.accept();

  assert.equal(h.session.getSnapshot().state, "processing");
  assert.equal(composed[0]?.length, 2, "Fase 2 menerima frame lewat event, bukan lewat React state");

  h.session.markProcessed();
  assert.equal(h.session.getSnapshot().state, "composed");
});

test("destroy melepas listener devicechange dan menghentikan timer", async () => {
  const h = harness();
  await h.session.init();
  await h.session.connect(FAKE_WEBCAM.id);

  await h.session.destroy();

  assert.equal(h.mediaDevices.count, 0, "tidak ada listener yang tertinggal");

  // Jam tidak lagi menjadwalkan apa pun setelah destroy.
  h.clock.advance(10_000);
  await flush(8);
  assert.equal(h.session.getSnapshot().state, "idle");
});
