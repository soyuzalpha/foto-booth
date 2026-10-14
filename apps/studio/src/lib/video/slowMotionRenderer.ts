/**
 * Adapter DOM: ubah klip hasil rekaman jadi klip **slow-mo** sungguhan.
 *
 * Kenapa perlu berkas sendiri: perlambatan bukan "putar berkasnya pelan-pelan".
 * Berkasnya sama, pemutarnya yang mengubah kecepatan — dan sebagian pemutar
 * ponsel mengabaikan metadata kecepatan. Yang dikirim ke tamu harus **berkas
 * baru** dengan durasi lebih panjang, jadi frame keluaran digambar ulang ke
 * kanvas lalu direkam.
 *
 * Pembagian tugasnya sama seperti `sequenceRenderer.ts`:
 *
 *   · **urutan & waktu** → `slowMotion.ts` (murni, teruji);
 *   · **piksel** → di sini, lewat kanvas + `MediaRecorder`.
 *
 * Dua aturan yang dijaga:
 *
 *   · **Frame yang gagal diambil ditahan, bukan dibatalkan.** Klip slow-mo yang
 *     sedikit tersendat masih jauh lebih baik daripada tidak ada klip.
 *   · **Gagal = `Blob` (mungkin kosong), bukan lemparan.** Pemanggil memeriksa
 *     `size`, sama seperti `recorder.ts`.
 */

import type { FilterDeps } from "../filters/applyFilters.ts";
import { browserFilterDeps } from "../filters/applyFilters.ts";
import { createModelCache, type ModelCache } from "../models/modelCache.ts";
import type { FrameInterpolator, SourceFrame } from "./interpolation.ts";
import type { RecorderLike } from "./recorder.ts";
import { createBlendInterpolator, createRifeInterpolator } from "./rife.ts";
import { drawFrame, type StreamableCanvas } from "./sequenceRenderer.ts";
import { retimeTimeline, type RetimedStep } from "./slowMotion.ts";
import type { SlowMoFactor } from "./types.ts";

/** Frame sumber yang sudah punya piksel. */
export interface SlowMoSourceFrame extends SourceFrame {
  /** Waktu frame ini di klip sumber, detik. */
  atSec: number;
}

export interface SlowMoOptions {
  width: number;
  height: number;
  /** Jumlah frame di klip sumber. */
  sourceFrameCount: number;
  /** Durasi klip sumber, detik. */
  sourceDurationSec: number;
  factor: SlowMoFactor;
  /** fps berkas keluaran. */
  fps: number;
  bitrateBps: number;
  mimeType: string | null;
  /** Nomor urut klip (untuk penamaan berkas). */
  index?: number;
}

export interface SlowMoPlan {
  width: number;
  height: number;
  fps: number;
  /** Jumlah frame keluaran (lebih banyak daripada sumber). */
  frameCount: number;
  /** Perkiraan durasi keluaran, detik — sudah diperpanjang faktor. */
  durationSec: number;
  extension: "mp4" | "webm";
  contentType: string;
  filename: string;
  factor: SlowMoFactor;
}

/**
 * Nama berkas klip slow-mo.
 *
 * Diberi akhiran `-slowmo` supaya tidak menimpa klip aslinya di folder arsip
 * yang sama — operator yang ingin membandingkan dua-duanya masih bisa.
 */
export function slowMoFilename(index: number, extension: "mp4" | "webm"): string {
  return `video-${String(index + 1).padStart(2, "0")}-slowmo.${extension}`;
}

/** Hitung rencana keluaran tanpa menyentuh piksel — murni, teruji. */
export function planSlowMo(options: SlowMoOptions): SlowMoPlan {
  const extension: "mp4" | "webm" =
    options.mimeType !== null && options.mimeType.includes("mp4") ? "mp4" : "webm";
  const steps = retimeTimeline(options.sourceFrameCount, options.factor, options.fps);
  const fps = options.fps > 0 ? options.fps : 30;

  return {
    width: options.width,
    height: options.height,
    fps,
    frameCount: steps.length,
    durationSec: steps.length / fps,
    extension,
    contentType: extension === "mp4" ? "video/mp4" : "video/webm",
    filename: slowMoFilename(options.index ?? 0, extension),
    factor: options.factor,
  };
}

