/**
 * Jembatan React ↔ mesin video (Fase 7).
 *
 * Sama perannya dengan `useFilterSettings` untuk foto: hook ini **tidak
 * menambah aturan**. Semua keputusan ("format apa", "berapa bitrate", "frame
 * mana yang perlu disintesis") sudah ada di `plan.ts`, `codec.ts`,
 * `slowMotion.ts`. Yang dikerjakan di sini cuma empat hal:
 *
 *   1. **Pengaturan** dibaca dari localStorage sekali, disimpan tiap berubah —
 *      kiosk dijalankan orang yang sama terus, menyetel ulang tiap sesi itu
 *      pekerjaan yang tidak perlu.
 *   2. **Satu sesi rekam pada satu waktu.** `start` saat masih merekam
 *      diabaikan, dan batas durasi dari rencana tetap dipasang sebagai timer
 *      supaya rekaman tidak jalan sampai disk penuh walau tamu meninggalkan
 *      kiosk.
 *   3. **Klip jadi berkas + masuk antrian.** Setelah `stop()`, klip dikirim ke
 *      jalur simpan yang sama dengan foto (`onClip` → arsip lokal + upload).
 *      Klip tanpa byte tidak pernah masuk.
 *   4. **Slow-mo dikerjakan setelah rekaman**, bukan saat merekam: yang dikirim
 *      ke tamu harus berkas baru berdurasi panjang, bukan berkas yang sama
 *      dengan metadata kecepatan (sebagian pemutar ponsel mengabaikannya).
 *
 * Kegagalan apa pun berakhir jadi `error` yang bisa dibaca operator — tidak ada
 * lemparan ke React.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deviceStorage } from "../capture/rememberedDevice.ts";
import { browserFilterDeps } from "../filters/applyFilters.ts";
import type { IntakePhoto } from "../upload/photoIntake.ts";
import { animationFilename } from "./naming.ts";
import { describePlan, planIsRunnable, resolveVideoPlan, type VideoPlan } from "./plan.ts";
import { browserRecorderDeps } from "./recorder.ts";
import { browserSequenceDeps, renderAnimation } from "./sequenceRenderer.ts";
import { browserSlowMoDeps, renderSlowMotion } from "./slowMotionRenderer.ts";
import { DEFAULT_VIDEO_SETTINGS, type VideoAnimationKind, type VideoSettings } from "./types.ts";
import { clipToIntake, decodeFrames, describeClip } from "./videoIntake.ts";
import { clipHasContent, createVideoSession, type VideoClip } from "./videoSession.ts";
import { browserVideoThumbDeps, makeVideoThumb } from "./videoThumb.ts";
import { normalizeVideoSettings, readVideoSettings, writeVideoSettings } from "./videoSettingsStore.ts";

/** Satu klip yang sudah jadi, siap ditampilkan. */
export interface VideoClipView {
  id: string;
  /** Object URL untuk pratinjau. Dibuang saat daftar dikosongkan/unmount. */
  url: string;
  filename: string;
  bytes: number;
  width: number;
  height: number;
  durationSec: number;
  contentType: string;
  /** Ringkasan siap-tampil: nama · ukuran · durasi · MB. */
  summary: string;
}

export interface UseVideoSessionOptions {
  /** Stream kamera aktif. `null` = belum tersambung → merekam tidak mungkin. */
  stream: MediaStream | null;
  /** Foto sesi (byte asli) — bahan animasi slideshow/boomerang. */
  frames?: readonly Blob[];
  /** Simpan klip ke arsip lokal + antrian upload. */
  onClip?: (photo: IntakePhoto) => Promise<void> | void;
  /** Dukungan format; default `MediaRecorder.isTypeSupported`. */
  isSupported?: (mimeType: string) => boolean;
  now?: () => number;
}

export interface VideoSessionHandle {
  settings: VideoSettings;
  update(patch: Partial<VideoSettings>): void;
  reset(): void;
  /** Rencana rekaman; `null` = tidak ada format yang didukung. */
  plan: VideoPlan | null;
  /** Ringkasan satu baris untuk UI. */
  summary: string | null;
  canRecord: boolean;
  recording: boolean;
  /** Sedang ada pekerjaan berat (render animasi / slow-mo). */
  busy: boolean;
  clips: VideoClipView[];
  error: string | null;
  startRecording(): void;
  stopRecording(): Promise<void>;
  /** Render slideshow/boomerang dari foto sesi, lalu simpan. */
  renderAnimationClip(kind?: VideoAnimationKind): Promise<void>;
  clearClips(): void;
}

/** Dukungan format default: `MediaRecorder.isTypeSupported` kalau ada. */
function defaultIsSupported(mimeType: string): boolean {
  if (typeof MediaRecorder === "undefined") return false;
  try {
    return MediaRecorder.isTypeSupported(mimeType);
  } catch {
    return false;
  }
}

