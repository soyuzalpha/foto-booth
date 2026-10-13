/**
 * Tes alur sesi — tanpa kamera, tanpa timer, tanpa DOM.
 *
 * Semua yang diuji di sini adalah **angka dan state**, bukan tampilan: jumlah
 * slot, sisa countdown, batas retry. Itu memang alasan state machine dipisah
 * dari `CaptureSession` — supaya bagian yang paling mudah salah bisa diuji
 * lurus seperti ini.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SESSION_CONFIG,
  MAX_AUTO_RETRIES,
  allCaptured,
  capturedCount,
  initialSnapshot,
  isWaiting,
  normalizeConfig,
  reduceSession,
  setSlot,
  type SessionEvent,
  type SessionSnapshot,
} from "./stateMachine.ts";

/** Jalankan beberapa event berurutan, kembalikan snapshot terakhir. */
function run(start: SessionSnapshot, ...events: SessionEvent[]): SessionSnapshot {
  return events.reduce(reduceSession, start);
}

function armed(shotCount = 4, countdownMs = 3000, intervalMs = 1200): SessionSnapshot {
  return run(initialSnapshot({ shotCount, countdownMs, intervalMs, reviewMs: 0 }), {
    type: "arm",
    deviceId: "dev-1",
  });
}

/**
 * Gagalkan jepretan berulang kali, termasuk countdown ulang di antara
 * kegagalan — karena begitulah `CaptureSession` benar-benar menjalankannya.
 * Tanpa tick di antaranya, kegagalan kedua hanya akan diabaikan state machine
 * dan tesnya lulus/ gagal karena alasan yang salah.
 */
function failRepeatedly(snapshot: SessionSnapshot, times: number): SessionSnapshot {
  let current = snapshot;

  for (let i = 0; i < times; i += 1) {
    current = reduceSession(current, { type: "capture-failed", code: "device-busy" });
    if (current.state === "countdown") {
      current = reduceSession(current, {
        type: "tick",
        elapsedMs: current.config.countdownMs + 1,
      });
    }
  }

  return current;
}

test("snapshot awal: idle, belum ada device, slot kosong", () => {
  const snapshot = initialSnapshot({ shotCount: 3, countdownMs: 1000, intervalMs: 500, reviewMs: 0 });

  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.deviceId, null);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.failures, 0);
  assert.deepEqual(snapshot.frames, [null, null, null]);
});

test("arm menyiapkan slot sesuai shotCount dan mengosongkan error lama", () => {
  const withError = reduceSession(initialSnapshot(), { type: "fail", code: "device-missing" });
  assert.equal(withError.error, "device-missing");

  const snapshot = run(withError, { type: "arm", deviceId: "dev-1" });

  assert.equal(snapshot.state, "armed");
  assert.equal(snapshot.deviceId, "dev-1");
  assert.equal(snapshot.error, null, "error lama tidak boleh terbawa ke sesi baru");
  assert.equal(snapshot.frames.length, DEFAULT_SESSION_CONFIG.shotCount);
});

test("begin → countdown penuh, bukan langsung capturing", () => {
  const snapshot = run(armed(), { type: "begin" });

  assert.equal(snapshot.state, "countdown");
  assert.equal(snapshot.shotIndex, 0);
  assert.equal(snapshot.waitRemainingMs, 3000);
  assert.equal(snapshot.waitKind, "countdown");
});

test("tick mengurangi sisa sesuai waktu yang benar-benar lewat", () => {
  const snapshot = run(armed(), { type: "begin" }, { type: "tick", elapsedMs: 1200 });

  assert.equal(snapshot.waitRemainingMs, 1800);
  assert.equal(snapshot.state, "countdown", "belum selesai, tetap countdown");
});

test("countdown habis → capturing", () => {
  const snapshot = run(armed(), { type: "begin" }, { type: "tick", elapsedMs: 3000 });

  assert.equal(snapshot.state, "capturing");
  assert.equal(snapshot.waitRemainingMs, 0);
});

