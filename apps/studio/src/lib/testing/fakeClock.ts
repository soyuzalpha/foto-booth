/**
 * Jam & timer palsu untuk tes.
 *
 * Countdown nyata butuh detik; tes tidak boleh. Dengan jam ini, `advance(5000)`
 * menjalankan semua timer yang jatuh tempo **dan** memindahkan waktu, jadi
 * `now()` di dalam `CaptureSession` konsisten dengan timer yang menyala.
 * Tanpa ini, `elapsedMs` akan selalu 0 dan countdown tidak pernah selesai.
 */

interface FakeTimer {
  id: number;
  due: number;
  fn: () => void;
}

export interface FakeClock {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
  /** Majukan waktu, jalankan timer yang jatuh tempo (termasuk yang baru dibuat). */
  advance(ms: number): void;
  pending(): number;
}

export function createFakeClock(start = 0): FakeClock {
  let time = start;
  let nextId = 1;
  const timers = new Map<number, FakeTimer>();

  const now = (): number => time;

  const setTimer = (fn: () => void, ms: number): (() => void) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { id, due: time + Math.max(0, ms), fn });
    return () => {
      timers.delete(id);
    };
  };

  /** Jalankan timer yang jatuh tempo pada waktu sekarang, sampai tidak ada lagi. */
  const runDue = (): void => {
    // Batas iterasi: jaring pengaman kalau ada timer yang menjadwalkan dirinya
    // sendiri dengan delay 0 (tidak terjadi di kode produksi, tapi tes jangan
    // sampai menggantung).
    for (let guard = 0; guard < 10_000; guard += 1) {
      let earliest: FakeTimer | null = null;

      for (const timer of timers.values()) {
        if (timer.due > time) continue;
        if (
          earliest === null ||
          timer.due < earliest.due ||
          (timer.due === earliest.due && timer.id < earliest.id)
        ) {
          earliest = timer;
        }
      }

      if (earliest === null) return;

      timers.delete(earliest.id);
      earliest.fn();
    }

    throw new Error("FakeClock: terlalu banyak timer — kemungkinan loop tak terbatas");
  };

  const advance = (ms: number): void => {
    const target = time + ms;

    for (let guard = 0; guard < 10_000; guard += 1) {
      let nextDue: number | null = null;

      for (const timer of timers.values()) {
        if (timer.due > target) continue;
        if (nextDue === null || timer.due < nextDue) nextDue = timer.due;
      }

      if (nextDue === null) break;

      time = Math.max(time, nextDue);
      runDue();
    }

    time = target;
    runDue();
  };

  return { now, setTimer, advance, pending: () => timers.size };
}

/** Biarkan microtask `async` selesai (transport palsu menyelesaikan segera). */
export async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