function browserThumb(blob: Blob): Promise<Blob | null> {
  return makeVideoThumb(blob, browserVideoThumbDeps());
}

function newClipId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `clip_${crypto.randomUUID()}`;
  }
  return `clip_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function useVideoSession(options: UseVideoSessionOptions = { stream: null }): VideoSessionHandle {
  const frames = useMemo(() => options.frames ?? [], [options.frames]);
  const isSupported = useMemo(
    () => options.isSupported ?? defaultIsSupported,
    [options.isSupported],
  );

  const [settings, setSettings] = useState<VideoSettings>(() =>
    readVideoSettings(typeof localStorage === "undefined" ? null : deviceStorage()),
  );
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clips, setClips] = useState<VideoClipView[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Sesi rekam yang sedang jalan. Ref, bukan state: nilainya dibaca dari
  // callback timer/`stop`, dan menyalinnya ke state cuma menambah render.
  const sessionRef = useRef<ReturnType<typeof createVideoSession> | null>(null);
  const cancelLimit = useRef<(() => void) | null>(null);
  const startedAt = useRef(0);
  const urls = useRef(new Map<string, string>());

  // Simpan tiap berubah; gagal simpan bukan alasan menghentikan alur.
  useEffect(() => {
    writeVideoSettings(typeof localStorage === "undefined" ? null : deviceStorage(), settings);
  }, [settings]);

  // Buang object URL klip yang sudah tidak ada, dan sisanya saat unmount.
  useEffect(() => {
    const cache = urls.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  const plan = useMemo<VideoPlan | null>(() => {
    const resolved = resolveVideoPlan(settings, {
      isSupported,
      frameCount: frames.length,
      sourceDurationSec: settings.maxDurationSec,
    });
    return planIsRunnable(resolved) ? resolved : null;
  }, [frames.length, isSupported, settings]);

  const update = useCallback((patch: Partial<VideoSettings>): void => {
    // Lewat normalisasi supaya nilai dari UI pun dijepit — bukan hanya yang
    // datang dari penyimpanan.
    setSettings((current) => normalizeVideoSettings({ ...current, ...patch }));
  }, []);

  const reset = useCallback((): void => {
    setSettings(normalizeVideoSettings(null));
  }, []);

  const clearClips = useCallback((): void => {
    const cache = urls.current;
    for (const url of cache.values()) URL.revokeObjectURL(url);
    cache.clear();
    setClips([]);
  }, []);

  /** Simpan satu klip: poster → IntakePhoto → jalur simpan. */
  const saveClip = useCallback(
    async (clip: VideoClip): Promise<boolean> => {
      const photo = await clipToIntake(clip, { makeThumb: browserThumb });
      if (photo === null) return false;

      if (options.onClip !== undefined) {
        try {
          await options.onClip(photo);
        } catch (thrown) {
          setError(thrown instanceof Error ? thrown.message : String(thrown));
          return false;
        }
      }

      const id = newClipId();
      const url = URL.createObjectURL(clip.blob);
      urls.current.set(id, url);
      setClips((current) => [
        ...current,
        {
          id,
          url,
          filename: clip.filename,
          bytes: clip.blob.size,
          width: clip.width,
          height: clip.height,
          durationSec: clip.durationSec,
          contentType: clip.contentType,
          summary: describeClip(clip),
        },
      ]);
      return true;
    },
    [options],
  );

  const stopRecording = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    sessionRef.current = null;
    cancelLimit.current?.();
    cancelLimit.current = null;
    setRecording(false);

    if (session === null) return;

    const elapsedSec = Math.max(0.1, (options.now?.() ?? Date.now()) - startedAt.current) / 1000;
    let clip = await session.stop();
    if (clip === null || !clipHasContent(clip)) {
      setError("rekaman tidak menghasilkan berkas");
      return;
    }

    // Slow-mo: berkas baru berdurasi panjang, bukan berkas yang sama dengan
    // metadata kecepatan. Sumber frame-nya dihitung dari fps kamera, karena
    // itulah yang sebenarnya tertulis di berkas hasil rekaman.
    if (settings.slowMo < 1 && plan !== null) {
      setBusy(true);
      try {
        const deps = browserSlowMoDeps({ blob: clip.blob, sourceFps: plan.captureFps });
        try {
          const sourceFrameCount = Math.max(1, Math.round(elapsedSec * plan.captureFps));
          const result = await renderSlowMotion(deps, {
            width: clip.width,
            height: clip.height,
            sourceFrameCount,
            sourceDurationSec: elapsedSec,
            factor: settings.slowMo,
            fps: plan.fps,
            bitrateBps: plan.bitrateBps,
            mimeType: plan.mimeType,
            index: clip.index,
          });
          if (result.blob.size > 0) {
            clip = {
              ...clip,
              blob: result.blob,
              durationSec: result.plan.durationSec,
              extension: result.plan.extension,
              contentType: result.plan.contentType,
              filename: result.plan.filename,
            };
          }
        } finally {
          deps.dispose();
        }
      } catch (thrown) {
        // Slow-mo gagal → klip aslinya tetap dikirim. Tamu tidak boleh pulang
        // tanpa video hanya karena interpolasi bermasalah.
        setError(thrown instanceof Error ? thrown.message : String(thrown));
      } finally {
        setBusy(false);
      }
    }

    if (!(await saveClip(clip))) {
      setError((current) => current ?? "klip tidak bisa disimpan");
    }
  }, [options, plan, saveClip, settings.slowMo]);

  const startRecording = useCallback((): void => {
    if (sessionRef.current !== null || plan === null) return;
    if (options.stream === null) {
      setError("kamera belum tersambung");
      return;
    }

    setError(null);

    // Slow-mo butuh bahan: minta kamera mengirim lebih banyak frame daripada
    // yang ditampilkan. Best-effort — kamera yang menolak tetap merekam pada
    // fps aslinya, dan hasilnya cuma kurang mulus, bukan gagal.
    if (plan.captureFps > plan.fps) {
      const track = options.stream.getVideoTracks()[0];
      void track?.applyConstraints({ frameRate: plan.captureFps }).catch(() => undefined);
    }

    const session = createVideoSession(browserRecorderDeps(), {
      settings,
      stream: options.stream,
      isSupported,
      index: clips.length,
      sourceDurationSec: settings.maxDurationSec,
    });

    if (!session.start()) {
      setError("format rekaman tidak didukung browser ini");
      return;
    }

    sessionRef.current = session;
    startedAt.current = options.now?.() ?? Date.now();
    setRecording(true);

    // Batas durasi juga dipasang di sini, bukan hanya di dalam recorder: kalau
    // `MediaRecorder` mengabaikan `maxDurationMs`, hook tetap tahu kapan harus
    // berhenti.
    const id = window.setTimeout(() => {
      void stopRecording();
    }, settings.maxDurationSec * 1000);
    cancelLimit.current = () => window.clearTimeout(id);
  }, [clips.length, isSupported, options, plan, settings, stopRecording]);

  const renderAnimationClip = useCallback(
    async (kind?: VideoAnimationKind): Promise<void> => {
      const animation = kind ?? (settings.animation === "none" ? "slideshow" : settings.animation);
      const resolved = resolveVideoPlan(
        { ...settings, animation },
        { isSupported, frameCount: frames.length, sourceDurationSec: settings.maxDurationSec },
      );

      if (!planIsRunnable(resolved)) {
        setError("format rekaman tidak didukung browser ini");
        return;
      }
      if (frames.length < 2) {
        setError("animasi butuh minimal dua foto");
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const sources = await decodeFrames(frames, (blob) => browserFilterDeps().decode(blob));
        if (sources.length < 2) {
          setError("foto sesi tidak bisa dibaca");
          return;
        }

        const result = await renderAnimation(browserSequenceDeps(), {
          kind: animation,
          frames: sources.map((frame) => frame.image),
          width: resolved.width,
          height: resolved.height,
          fps: resolved.fps,
          bitrateBps: resolved.bitrateBps,
          frameMs: settings.slideshowFrameMs,
          mimeType: resolved.mimeType,
        });

        if (result.blob.size === 0) {
          setError("animasi tidak menghasilkan berkas");
          return;
        }

        const seconds = result.steps.reduce((end, step) => Math.max(end, step.startSec + step.durationSec), 0);
        await saveClip({
          blob: result.blob,
          width: resolved.width,
          height: resolved.height,
          durationSec: seconds,
          extension: resolved.extension,
          contentType: resolved.contentType,
          filename: animationFilename(animation, resolved.extension),
          index: clips.length,
        });
      } catch (thrown) {
        setError(thrown instanceof Error ? thrown.message : String(thrown));
      } finally {
        setBusy(false);
      }
    },
    [clips.length, frames, isSupported, saveClip, settings],
  );

  const summary = useMemo(() => {
    if (plan === null) return null;
    return describePlan(plan);
  }, [plan]);

  return {
    settings,
    update,
    reset,
    plan,
    summary,
    canRecord: plan !== null && options.stream !== null,
    recording,
    busy,
    clips,
    error,
    startRecording,
    stopRecording,
    renderAnimationClip,
    clearClips,
  };
}

/** Setelan video default — dipakai UI untuk tombol "kembalikan ke awal". */
export { DEFAULT_VIDEO_SETTINGS };