test("frame terakhir → review; frame lain → jeda interval ke slot berikutnya", () => {
  const started = run(armed(), { type: "begin" }, { type: "tick", elapsedMs: 3000 });

  const first = run(started, { type: "frame-captured", id: "f0" });
  assert.equal(first.state, "countdown", "masih ada slot berikutnya");
  assert.equal(first.shotIndex, 1);
  assert.equal(first.waitRemainingMs, 1200, "jeda antar-shot, bukan countdown");
  assert.equal(first.waitKind, "interval");

  const single = run(
    armed(1),
    { type: "begin" },
    { type: "tick", elapsedMs: 3000 },
    { type: "frame-captured", id: "only" },
  );
  assert.equal(single.state, "review", "satu-satunya slot → langsung review");
  assert.equal(single.shotIndex, 0);
});

test("sesi 1 shot: frame pertama langsung review", () => {
  const snapshot = run(
    armed(1),
    { type: "begin" },
    { type: "tick", elapsedMs: 3000 },
    { type: "frame-captured", id: "only" },
  );

  assert.equal(snapshot.state, "review");
  assert.equal(allCaptured(snapshot.frames), true);
  assert.equal(capturedCount(snapshot.frames), 1);
});

test("retake mengosongkan slot yang diminta saja, slot lain utuh", () => {
  const review = run(
    armed(3, 1000, 1000),
    { type: "begin" },
    { type: "tick", elapsedMs: 1000 },
    { type: "frame-captured", id: "a" },
    { type: "tick", elapsedMs: 1000 },
    { type: "frame-captured", id: "b" },
    { type: "tick", elapsedMs: 1000 },
    { type: "frame-captured", id: "c" },
  );
  assert.equal(review.state, "review");
  assert.deepEqual(review.frames, ["a", "b", "c"]);

  const retaken = run(review, { type: "retake", index: 1 });

  assert.deepEqual(retaken.frames, ["a", null, "c"]);
  assert.equal(retaken.state, "countdown");
  assert.equal(retaken.shotIndex, 1);
  assert.equal(retaken.waitRemainingMs, 1000, "slot yang diulang dapat countdown penuh lagi");
});

test("retake di luar rentang diabaikan, bukan melempar", () => {
  const review = run(armed(2, 0, 0), { type: "begin" }, { type: "frame-captured", id: "a" }, {
    type: "frame-captured",
    id: "b",
  });

  assert.equal(reduceSession(review, { type: "retake", index: 5 }), review);
  assert.equal(reduceSession(review, { type: "retake", index: -1 }), review);
});

test("accept hanya berlaku kalau semua slot terisi", () => {
  const partial = run(
    armed(2, 0, 0),
    { type: "begin" },
    { type: "frame-captured", id: "a" },
    { type: "frame-captured", id: "b" },
  );

  const withoutSecond = { ...partial, frames: ["a", null] };
  assert.equal(
    reduceSession(withoutSecond, { type: "accept" }).state,
    "review",
    "slot kosong → tetap di review",
  );
  assert.equal(reduceSession(partial, { type: "accept" }).state, "processing");
  assert.equal(reduceSession(reduceSession(partial, { type: "accept" }), { type: "processed" }).state, "composed");
});

// ── sinyal ──────────────────────────────────────────────────────────────

test("sinyal hilang saat countdown habis → tahan di 0, jangan jepret frame hitam", () => {
  const snapshot = run(
    armed(),
    { type: "begin" },
    { type: "signal", signal: "no-signal" },
    { type: "tick", elapsedMs: 3000 },
  );

  assert.equal(snapshot.state, "countdown", "tetap menunggu, tidak menembak");
  assert.equal(snapshot.waitRemainingMs, 0);
});