export interface SlowMoDeps {
  createCanvas(width: number, height: number): StreamableCanvas;
  createRecorder(
    stream: MediaStream,
    options: { mimeType?: string; videoBitsPerSecond?: number },
  ): RecorderLike;
  /** Tunda antar frame; disuntik supaya tes bebas timer nyata. */
  wait(ms: number): Promise<void>;
  /**
   * Ambil frame sumber ke-`index` (dekode dari klip). `null` = frame itu tidak
   * bisa diambil; frame sebelumnya yang ditahan.
   */
  frame(index: number): Promise<SlowMoSourceFrame | null>;
  /** Sintesis frame antara `a` dan `b`. Tidak ada = frame `a` ditahan. */
  interpolate?: (a: SlowMoSourceFrame, b: SlowMoSourceFrame, mix: number) => Promise<unknown | null>;
  /** Warna latar kanvas keluaran. */
  background?: string;
}

export interface SlowMoResult {
  blob: Blob;
  /** Jumlah frame yang benar-benar digambar. */
  drawn: number;
  steps: RetimedStep[];
  plan: SlowMoPlan;
}

/**
 * Render klip slow-mo.
 *
 * Frame sumber diambil **hanya sekali** per indeks (di-cache): klip 60 frame
 * pada faktor 0,25 punya 240 frame keluaran, dan mendekode ulang frame yang
 * sama 4 kali akan membuat kiosk tersendat tanpa alasan.
 */
export async function renderSlowMotion(
  deps: SlowMoDeps,
  options: SlowMoOptions,
): Promise<SlowMoResult> {
  const plan = planSlowMo(options);
  const steps = retimeTimeline(options.sourceFrameCount, options.factor, plan.fps);
  const background = deps.background ?? "#000000";
  const size = { width: plan.width, height: plan.height };
  const canvas = deps.createCanvas(size.width, size.height);

  const chunks: Blob[] = [];
  let recorder: RecorderLike | null = null;

  try {
    if (typeof canvas.captureStream === "function") {
      const stream = canvas.captureStream(plan.fps);
      const recorderOptions: { mimeType?: string; videoBitsPerSecond?: number } = {
        videoBitsPerSecond: options.bitrateBps,
      };
      if (options.mimeType !== null) recorderOptions.mimeType = options.mimeType;
      recorder = deps.createRecorder(stream, recorderOptions);
      recorder.ondataavailable = (event) => {
        if (event.data !== undefined && event.data.size > 0) chunks.push(event.data);
      };
      recorder.start();
    }
  } catch {
    recorder = null;
  }

  const cache = new Map<number, SlowMoSourceFrame | null>();
  let drawn = 0;
  let held: SlowMoSourceFrame | null = null;

  async function sourceAt(index: number): Promise<SlowMoSourceFrame | null> {
    if (cache.has(index)) return cache.get(index) ?? null;
    const frame = await deps.frame(index);
    cache.set(index, frame);
    return frame;
  }

  try {
    for (const step of steps) {
      const from = await sourceAt(step.fromIndex);
      if (from !== null) held = from;

      let image: unknown = from?.image ?? held?.image ?? null;
      if (from !== null && step.mix > 0 && deps.interpolate !== undefined) {
        const to = await sourceAt(step.toIndex);
        if (to !== null) {
          const mixed = await deps.interpolate(from, to, step.mix);
          if (mixed !== null) image = mixed;
        }
      }

      if (image !== null) {
        if (drawFrame(canvas, image, background, size)) drawn += 1;
      }

      await deps.wait(Math.max(1, Math.round(1000 / plan.fps)));
    }
  } catch {
    // Kegagalan di tengah rekaman bukan alasan kehilangan hasil: apa yang sudah
    // tergambar tetap direkam di bawah ini.
  }

  const blob = await stopRecorder(recorder, chunks, plan.contentType);
  return { blob, drawn, steps, plan };
}

