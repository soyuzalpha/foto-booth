/**
 * Tes `UvcTransport` — khusus jalur **izin kamera**.
 *
 * Inilah jalur yang bikin dropdown kamera terasa mati: sebelum izin diberikan,
 * `enumerateDevices()` mengembalikan `deviceId` **kosong** dan `label` kosong
 * untuk setiap kamera. Kalau transport memperlakukan `""` sebagai id sungguhan,
 * dua hal rusak sekaligus:
 *
 *   1. `connect("")` mengirim `deviceId: { exact: "" }` → `getUserMedia` gagal,
 *      dan prompt izin tidak pernah muncul. Dropdown jadi jalan buntu.
 *   2. Device yang dilaporkan `currentDevice()` tetap ber-id kosong, jadi UI
 *      tidak punya opsi yang cocok untuk ditampilkan sebagai "terpilih".
 *
 * Semua ketergantungan luar disuntik: `mediaDevices`, `createVideo`, dan
 * `preflight` (yang aslinya menyentuh `navigator` — tidak ada di Node).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { UvcTransport } from "./uvcTransport.ts";
import { captureError } from "./errors.ts";

// ── alat bantu ──────────────────────────────────────────────────────────

interface FakeTrack {
  kind: string;
  settings: MediaTrackSettings;
  stopped: boolean;
  addEventListener(type: string, listener: () => void): void;
  stop(): void;
  getSettings(): MediaTrackSettings;
}

function fakeTrack(deviceId: string): FakeTrack {
  return {
    kind: "video",
    settings: { deviceId },
    stopped: false,
    addEventListener: () => undefined,
    stop() {
      this.stopped = true;
    },
    getSettings() {
      return this.settings;
    },
  };
}

function fakeStream(track: FakeTrack): MediaStream {
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

/** Video secukupnya — yang dipakai transport cuma `srcObject` dan `play()`. */
function fakeVideo(): HTMLVideoElement {
  return {
    srcObject: null,
    muted: false,
    playsInline: false,
    autoplay: false,
    videoWidth: 1280,
    videoHeight: 720,
    className: "",
    play: () => Promise.resolve(),
    parentElement: null,
  } as unknown as HTMLVideoElement;
}

/**
 * `MediaDevices` yang meniru perilaku izin nyata:
 * sebelum `getUserMedia` dipanggil → `deviceId`/`label` kosong;
 * sesudahnya → id dan nama asli.
 */
class FakeMediaDevices {
  /** `true` setelah izin diberikan. */
  granted = false;
  /** Constraint terakhir yang diterima `getUserMedia`. */
  lastConstraints: MediaStreamConstraints | null = null;

  /** Id asli device — dikembalikan hanya setelah izin. */
  readonly realId = "a1b2c3d4e5f6-real-camera-id";
  readonly realLabel = "FaceTime HD Camera (built-in)";

  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    const camera = this.granted
      ? { deviceId: this.realId, kind: "videoinput", label: this.realLabel }
      : { deviceId: "", kind: "videoinput", label: "" };

    // Dua kamera sebelum izin — inilah yang dulu melahirkan opsi kembar.
    const second = this.granted
      ? { deviceId: "second-camera-id", kind: "videoinput", label: "OBS Virtual Camera" }
      : { deviceId: "", kind: "videoinput", label: "" };

    const mic = { deviceId: "", kind: "audioinput", label: "" };

    return [camera, second, mic] as unknown as MediaDeviceInfo[];
  }

  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    this.lastConstraints = constraints;

    // Meniru penolakan browser: `{ exact: "" }` tidak pernah cocok dengan
    // device mana pun, jadi permintaan seperti itu gagal — dan justru itulah
    // yang dulu terjadi.
    const video = constraints.video;
    let requestedId: string | null = null;

    if (typeof video === "object" && video !== null && "deviceId" in video) {
      const requested = (video as { deviceId?: { exact?: string } }).deviceId;
      if (requested?.exact === "") {
        const error = new Error("OverconstrainedError");
        error.name = "OverconstrainedError";
        throw error;
      }
      requestedId = requested?.exact ?? null;
    }

    this.granted = true;

    // Track melaporkan device yang benar-benar dibuka. Ini penting: transport
    // membaca id asli dari sini, jadi fake yang selalu menjawab id yang sama
    // akan menyembunyikan kesalahan pemetaan device.
    const track = fakeTrack(requestedId ?? this.realId);
    return fakeStream(track);
  }
}

function transport(mediaDevices: FakeMediaDevices): UvcTransport {
  return new UvcTransport({
    mediaDevices: mediaDevices as unknown as MediaDevices,
    createVideo: fakeVideo,
    // Lingkungan aman: tes ini soal izin, bukan soal secure context.
    preflight: () => null,
  });
}

// ── list() ──────────────────────────────────────────────────────────────

test("list menggabungkan kamera tanpa deviceId jadi satu entri", async () => {
  const md = new FakeMediaDevices();
  const list = await transport(md).list();

  // Dua kamera tanpa izin + satu mikrofon: mikrofon dibuang, dua kamera jadi satu.
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, "");
  assert.equal(list[0]?.label, "Kamera (izin belum diberikan)");
});

test("list menampilkan nama asli setelah izin diberikan", async () => {
  const md = new FakeMediaDevices();
  const t = transport(md);

  await t.connect("");
  const list = await t.list();

  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((device) => device.id),
    [md.realId, "second-camera-id"],
  );
  assert.equal(list[0]?.label, md.realLabel);
});

// ── connect() ───────────────────────────────────────────────────────────

test("connect dengan id kosong tidak memaksa exact kosong, dan memunculkan prompt izin", async () => {
  const md = new FakeMediaDevices();
  const t = transport(md);

  await t.connect("");

  const video = md.lastConstraints?.video as { deviceId?: unknown } | undefined;
  assert.equal(video?.deviceId, undefined, "deviceId tidak boleh dikirim saat id masih kosong");

  // Prompt izin benar-benar terjadi, dan id asli terbaca dari track.
  assert.equal(md.granted, true);
  assert.equal(t.currentDevice()?.id, md.realId);
  assert.equal(t.currentDevice()?.label, md.realLabel);
});

test("connect dengan id sungguhan tetap meminta device itu secara exact", async () => {
  const md = new FakeMediaDevices();
  md.granted = true;
  const t = transport(md);

  await t.connect("second-camera-id");

  const video = md.lastConstraints?.video as { deviceId?: { exact?: string } } | undefined;
  assert.deepEqual(video?.deviceId, { exact: "second-camera-id" });
  assert.equal(t.currentDevice()?.id, "second-camera-id");
});

test("device tanpa label tetap dapat id asli dari track, bukan string kosong", async () => {
  const md = new FakeMediaDevices();
  const t = transport(md);

  await t.connect("");

  // Inilah inti perbaikan: `currentDevice()` tidak boleh melaporkan `""`.
  assert.notEqual(t.currentDevice()?.id, "");
  assert.equal(t.currentDevice()?.id, md.realId);
});

test("preflight yang gagal membatalkan connect sebelum menyentuh kamera", async () => {
  const md = new FakeMediaDevices();
  const t = new UvcTransport({
    mediaDevices: md as unknown as MediaDevices,
    createVideo: fakeVideo,
    preflight: () => captureError("insecure-context"),
  });

  await assert.rejects(() => t.connect(""), { code: "insecure-context" });
  assert.equal(md.lastConstraints, null, "getUserMedia tidak boleh dipanggil");
});