test("tick berulang saat sinyal hilang mengembalikan snapshot yang SAMA", () => {
  // Kalau objek baru dibuat tiap 100 ms, React akan re-render 10×/detik
  // selama kabel dicabut. Identitas objek adalah kontraknya.
  const held = run(
    armed(),
    { type: "begin" },
    { type: "signal", signal: "no-signal" },
    { type: "tick", elapsedMs: 3000 },
  );

  assert.equal(reduceSession(held, { type: "tick", elapsedMs: 100 }), held);
  assert.equal(reduceSession(held, { type: "tick", elapsedMs: 100 }), held);
});

test("sinyal pulih → lanjut jepret sendiri, tanpa aksi operator", () => {
  const held = run(
    armed(),
    { type: "begin" },
    { type: "signal", signal: "no-signal" },
    { type: "tick", elapsedMs: 3000 },
  );

  const recovered = reduceSession(held, { type: "signal", signal: "ok" });

  assert.equal(recovered.state, "capturing");
});

test("sinyal pulih saat countdown masih berjalan tidak mempercepat jepretan", () => {
  const waiting = run(armed(), { type: "begin" }, { type: "signal", signal: "no-signal" });

  const snapshot = reduceSession(waiting, { type: "signal", signal: "ok" });

  assert.equal(snapshot.state, "countdown");
  assert.equal(snapshot.waitRemainingMs, 3000, "sisa waktu tidak boleh dipotong");
});

// ── retry ───────────────────────────────────────────────────────────────

test("satu kegagalan jepret → ulangi setelah countdown baru, bukan langsung menyerah", () => {
  const capturing = run(armed(), { type: "begin" }, { type: "tick", elapsedMs: 3000 });

  const snapshot = reduceSession(capturing, { type: "capture-failed", code: "device-busy" });

  assert.equal(snapshot.state, "countdown");
  assert.equal(snapshot.failures, 1);
  assert.equal(snapshot.error, "device-busy");
  assert.equal(snapshot.waitRemainingMs, 3000, "jeda ini yang mencegah loop rapat");
});

test(`kegagalan ke-${MAX_AUTO_RETRIES} → stalled, berhenti mencoba otomatis`, () => {
  const capturing = run(armed(), { type: "begin" }, { type: "tick", elapsedMs: 3000 });

  const snapshot = failRepeatedly(capturing, MAX_AUTO_RETRIES);

  assert.equal(snapshot.state, "stalled");
  assert.equal(snapshot.failures, MAX_AUTO_RETRIES);
  assert.equal(snapshot.error, "device-busy");
});

test("kegagalan jepret TIDAK menandai sinyal hilang", () => {
  // Kalau `capture-failed` menyetel `signal: no-signal`, padahal penyebabnya
  // `device-busy` (sinyal sehat), monitor tidak akan pernah memancarkan `ok`
  // lagi — dan sesi macet di 0 selamanya.
  const capturing = run(armed(), { type: "begin" }, { type: "tick", elapsedMs: 3000 });

  const snapshot = reduceSession(capturing, { type: "capture-failed", code: "device-busy" });

  assert.equal(snapshot.signal, capturing.signal, "sinyal tidak boleh diubah oleh kegagalan jepret");
});

test("sinyal pulih saat stalled tidak melanjutkan sendiri", () => {
  const stalled = failRepeatedly(
    run(armed(1, 0, 0), { type: "begin" }),
    MAX_AUTO_RETRIES,
  );
  assert.equal(stalled.state, "stalled");

  assert.equal(reduceSession(stalled, { type: "signal", signal: "ok" }).state, "stalled");
  assert.equal(reduceSession(stalled, { type: "tick", elapsedMs: 5000 }).state, "stalled");
});

