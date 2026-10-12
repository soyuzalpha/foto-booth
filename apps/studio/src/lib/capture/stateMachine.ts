/**
 * State machine sesi capture — fungsi murni.
 *
 * `idle → armed → countdown → capturing → review → processing → composed`
 *
 * Sengaja dipisah dari `CaptureSession` (yang menyentuh kamera, timer, dan
 * IndexedDB) supaya seluruh alur bisa diuji tanpa browser: beri snapshot +
 * event, periksa snapshot berikutnya. Tidak ada `Date.now()` di sini — waktu
 * masuk lewat event `tick` sebagai `elapsedMs`, jadi tes bisa memajukan jam
 * sesuka hati.
 *
 * **Sinyal hilang bukan state, tapi kondisi.** Kalau sinyal putus saat
 * countdown, jangan batal dan jangan juga jepret frame hitam — tahan di
 * countdown (sisa 0) lalu lanjut sendiri begitu sinyal balik. Karena itu
 * `signal` hidup di snapshot, terpisah dari `state`.
 */

import type { CaptureErrorCode } from "../transports/errors.ts";
import type { SignalState } from "../transports/signalMonitor.ts";

export type SessionState =
  | "idle"
  | "armed"
  | "countdown"
  | "capturing"
  | "review"
  | "processing"
  | "composed"
  /**
   * Kamera gagal berulang kali; sesi berhenti dan menunggu operator.
   *
   * Ini state tersendiri, bukan sekadar flag, karena alasan berikut: kalau
   * kegagalan hanya "ditahan di countdown", pemulihan sinyal akan otomatis
   * mencoba lagi — dan kalau device-nya memang rusak, itu jadi loop tak
   * berujung yang menguras CPU dan membuat UI berkedip. Dengan state ini,
   * `signal: ok` tidak lagi memicu percobaan baru; hanya operator yang bisa.
   */
  | "stalled";

export interface SessionConfig {
  /** Jumlah frame per sesi. */
  shotCount: number;
  /** Countdown sebelum tiap jepretan, ms. 0 = countdown mati. */
  countdownMs: number;
  /** Jeda setelah jepretan sebelum shot berikutnya, ms. 0 = langsung. */
  intervalMs: number;
  /**
   * Berapa lama layar review menahan sebelum lanjut sendiri, ms.
   * `0` = tunggu operator (default) — tamu tidak dipaksa buru-buru.
   */
  reviewMs: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  shotCount: 4,
  countdownMs: 3000,
  intervalMs: 1200,
  reviewMs: 0,
};

/**
 * Batas percobaan otomatis sebelum sesi masuk `stalled`.
 *
 * Tiga, bukan tak terbatas: satu kegagalan itu normal (device sibuk sesaat),
 * tiga kegagalan berturut-turut hampir selalu berarti kabel/sinyal, dan
 * mencoba terus hanya membuat operator menunggu tanpa hasil.
 */
export const MAX_AUTO_RETRIES = 3;

/** Kenapa kita sedang menunggu — supaya UI bisa menampilkan angka yang benar. */
export type WaitKind = "countdown" | "interval" | "review";

export interface SessionSnapshot {
  state: SessionState;
  /** Kondisi sinyal, terpisah dari state — lihat catatan di atas. */
  signal: SignalState;
  config: SessionConfig;
  /** Slot yang sedang diisi / akan diisi berikutnya. */
  shotIndex: number;
  /** Id frame per slot; `null` = slot belum terisi. Panjangnya = `shotCount`. */
  frames: readonly (string | null)[];
  /** Sisa waktu tunggu dalam ms (relevan saat `state === "countdown"`). */
  waitRemainingMs: number;
  waitKind: WaitKind;
  /** Device yang tersambung, atau `null`. */
  deviceId: string | null;
  /** Error terakhir yang belum di-acknowledge. */
  error: CaptureErrorCode | null;
  /** Kegagalan jepret berturut-turut sejak keberhasilan terakhir. */
  failures: number;
}