/** Hentikan perekam dan tunggu `onstop`; `chunks` dipakai kalau tidak ada. */
function stopRecorder(
  recorder: RecorderLike | null,
  chunks: Blob[],
  contentType: string,
): Promise<Blob> {
  if (recorder === null) return Promise.resolve(new Blob(chunks, { type: contentType }));

  return new Promise<Blob>((resolve) => {
    const finish = (): void => resolve(new Blob(chunks, { type: contentType }));
    try {
      recorder.onstop = finish;
      recorder.onerror = finish;
      recorder.stop();
    } catch {
      finish();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Adapter browser
 * ------------------------------------------------------------------ */

export interface BrowserSlowMoOptions {
  /** Klip sumber. */
  blob: Blob;
  /** fps sumber — dipakai menghitung waktu frame ke-`index`. */
  sourceFps: number;
  /** Batas tunggu satu tahap, milidetik. */
  timeoutMs?: number;
  /** Dependensi kanvas/decode. Default: browser. */
  filterDeps?: FilterDeps;
  /** Cache model untuk RIFE. Default: `createModelCache()`. */
  cache?: ModelCache | null;
  /** Pakai RIFE kalau modelnya tersedia. Default: ya (fallback ke blend). */
  rife?: boolean;
}

const DEFAULT_SEEK_TIMEOUT_MS = 4000;

/**
 * Dependensi browser untuk `renderSlowMotion`.
 *
 * Frame sumber diambil dengan men-`seek` elemen `<video>`: browser tidak punya
 * API "frame ke-N", jadi waktu frame dihitung dari `index / fps`. Seek yang
 * tidak selesai dalam batas waktu **tidak menggantung** — hasilnya `null`, dan
 * frame sebelumnya yang ditahan.
 */
export function browserSlowMoDeps(
  options: BrowserSlowMoOptions,
): SlowMoDeps & { dispose(): void } {
  const deps = options.filterDeps ?? browserFilterDeps();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEEK_TIMEOUT_MS;
  const url = URL.createObjectURL(options.blob);

  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.setAttribute("playsinline", "");
  video.src = url;

  const ready = new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => done(false), timeoutMs);
    function done(ok: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMeta);
      resolve(ok);
    }
    function onMeta(): void {
      done(true);
    }
    video.addEventListener("loadedmetadata", onMeta, { once: true });
    video.load();
  });

  // Interpolasi: RIFE kalau modelnya siap, pencampuran kalau tidak. Dipilih
  // **per frame** — bukan sekali di awal — supaya model yang baru ter-cache di
  // tengah render ikut terpakai, dan tidak ada frame yang batal karena runtime
  // belum termuat.
  const blend = createBlendInterpolator(deps);
  const rife =
    options.rife === false
      ? null
      : createRifeInterpolator({ cache: options.cache ?? createModelCache(), deps });

  async function seekTo(atSec: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => done(false), timeoutMs);
      function done(ok: boolean): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener("seeked", onSeeked);
        resolve(ok);
      }
      function onSeeked(): void {
        done(true);
      }
      // Pendengar dipasang **sebelum** `currentTime` diubah: seek yang selesai
      // sangat cepat (berkas kecil, sudah di cache) bisa memicu `seeked`
      // sebelum pendengarnya ada.
      video.addEventListener("seeked", onSeeked, { once: true });
      video.currentTime = Math.max(0, atSec);
    });
  }

  return {
    createCanvas: (width, height) => deps.createCanvas(width, height) as unknown as StreamableCanvas,
    createRecorder: (stream, recorderOptions) =>
      new MediaRecorder(stream, recorderOptions) as unknown as RecorderLike,
    wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),

    async frame(index: number): Promise<SlowMoSourceFrame | null> {
      if (!(await ready)) return null;
      const atSec = index / Math.max(1, options.sourceFps);
      if (!(await seekTo(atSec))) return null;
      if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;
      return {
        index,
        atSec,
        image: video,
        width: video.videoWidth,
        height: video.videoHeight,
      };
    },

    async interpolate(a: SlowMoSourceFrame, b: SlowMoSourceFrame, mix: number): Promise<unknown | null> {
      if (rife !== null) {
        const synthesised: FrameInterpolator = rife;
        const out = await synthesised.interpolate(a, b, mix);
        if (out !== null) return out;
      }
      return blend.interpolate(a, b, mix);
    },

    dispose(): void {
      rife?.dispose();
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
    },
  };
}