test("resume membawa keluar dari stalled tanpa membuang frame", () => {
  const capturing = run(armed(2, 0, 0), { type: "begin" }, { type: "frame-captured", id: "keep-me" });
  const stalled = failRepeatedly(capturing, MAX_AUTO_RETRIES);

  assert.equal(stalled.state, "stalled");

  const resumed = reduceSession(stalled, { type: "resume" });

  assert.equal(resumed.state, "countdown");
  assert.equal(resumed.failures, 0);
  assert.equal(resumed.error, null);
  assert.deepEqual(resumed.frames, ["keep-me", null], "foto yang sudah jadi tidak boleh hilang");
});

test("jepretan sukses mereset penghitung kegagalan", () => {
  let snapshot = run(armed(3, 0, 0), { type: "begin" });
  snapshot = reduceSession(snapshot, { type: "capture-failed", code: "device-busy" });
  snapshot = reduceSession(snapshot, { type: "tick", elapsedMs: 0 });
  assert.equal(snapshot.failures, 1);

  snapshot = reduceSession(snapshot, { type: "frame-captured", id: "a" });

  assert.equal(snapshot.failures, 0);
});

// ── pemulihan & konfigurasi ─────────────────────────────────────────────

test("restore mengembalikan slot yang sudah ada dan langsung review kalau penuh", () => {
  const restored = run(initialSnapshot({ shotCount: 3, countdownMs: 1000, intervalMs: 500, reviewMs: 0 }), {
    type: "restore",
    frames: ["a", "b", "c"],
  });

  assert.equal(restored.state, "review");
  assert.deepEqual(restored.frames, ["a", "b", "c"]);
  assert.equal(restored.shotIndex, 2);
});

test("restore sebagian mengisi slot dari depan, tidak menimpa yang sudah ada", () => {
  const restored = run(initialSnapshot({ shotCount: 4, countdownMs: 1000, intervalMs: 500, reviewMs: 0 }), {
    type: "restore",
    frames: ["a", null, "c"],
  });

  assert.equal(restored.state, "idle", "belum lengkap → belum boleh review");
  assert.deepEqual(restored.frames, ["a", null, "c", null]);
  assert.equal(restored.shotIndex, 1, "lanjut dari slot kosong pertama");
});

test("restore diabaikan kalau sesi sudah berjalan", () => {
  const running = run(armed(), { type: "begin" });

  assert.equal(reduceSession(running, { type: "restore", frames: ["x", "y", "z", "w"] }), running);
});

test("arm setelah restore menyambung sesi, bukan menghapus frame tamu", () => {
  const restored = run(initialSnapshot({ shotCount: 4, countdownMs: 1000, intervalMs: 500, reviewMs: 0 }), {
    type: "restore",
    frames: ["a", null, null, null],
  });

  const rearmed = reduceSession(restored, { type: "arm", deviceId: "cam-1" });

  assert.deepEqual(rearmed.frames, ["a", null, null, null], "frame hasil restore tidak boleh hilang");
  assert.equal(rearmed.shotIndex, 1, "lanjut ke slot kosong pertama, bukan mulai dari 0");
  assert.equal(rearmed.state, "armed");
});

test("arm di sesi baru tetap mulai dari slot 0 dengan daftar kosong", () => {
  const fresh = reduceSession(initialSnapshot({ shotCount: 3, countdownMs: 1000, intervalMs: 500, reviewMs: 0 }), {
    type: "arm",
    deviceId: "cam-1",
  });

  assert.deepEqual(fresh.frames, [null, null, null]);
  assert.equal(fresh.shotIndex, 0);
});

test("begin melanjutkan dari slot kosong pertama, tidak menimpa pose lama", () => {
  const resumed = run(
    initialSnapshot({ shotCount: 4, countdownMs: 1000, intervalMs: 500, reviewMs: 0 }),
    { type: "restore", frames: ["a", null, null, null] },
    { type: "arm", deviceId: "cam-1" },
    { type: "begin" },
  );

  assert.equal(resumed.state, "countdown");
  assert.equal(resumed.shotIndex, 1, "mulai dari slot kosong pertama");
  assert.deepEqual(resumed.frames, ["a", null, null, null]);
});