export type SessionEvent =
  | { type: "arm"; deviceId: string; config?: Partial<SessionConfig> }
  | { type: "disarm" }
  | { type: "begin" }
  | { type: "tick"; elapsedMs: number }
  | { type: "frame-captured"; id: string }
  | { type: "retake"; index: number }
  | { type: "accept" }
  | { type: "processed" }
  | { type: "reset" }
  | { type: "fail"; code: CaptureErrorCode }
  | { type: "capture-failed"; code: CaptureErrorCode }
  | { type: "resume" }
  | { type: "restore"; frames: readonly (string | null)[] }
  | { type: "signal"; signal: SignalState }
  | { type: "config"; config: Partial<SessionConfig> }
  | { type: "device"; deviceId: string | null };

export function initialSnapshot(
  config: SessionConfig = DEFAULT_SESSION_CONFIG,
): SessionSnapshot {
  return {
    state: "idle",
    signal: "unknown",
    config: normalizeConfig(config),
    shotIndex: 0,
    frames: emptyFrames(config.shotCount),
    waitRemainingMs: 0,
    waitKind: "countdown",
    deviceId: null,
    error: null,
    failures: 0,
  };
}

export function normalizeConfig(config: SessionConfig): SessionConfig {
  return {
    shotCount: clampInt(config.shotCount, 1, 12),
    countdownMs: clampInt(config.countdownMs, 0, 60_000),
    intervalMs: clampInt(config.intervalMs, 0, 60_000),
    reviewMs: clampInt(config.reviewMs, 0, 60_000),
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function emptyFrames(shotCount: number): (string | null)[] {
  return Array.from({ length: clampInt(shotCount, 1, 12) }, () => null);
}

/** Ganti satu slot tanpa memutasi array lama. */
export function setSlot(
  frames: readonly (string | null)[],
  index: number,
  id: string | null,
): (string | null)[] {
  return frames.map((existing, i) => (i === index ? id : existing));
}

export function capturedCount(frames: readonly (string | null)[]): number {
  return frames.reduce((total, id) => (id === null ? total : total + 1), 0);
}

export function allCaptured(frames: readonly (string | null)[]): boolean {
  return frames.length > 0 && frames.every((id) => id !== null);
}

/** Waktu tunggu yang dibutuhkan untuk masuk ke sebuah slot. */
function waitFor(snapshot: SessionSnapshot, kind: WaitKind): number {
  if (kind === "countdown") return snapshot.config.countdownMs;
  if (kind === "interval") return snapshot.config.intervalMs;
  return snapshot.config.reviewMs;
}

/**
 * Masuk ke layar review.
 *
 * `reviewMs = 0` (default) berarti operator yang memutuskan; angka > 0 membuat
 * review lanjut sendiri — dipakai di mode kiosk yang harus berjalan tanpa
 * petugas.
 */
function enterReview(snapshot: SessionSnapshot, frames: readonly (string | null)[]): SessionSnapshot {
  const wait = snapshot.config.reviewMs;

  return {
    ...snapshot,
    frames: [...frames],
    state: "review",
    shotIndex: frames.length - 1,
    waitRemainingMs: wait,
    waitKind: "review",
    error: null,
    failures: 0,
  };
}

/** Masuk ke slot `index`: mulai countdown, atau langsung capturing kalau 0. */
function enterSlot(snapshot: SessionSnapshot, index: number, kind: WaitKind): SessionSnapshot {
  const wait = waitFor(snapshot, kind);

  if (wait <= 0) {
    return {
      ...snapshot,
      state: "capturing",
      shotIndex: index,
      waitRemainingMs: 0,
      waitKind: kind,
      error: null,
    };
  }

  return {
    ...snapshot,
    state: "countdown",
    shotIndex: index,
    waitRemainingMs: wait,
    waitKind: kind,
    error: null,
  };
}

/**
 * Transisi utama. Total — setiap kombinasi state × event punya jawaban, dan
 * event yang tidak masuk akal **diabaikan** (mengembalikan snapshot yang sama)
 * alih-alih melempar. Sesi kamera tidak boleh mati karena UI mengirim `accept`
 * dua kali.
 */
export function reduceSession(
  snapshot: SessionSnapshot,
  event: SessionEvent,
): SessionSnapshot {
  switch (event.type) {
    // ── konfigurasi & device: boleh kapan saja ─────────────────────────
    case "config": {
      const config = normalizeConfig({ ...snapshot.config, ...event.config });
      // `shotCount` berubah → bentuk ulang daftar slot, pertahankan isi lama.
      const frames =
        config.shotCount === snapshot.frames.length
          ? snapshot.frames
          : Array.from({ length: config.shotCount }, (_, i) => snapshot.frames[i] ?? null);

      return { ...snapshot, config, frames };
    }

    case "device":
      return { ...snapshot, deviceId: event.deviceId };

    case "signal": {
      const next = { ...snapshot, signal: event.signal };

      // Auto-recover: countdown sudah habis tapi tertahan karena sinyal hilang
      // → lanjut jepret sekarang tanpa perlu aksi operator.
      if (
        event.signal === "ok" &&
        next.state === "countdown" &&
        next.waitRemainingMs <= 0
      ) {
        return { ...next, state: "capturing" };
      }

      return next;
    }

    case "fail":
      return { ...snapshot, state: "idle", error: event.code, waitRemainingMs: 0 };

    // ── alur utama ─────────────────────────────────────────────────────
    case "arm": {
      const config = event.config === undefined
        ? snapshot.config
        : normalizeConfig({ ...snapshot.config, ...event.config });

      // Frame hasil `restore` harus selamat. Operator yang menyambung sesi
      // setelah refresh **tidak boleh** menghapus pose yang sudah diambil
      // tamu — itu justru alasan frame disimpan di IndexedDB sejak awal.
      // Daftar slot hanya dibentuk ulang kalau `shotCount` memang berubah.
      const frames =
        config.shotCount === snapshot.frames.length
          ? snapshot.frames
          : Array.from({ length: config.shotCount }, (_, i) => snapshot.frames[i] ?? null);
      const firstEmpty = frames.findIndex((id) => id === null);

      return {
        ...snapshot,
        config,
        frames,
        state: "armed",
        deviceId: event.deviceId,
        shotIndex: firstEmpty === -1 ? 0 : firstEmpty,
        waitRemainingMs: 0,
        waitKind: "countdown",
        error: null,
        failures: 0,
      };
    }

    case "disarm":
      return snapshot.state === "armed" || snapshot.state === "review"
        ? { ...snapshot, state: "idle", waitRemainingMs: 0 }
        : snapshot;

    case "begin": {
      if (snapshot.state !== "armed") return snapshot;

      // Mulai dari slot kosong pertama — bukan selalu 0. Sesi yang disambung
      // setelah refresh sudah punya pose terisi, dan menimpanya berarti tamu
      // kehilangan foto yang sudah diambil.
      const firstEmpty = snapshot.frames.findIndex((id) => id === null);
      return enterSlot(snapshot, firstEmpty === -1 ? 0 : firstEmpty, "countdown");
    }

    case "tick": {
      // Review dengan timer (kiosk): hitung mundur, lalu lanjut sendiri.
      if (snapshot.state === "review") {
        if (snapshot.config.reviewMs <= 0) return snapshot;
        const left = snapshot.waitRemainingMs - Math.max(0, event.elapsedMs);
        if (left > 0) return { ...snapshot, waitRemainingMs: left };
        return allCaptured(snapshot.frames)
          ? { ...snapshot, state: "processing", waitRemainingMs: 0 }
          : { ...snapshot, waitRemainingMs: 0 };
      }

      if (snapshot.state !== "countdown") return snapshot;

      const remaining = snapshot.waitRemainingMs - Math.max(0, event.elapsedMs);

      if (remaining > 0) return { ...snapshot, waitRemainingMs: remaining };

      // Sinyal hilang → tahan di 0, jangan jepret frame hitam.
      if (snapshot.signal === "no-signal") {
        // Kembalikan snapshot yang **sama** kalau sudah 0: tick tetap
        // berjalan tiap 100 ms, dan membuat objek baru tiap kali berarti
        // UI ikut re-render 10×/detik selama kabel dicabut.
        return snapshot.waitRemainingMs === 0 ? snapshot : { ...snapshot, waitRemainingMs: 0 };
      }

      return { ...snapshot, state: "capturing", waitRemainingMs: 0 };
    }

    case "frame-captured": {
      if (snapshot.state !== "capturing") return snapshot;

      const frames = setSlot(snapshot.frames, snapshot.shotIndex, event.id);
      const isLast = snapshot.shotIndex >= snapshot.config.shotCount - 1;

      if (isLast) {
        return enterReview(snapshot, frames);
      }

      // Masih ada shot berikutnya: jeda sebentar, lalu lanjut.
      return enterSlot({ ...snapshot, frames, failures: 0 }, snapshot.shotIndex + 1, "interval");
    }

    /**
     * Jepretan gagal. Satu-dua kali itu wajar (device sibuk sesaat) → ulangi
     * setelah countdown baru. Setelah `MAX_AUTO_RETRIES` → `stalled`, supaya
     * tidak ada loop retry tak berujung.
     *
     * Sengaja **tidak** menyentuh `signal`: kegagalan jepret belum tentu soal
     * sinyal (bisa `device-busy`), dan kalau sinyalnya memang sehat, monitor
     * tidak akan pernah memancarkan `ok` lagi — sesi akan macet selamanya.
     */
    case "capture-failed": {
      if (snapshot.state !== "capturing") return snapshot;

      const failures = snapshot.failures + 1;

      if (failures >= MAX_AUTO_RETRIES) {
        return { ...snapshot, failures, state: "stalled", waitRemainingMs: 0, error: event.code };
      }

      // Jeda ini yang mencegah loop rapat, sekaligus memberi tamu hitungan baru.
      return {
        ...snapshot,
        failures,
        state: "countdown",
        waitRemainingMs: snapshot.config.countdownMs,
        waitKind: "countdown",
        error: event.code,
      };
    }

    /** Operator menekan "coba lagi" setelah `stalled`. */
    case "resume":
      return snapshot.state === "stalled"
        ? {
            ...snapshot,
            state: "countdown",
            waitRemainingMs: snapshot.config.countdownMs,
            waitKind: "countdown",
            failures: 0,
            error: null,
          }
        : snapshot;

    case "retake": {
      if (snapshot.state !== "review") return snapshot;
      if (event.index < 0 || event.index >= snapshot.frames.length) return snapshot;

      // Kosongkan slot itu, lalu ambil ulang — slot lain tidak tersentuh.
      return enterSlot(
        { ...snapshot, frames: setSlot(snapshot.frames, event.index, null), failures: 0 },
        event.index,
        "countdown",
      );
    }

    case "accept":
      return snapshot.state === "review" && allCaptured(snapshot.frames)
        ? { ...snapshot, state: "processing" }
        : snapshot;

    case "processed":
      return snapshot.state === "processing" ? { ...snapshot, state: "composed" } : snapshot;

    /**
     * Pulihkan slot dari penyimpanan (mis. habis refresh).
     *
     * Kalau semua slot terisi, langsung masuk `review` — operator tidak perlu
     * mengulang sesi hanya karena browser di-refresh.
     */
    case "restore": {
      if (snapshot.state !== "idle") return snapshot;

      const frames = Array.from(
        { length: snapshot.config.shotCount },
        (_, i) => event.frames[i] ?? null,
      );
      const firstEmpty = frames.findIndex((id) => id === null);

      if (allCaptured(frames)) {
        return enterReview(snapshot, frames);
      }

      return {
        ...snapshot,
        frames,
        state: "idle",
        shotIndex: firstEmpty === -1 ? frames.length - 1 : firstEmpty,
      };
    }

    case "reset":
      return {
        ...initialSnapshot(snapshot.config),
        deviceId: snapshot.deviceId,
        signal: snapshot.signal,
      };
  }
}

/** Apakah state ini sedang menunggu timer (untuk mengaktifkan `tick`). */
export function isWaiting(state: SessionState): boolean {
  return state === "countdown";
}

/** Apakah operator boleh menekan tombol jepret sekarang. */
export function canShoot(state: SessionState): boolean {
  return state === "armed" || state === "capturing";
}
