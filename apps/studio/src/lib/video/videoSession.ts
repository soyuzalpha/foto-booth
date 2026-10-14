/**
 * Sesi rekam video — perekat antara rencana (`plan.ts`) dan perekam (`recorder.ts`).
 *
 * Yang dijaga di sini:
 *
 *   · **Rencana dulu, baru rekam.** Setelan bisa berubah kapan saja; yang
 *     dipakai adalah rencana yang dihitung saat `start()`, bukan saat panel
 *     dirender. Kalau operator mengubah resolusi setelah mulai, rekaman yang
 *     sedang jalan tidak berubah — dan itu memang benar.
 *   · **Tanpa format yang didukung = tidak mulai.** `planIsRunnable` diperiksa
 *     lebih dulu, jadi UI tidak pernah menampilkan "merekam" untuk rekaman yang
 *     tidak akan menghasilkan berkas.
 *   · **Kegagalan tidak melempar ke UI.** `stop()` selalu mengembalikan klip
 *     (mungkin `blob.size === 0`); pemanggil memeriksa ukurannya.
 */

import { resolveVideoPlan, type PlanOptions, type VideoPlan } from "./plan.ts";
import { createVideoRecorder, type RecorderDeps, type VideoRecorder } from "./recorder.ts";
import { videoFilename } from "./naming.ts";
import type { VideoSettings } from "./types.ts";

export interface VideoClip {
  blob: Blob;
  width: number;
  height: number;
  /** Durasi keluaran yang diharapkan, detik. */
  durationSec: number;
  extension: "mp4" | "webm";
  contentType: string;
  filename: string;
  index: number;
}

export interface VideoSessionDeps extends RecorderDeps {
  now?: () => Date;
}

export interface VideoSessionOptions {
  settings: VideoSettings;
  /** Sumber stream. `null` = tidak ada kamera → `start()` menolak. */
  stream: MediaStream | null;
  /** Nomor urut klip dalam sesi (untuk penamaan berkas). */
  index?: number;
  /** Dukungan format; disuntik (`MediaRecorder.isTypeSupported`). */
  isSupported: (mimeType: string) => boolean;
  /** Durasi rekaman yang akan datang, detik. Default: batas setelan. */
  sourceDurationSec?: number;
}

export interface VideoSession {
  /** Rencana yang dipakai klip ini — `null` kalau tidak bisa direkam. */
  plan(): VideoPlan | null;
  /** Mulai merekam. Mengembalikan `false` kalau tidak bisa dimulai. */
  start(): boolean;
  /** Hentikan & kembalikan klip. `null` = tidak ada rekaman. */
  stop(): Promise<VideoClip | null>;
  readonly recording: boolean;
}

export function createVideoSession(deps: VideoSessionDeps, options: VideoSessionOptions): VideoSession {
  const index = options.index ?? 0;
  const planOptions: PlanOptions = { isSupported: options.isSupported };
  if (options.sourceDurationSec !== undefined) planOptions.sourceDurationSec = options.sourceDurationSec;

  const plan = resolveVideoPlan(options.settings, planOptions);
  let recorder: VideoRecorder | null = null;
  let started = false;

  return {
    plan(): VideoPlan | null {
      return plan.mimeType === null ? null : plan;
    },

    start(): boolean {
      if (started) return false;
      if (options.stream === null) return false;
      if (plan.mimeType === null) return false;

      const recorderOptions: Parameters<typeof createVideoRecorder>[1] = {
        stream: options.stream,
        mimeType: plan.mimeType,
        bitrateBps: plan.bitrateBps,
        audioBitrateBps: plan.audioBitrateBps,
      };
      if (plan.maxDurationSec > 0) recorderOptions.maxDurationMs = plan.maxDurationSec * 1000;

      recorder = createVideoRecorder(deps, recorderOptions);
      recorder.start();
      started = true;
      return true;
    },

    async stop(): Promise<VideoClip | null> {
      if (recorder === null) return null;
      const blob = await recorder.stop();
      return {
        blob,
        width: plan.width,
        height: plan.height,
        durationSec: plan.expectedDurationSec,
        extension: plan.extension,
        contentType: plan.contentType,
        filename: videoFilename(index, plan.extension),
        index,
      };
    },

    get recording(): boolean {
      return recorder?.recording ?? false;
    },
  };
}

/** Apakah klip ini punya byte yang layak dikirim ke tamu. */
export function clipHasContent(clip: VideoClip): boolean {
  return clip.blob.size > 0;
}