test("begin di sesi baru mulai dari slot 0", () => {
  const fresh = run(
    initialSnapshot({ shotCount: 3, countdownMs: 1000, intervalMs: 500, reviewMs: 0 }),
    { type: "arm", deviceId: "cam-1" },
    { type: "begin" },
  );

  assert.equal(fresh.shotIndex, 0);
});

test("config mengubah shotCount dan mempertahankan isi slot lama", () => {
  const withFrames = run(
    armed(4, 0, 0),
    { type: "begin" },
    { type: "frame-captured", id: "a" },
    { type: "frame-captured", id: "b" },
  );

  const shrunk = reduceSession(withFrames, { type: "config", config: { shotCount: 2 } });
  assert.deepEqual(shrunk.frames, ["a", "b"]);

  const grown = reduceSession(withFrames, { type: "config", config: { shotCount: 6 } });
  assert.deepEqual(grown.frames, ["a", "b", null, null, null, null]);
});

test("normalizeConfig menjepit nilai ekstrem dan membulatkan", () => {
  assert.deepEqual(
    normalizeConfig({
      ...DEFAULT_SESSION_CONFIG,
      shotCount: 999,
      countdownMs: -5,
      intervalMs: 12.6,
      reviewMs: 0,
      shutterOffsetMs: 333,
    }),
    {
      shotCount: 12,
      countdownMs: 0,
      intervalMs: 13,
      reviewMs: 0,
      shutterOffsetMs: 350,
      autoConnect: true,
    },
  );

  assert.deepEqual(
    normalizeConfig({
      ...DEFAULT_SESSION_CONFIG,
      shotCount: 0,
      countdownMs: 999_999,
      intervalMs: Number.NaN,
      reviewMs: -1,
      shutterOffsetMs: 99_999,
    }),
    {
      shotCount: 1,
      countdownMs: 60_000,
      intervalMs: 0,
      reviewMs: 0,
      shutterOffsetMs: 2_000,
      autoConnect: true,
    },
  );
});

test("event yang tidak masuk akal diabaikan, tidak melempar", () => {
  // UI boleh saja mengirim `accept` dua kali; sesi kamera tidak boleh mati.
  const idle = initialSnapshot();

  assert.equal(reduceSession(idle, { type: "accept" }), idle);
  assert.equal(reduceSession(idle, { type: "frame-captured", id: "x" }), idle);
  assert.equal(reduceSession(idle, { type: "tick", elapsedMs: 100 }), idle);
  assert.equal(reduceSession(idle, { type: "retake", index: 0 }), idle);
  assert.equal(reduceSession(idle, { type: "begin" }), idle, "begin tanpa arm tidak jalan");
});

test("disarm hanya berlaku dari armed/review", () => {
  const armedSnapshot = armed();
  assert.equal(reduceSession(armedSnapshot, { type: "disarm" }).state, "idle");

  const capturing = run(armedSnapshot, { type: "begin" }, { type: "tick", elapsedMs: 3000 });
  assert.equal(reduceSession(capturing, { type: "disarm" }), capturing);
});

test("reset mengosongkan frame tapi mempertahankan device & sinyal", () => {
  const busy = run(
    armed(2, 0, 0),
    { type: "begin" },
    { type: "frame-captured", id: "a" },
    { type: "signal", signal: "no-signal" },
  );

  const reset = reduceSession(busy, { type: "reset" });

  assert.equal(reset.state, "idle");
  assert.deepEqual(reset.frames, [null, null]);
  assert.equal(reset.deviceId, "dev-1");
  assert.equal(reset.signal, "no-signal", "status sinyal milik device, bukan milik sesi");
});

test("setSlot tidak memutasi array lama", () => {
  const before = ["a", "b", "c"];
  const after = setSlot(before, 1, "x");

  assert.deepEqual(before, ["a", "b", "c"]);
  assert.deepEqual(after, ["a", "x", "c"]);
});

test("isWaiting benar saat countdown maupun jeda shutter", () => {
  assert.equal(isWaiting("countdown"), true);
  assert.equal(isWaiting("shutter"), true, "jeda offset shutter juga bertimer");
  assert.equal(isWaiting("armed"), false);
  assert.equal(isWaiting("capturing"), false);
  assert.equal(isWaiting("stalled"), false);
});

// ── durasi review (§B4) ────────────────────────────────────────────────

test("review default (reviewMs 0) menunggu operator, bukan lanjut sendiri", () => {
  const snapshot = run(
    initialSnapshot({ shotCount: 1, countdownMs: 0, intervalMs: 0, reviewMs: 0 }),
    { type: "arm", deviceId: "dev-1" },
    { type: "signal", signal: "ok" },
    { type: "begin" },
    { type: "frame-captured", id: "f1" },
  );

  assert.equal(snapshot.state, "review");
  assert.equal(snapshot.waitRemainingMs, 0);

  const later = reduceSession(snapshot, { type: "tick", elapsedMs: 60_000 });
  assert.equal(later.state, "review", "tanpa durasi, review tidak boleh maju sendiri");
});

test("reviewMs > 0: review lanjut otomatis ke processing setelah waktunya habis", () => {
  const snapshot = run(
    initialSnapshot({ shotCount: 1, countdownMs: 0, intervalMs: 0, reviewMs: 5000 }),
    { type: "arm", deviceId: "dev-1" },
    { type: "signal", signal: "ok" },
    { type: "begin" },
    { type: "frame-captured", id: "f1" },
  );

  assert.equal(snapshot.state, "review");
  assert.equal(snapshot.waitRemainingMs, 5000);
  assert.equal(snapshot.waitKind, "review");

  const halfway = reduceSession(snapshot, { type: "tick", elapsedMs: 2000 });
  assert.equal(halfway.state, "review");
  assert.equal(halfway.waitRemainingMs, 3000);

  const done = reduceSession(halfway, { type: "tick", elapsedMs: 3000 });
  assert.equal(done.state, "processing");
});

test("normalizeConfig menjepit reviewMs dan menyediakan nilai default", () => {
  assert.equal(normalizeConfig({ ...DEFAULT_SESSION_CONFIG, reviewMs: -500 }).reviewMs, 0);
  assert.equal(normalizeConfig({ ...DEFAULT_SESSION_CONFIG, reviewMs: 999_999 }).reviewMs, 60_000);
  assert.equal(DEFAULT_SESSION_CONFIG.reviewMs, 0);
});

// ── offset shutter (Fase 6) ─────────────────────────────────────────────

test("initialSnapshot menerima konfigurasi sebagian dan mengisi sisanya dari default", () => {
  const snapshot = initialSnapshot({ shotCount: 2 });

  assert.equal(snapshot.config.shotCount, 2);
  assert.equal(snapshot.config.countdownMs, DEFAULT_SESSION_CONFIG.countdownMs);
  assert.equal(snapshot.config.shutterOffsetMs, DEFAULT_SESSION_CONFIG.shutterOffsetMs);
  assert.equal(DEFAULT_SESSION_CONFIG.shutterOffsetMs, 0, "default: tanpa jeda tambahan");
});

test("offset shutter 0 → hitungan habis langsung capturing (perilaku lama)", () => {
  const snapshot = run(
    initialSnapshot({ shotCount: 1, countdownMs: 1000, intervalMs: 0, reviewMs: 0, shutterOffsetMs: 0 }),
    { type: "arm", deviceId: "dev-1" },
    { type: "signal", signal: "ok" },
    { type: "begin" },
    { type: "tick", elapsedMs: 1000 },
  );

  assert.equal(snapshot.state, "capturing");
});

test("offset shutter > 0 → angka nol dulu, frame diambil setelah jeda habis", () => {
  const counting = run(
    initialSnapshot({ shotCount: 1, countdownMs: 1000, intervalMs: 0, reviewMs: 0, shutterOffsetMs: 300 }),
    { type: "arm", deviceId: "dev-1" },
    { type: "signal", signal: "ok" },
    { type: "begin" },
  );
  assert.equal(counting.state, "countdown");

  const zero = reduceSession(counting, { type: "tick", elapsedMs: 1000 });
  assert.equal(zero.state, "shutter", "angka sudah nol tapi frame belum diambil");
  assert.equal(zero.waitRemainingMs, 300);
  assert.equal(zero.waitKind, "shutter");

  const half = reduceSession(zero, { type: "tick", elapsedMs: 150 });
  assert.equal(half.state, "shutter");
  assert.equal(half.waitRemainingMs, 150, "jeda dihitung terpisah dari hitungan");

  const done = reduceSession(half, { type: "tick", elapsedMs: 150 });
  assert.equal(done.state, "capturing");
  assert.equal(done.waitRemainingMs, 0);
});

test("offset shutter tetap berlaku saat countdown dimatikan", () => {
  const snapshot = run(
    initialSnapshot({ shotCount: 1, countdownMs: 0, intervalMs: 0, reviewMs: 0, shutterOffsetMs: 300 }),
    { type: "arm", deviceId: "dev-1" },
    { type: "signal", signal: "ok" },
    { type: "begin" },
  );

  assert.equal(snapshot.state, "shutter", "tanpa hitungan pun ada jeda kecil sebelum jepret");
  assert.equal(snapshot.waitRemainingMs, 300);
});

test("sinyal hilang saat jeda shutter → tahan di 0, jangan jepret frame hitam", () => {
  const held = run(
    initialSnapshot({ shotCount: 1, countdownMs: 0, intervalMs: 0, reviewMs: 0, shutterOffsetMs: 300 }),
    { type: "arm", deviceId: "dev-1" },
    { type: "signal", signal: "no-signal" },
    { type: "begin" },
    { type: "tick", elapsedMs: 300 },
  );

  assert.equal(held.state, "shutter", "tetap menunggu, tidak menembak");
  assert.equal(held.waitRemainingMs, 0);
  assert.equal(reduceSession(held, { type: "tick", elapsedMs: 100 }), held);

  const recovered = reduceSession(held, { type: "signal", signal: "ok" });
  assert.equal(recovered.state, "capturing", "sinyal balik → lanjut jepret sendiri");
});

test("normalizeConfig menjepit offset shutter ke batas & langkah slider", () => {
  assert.equal(normalizeConfig({ ...DEFAULT_SESSION_CONFIG, shutterOffsetMs: -100 }).shutterOffsetMs, 0);
  assert.equal(normalizeConfig({ ...DEFAULT_SESSION_CONFIG, shutterOffsetMs: 5_000 }).shutterOffsetMs, 2_000);
  assert.equal(normalizeConfig({ ...DEFAULT_SESSION_CONFIG, shutterOffsetMs: 333 }).shutterOffsetMs, 350);
});

test("auto-connect hidup secara default, hanya mati kalau dimatikan eksplisit", () => {
  assert.equal(DEFAULT_SESSION_CONFIG.autoConnect, true);
  assert.equal(normalizeConfig({ ...DEFAULT_SESSION_CONFIG }).autoConnect, true);
  assert.equal(normalizeConfig({ ...DEFAULT_SESSION_CONFIG, autoConnect: false }).autoConnect, false);
  // Nilai aneh (dari JSON lama / localStorage yang korup) → kembali ke hidup.
  assert.equal(
    normalizeConfig({ ...DEFAULT_SESSION_CONFIG, autoConnect: undefined as unknown as boolean }).autoConnect,
    true,
  );
});
