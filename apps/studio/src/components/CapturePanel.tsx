/**
 * Panel capture — wajah dari `useCaptureSession`.
 *
 * Komponen ini sengaja "bodoh": ia tidak menghitung apa pun soal alur sesi,
 * hanya menampilkan `snapshot` dan memanggil aksi. Semua keputusan
 * (kapan boleh jepret, berapa kali retry, kapan berhenti) ada di state machine.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ASPECT_RATIOS } from "../lib/capture/aspectRatio.ts";
import { QUALITY_PRESETS } from "../lib/capture/quality.ts";
import { describeShutterOffset } from "../lib/capture/shutterOffset.ts";
import { CHROMA_SWATCHES } from "../lib/filters/filterSettingsStore.ts";
import { useFilterSettings } from "../lib/filters/useFilterSettings.ts";
import type { BackgroundMode, RotationDegrees } from "../lib/filters/types.ts";
import { AI_STYLE_OPTIONS, AI_TASK_OPTIONS, useAiSettings } from "../lib/ai/useAiSettings.ts";
import { previewAiPrompt } from "../lib/ai/aiEnhance.ts";
import { useGallery } from "../lib/gallery/galleryContext.ts";
import { RESOLUTION_PRESETS } from "../lib/transports/resolutions.ts";
import { deviceBadge } from "../lib/transports/deviceProfile.ts";
import type { CaptureErrorCode } from "../lib/transports/errors.ts";
import { framesToIntake } from "../lib/upload/composedToIntake.ts";
import { makeThumb } from "../lib/upload/makeThumb.ts";
import { useCaptureSession } from "../lib/useCaptureSession.ts";
import KioskResultScreen from "./KioskResultScreen.tsx";
import { shouldShowResultScreen } from "../lib/kiosk/resultActions.ts";
import { useKioskResultPrint } from "../lib/kiosk/useKioskResultPrint.ts";
import type { UseKioskResult } from "../lib/kiosk/useKiosk.ts";
import {
  SLIDESHOW_FRAME_MS_LIMITS,
  SLOW_MO_FACTORS,
  VIDEO_FPS_OPTIONS,
  VIDEO_MAX_DURATION_LIMITS,
  VIDEO_RESOLUTIONS,
  type SlowMoFactor,
  type VideoAnimationKind,
  type VideoFps,
  type VideoQualityId,
  type VideoResolutionId,
} from "../lib/video/types.ts";
import { useVideoSession } from "../lib/video/useVideoSession.ts";

/** Nama state di UI. Semua nilai harus ada — kalau state baru ditambah, ini ikut ketahuan. */
const STATE_LABEL: Record<string, string> = {
  idle: "capture.stateIdle",
  armed: "capture.stateArmed",
  countdown: "capture.stateCountdown",
  shutter: "capture.stateShutter",
  capturing: "capture.stateCapturing",
  review: "capture.stateReview",
  processing: "capture.stateProcessing",
  composed: "capture.stateComposed",
  stalled: "capture.stateStalled",
};

const ERROR_LABEL: Record<CaptureErrorCode, string> = {
  "insecure-context": "capture.errorInsecure",
  "permission-denied": "capture.errorNotAllowed",
  "device-missing": "capture.errorMissing",
  "device-busy": "capture.errorBusy",
  overconstrained: "capture.errorOverconstrained",
  unsupported: "capture.errorUnsupported",
  unknown: "capture.errorUnknown",
};

/**
 * Pilihan durasi/kuantitas disajikan sebagai daftar, bukan angka bebas: di
 * kiosk, operator menekan layar, bukan mengetik. Nilai yang sedang aktif selalu
 * ikut ditampilkan walau tidak ada di daftar (mis. hasil dari localStorage).
 */
const SHOT_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12];
const COUNTDOWN_OPTIONS = [1000, 2000, 3000, 5000, 10_000];
const INTERVAL_OPTIONS = [0, 500, 1000, 2000, 3000, 5000];
const REVIEW_OPTIONS = [0, 3000, 5000, 10_000, 15_000, 30_000];
/** Jeda setelah angka nol; langkah 50 ms sesuai `shutterOffset.ts`. */
const SHUTTER_OFFSET_OPTIONS = [0, 150, 300, 500, 750, 1000, 1500, 2000];

/** Rotasi yang sah — urutannya mengikuti tombol putar. */
const ROTATION_OPTIONS: readonly RotationDegrees[] = [0, 90, 180, 270];

/** Mode latar yang bisa dipilih operator, dengan kunci labelnya. */
const BACKGROUND_OPTIONS: readonly { id: BackgroundMode; label: string }[] = [
  { id: "none", label: "capture.bgNone" },
  { id: "color", label: "capture.bgColor" },
  { id: "blur", label: "capture.bgBlur" },
  { id: "ai", label: "capture.bgAi" },
];

/** Pilihan setelan video — daftar, bukan angka bebas, sama alasannya dengan sesi foto. */
const VIDEO_DURATION_OPTIONS = [5, 10, 15, 30, 45, 60];
const SLIDESHOW_FRAME_OPTIONS = [300, 500, 700, 900, 1200, 2000, 3000];

const VIDEO_QUALITY_OPTIONS: readonly { id: VideoQualityId; label: string }[] = [
  { id: "hemat", label: "capture.videoQualityHemat" },
  { id: "standar", label: "capture.videoQualityStandar" },
  { id: "maks", label: "capture.videoQualityMaks" },
];

const VIDEO_ANIMATION_OPTIONS: readonly { id: VideoAnimationKind; label: string }[] = [
  { id: "none", label: "capture.videoAnimNone" },
  { id: "slideshow", label: "capture.videoAnimSlideshow" },
  { id: "boomerang", label: "capture.videoAnimBoomerang" },
];

/** Label faktor slow-mo. `1` = normal, jadi tombolnya tidak berbunyi "1×". */
const SLOW_MO_LABELS: Record<SlowMoFactor, string> = {
  1: "capture.videoSlowMoNormal",
  0.5: "capture.videoSlowMoHalf",
  0.25: "capture.videoSlowMoQuarter",
};

function withCurrent(options: readonly number[], current: number): number[] {
  return options.includes(current) ? [...options] : [...options, current].sort((a, b) => a - b);
}

/** State di mana sesi sedang berjalan — pengaturan ditahan supaya tidak berubah di tengah alur. */
const RUNNING_STATES = new Set(["countdown", "shutter", "capturing", "processing", "composed"]);

/**
 * State yang berarti **tamu sedang mengerjakan sesuatu**.
 *
 * Lebih lebar dari `RUNNING_STATES`: `armed` dan `review` tidak mengunci
 * setelan operator, tapi tetap berarti ada sesi hidup yang bisa hilang kalau
 * kiosk dimatikan di tengahnya. Untuk peringatan keluar (#52) itu yang penting.
 */
const SESSION_STATES = new Set([
  "armed",
  "countdown",
  "shutter",
  "capturing",
  "review",
  "processing",
  "composed",
]);

/**
 * Nilai untuk opsi "belum ada kamera dipilih".
 *
 * Sengaja **bukan** string kosong: sebelum izin kamera diberikan, browser
 * menyembunyikan `deviceId` asli dan memberi string kosong. Kalau placeholder
 * juga bernilai kosong, memilih kamera itu tidak mengubah apa pun — `onChange`
 * melihat nilai yang sama dengan placeholder dan mengabaikannya. Itulah kenapa
 * dropdown terasa "tidak bisa dipilih".
 */
const DEVICE_NONE = "__none__";

interface CapturePanelProps {
  /**
   * Handle kiosk dari `useKiosk`.
   *
   * `null`/absen = panel dipakai di luar mode kiosk (operator biasa, tes).
   * Tanpa kiosk, panel tetap berfungsi penuh — hanya tidak melaporkan sesi ke
   * peringatan keluar dan tidak menampilkan layar hasil tamu.
   */
  kiosk?: UseKioskResult | null;
}

export default function CapturePanel({ kiosk = null }: CapturePanelProps = {}): React.JSX.Element {
  const { t } = useTranslation();
  const capture = useCaptureSession();
  const filters = useFilterSettings();
  const { state, session, frames } = capture;
  const { intake, active, session: operatorSession } = useGallery();
  const resultPrint = useKioskResultPrint();
  // Efek AI (Fase 8). BYOK: kunci milik operator disimpan di perangkatnya, dan
  // token sesi operator dipakai sebagai tiket masuk ke proxy di server rumah.
  const ai = useAiSettings({ token: operatorSession?.token ?? null });

  // Hasil simpan sesi terakhir. Ditampilkan sebagai pesan, bukan toast: di
  // kiosk, pesan yang hilang sendiri berarti operator tidak pernah tahu
  // fotonya tersimpan atau tidak.
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Video (Fase 7). Sumbernya sama dengan foto: stream kamera yang sedang
  // tersambung dan frame sesi yang sudah dijepret (bahan animasi).
  //
  // Daftar blob di-memo: `session.frames()` membangun array baru tiap panggilan,
  // dan identitas yang berubah tiap render akan membuat rencana rekaman
  // dihitung ulang terus — plus membatalkan `useCallback` di hook.
  const videoFrames = useMemo(
    () => (session?.frames() ?? []).map((frame) => frame.blob),
    // `frames` tidak dibaca di dalam badan memo, tapi identitasnya berubah tiap
    // slot sesi berubah — itu satu-satunya penanda bahwa `session.frames()`
    // perlu dibaca ulang. Pola yang sama dipakai `useCaptureSession`.
    [session, frames], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const video = useVideoSession({
    stream: session?.stream() ?? null,
    frames: videoFrames,
    onClip: async (photo) => {
      const summary = await intake([photo]);
      if (summary.error !== null) {
        setSavedNote(t("capture.saveFailed", { message: summary.error }));
      } else {
        setSavedNote(t("capture.saved", { count: summary.queued }));
      }
    },
  });

  // Penghitung durasi rekaman — hanya hidup selama merekam.
  const [recordSeconds, setRecordSeconds] = useState(0);
  useEffect(() => {
    if (!video.recording) {
      setRecordSeconds(0);
      return;
    }
    const started = Date.now();
    const id = window.setInterval(() => {
      setRecordSeconds(Math.round((Date.now() - started) / 1000));
    }, 500);
    return () => window.clearInterval(id);
  }, [video.recording]);

  const holderRef = useRef<HTMLDivElement>(null);
  const deviceId = state?.deviceId ?? null;

  // Elemen video dibuat transport, bukan React. React cuma meminjamkan tempat.
  useEffect(() => {
    const holder = holderRef.current;
    if (holder === null || session === null) return;

    const element = session.videoElement();
    if (element === null) return;

    if (element.parentElement !== holder) {
      holder.replaceChildren(element);
    }

    element.className = "preview-video";
    void element.play().catch(() => undefined);
  }, [session, deviceId]);

  const currentState = state?.state ?? "idle";
  const signalLost = state?.signal === "no-signal";

  // Pesan "tidak ada sinyal" harus sesuai jenis device: menyuruh operator
  // memeriksa kabel HDMI pada kamera bawaan laptop itu jelas salah alamat.
  const deviceSource = capture.devices.find((device) => device.id === deviceId)?.source ?? null;
  const seconds = Math.max(0, Math.ceil((state?.waitRemainingMs ?? 0) / 1000));
  const shotCount = state?.config.shotCount ?? 0;
  const filled = state?.frames.filter((id) => id !== null).length ?? 0;
  const aspectRatio = ASPECT_RATIOS.find((option) => option.id === capture.aspect)?.ratio ?? null;

  const canArm = deviceId !== null && (currentState === "idle" || currentState === "stalled");
  const canBegin = currentState === "armed";
  const canRetake = currentState === "review";
  const canAccept = currentState === "review" && filled === shotCount && shotCount > 0;
  const canShoot = currentState === "armed" || currentState === "review";
  const settingsLocked = RUNNING_STATES.has(currentState);

  /**
   * Laporkan ke kiosk bahwa tamu sedang di tengah sesi.
   *
   * Dipakai peringatan keluar (#52): keluar saat sesi hidup membuang frame yang
   * belum diterima. `hold()`/`release()` sekaligus menahan reset idle selama
   * sesi, jadi pelaporan ini menumpang jalur yang sama — bukan jalur kedua yang
   * bisa tidak sinkron.
   */
  const kioskHold = kiosk?.hold;
  const kioskRelease = kiosk?.release;
  useEffect(() => {
    if (kioskHold === undefined || kioskRelease === undefined) return;
    if (!SESSION_STATES.has(currentState)) return;

    kioskHold();
    return () => kioskRelease();
  }, [currentState, kioskHold, kioskRelease]);

  /**
   * Terima hasil sesi, lalu simpan: arsip lokal dulu, baru antrian upload.
   *
   * `accept()` dipanggil lebih dulu supaya alur sesi tidak tertahan menunggu
   * disk — operator bisa langsung menyiapkan sesi berikutnya. Frame-nya masih
   * hidup di sesi (blob tidak dibuang saat accept), jadi urutannya aman.
   *
   * `markProcessed()` **wajib** dipanggil di akhir, apa pun hasil simpannya.
   * Tanpa itu state machine berhenti di `processing` selamanya: setelan
   * terkunci, tombol "Selesai & lanjut" mati, dan layar hasil kiosk tidak
   * pernah muncul. Sesi yang gagal disimpan tetap selesai diproses — kegagalan
   * dilaporkan lewat pesan, bukan dengan menahan tamu di layar "memproses".
   */
  const onAccept = async (): Promise<void> => {
    const source = capture.session;
    capture.accept();
    if (source === null) return;

    try {
      /**
       * Urutan efek: filter dulu, baru AI.
       *
       * Alasannya bukan selera: filter adalah koreksi deterministik pada foto
       * (rotasi, kroma, koreksi warna) yang operator lihat di layar saat menjepret.
       * AI bekerja paling baik pada foto yang sudah lurus dan terwarnai benar —
       * dan kalau AI gagal, yang disimpan adalah hasil filter, bukan foto mentah.
       */
      const processPhoto = async (blob: Blob) => {
        let current = blob;
        const filtered = await filters.process(blob);
        if (filtered !== null && filtered.blob.size > 0) current = filtered.blob;

        const styled = await ai.process(current);
        if (styled === null) {
          // AI mati/gagal → hasil filter (atau blob asli) yang disimpan.
          return filtered;
        }
        return styled;
      };

      const photos = await framesToIntake(source.frames(), {
        makeThumb,
        // Filter & AI dijalankan sebelum thumbnail: yang diunggah & yang tampil di
        // galeri harus foto yang sudah difilter, bukan versi mentahnya.
        process: processPhoto,
      });
      const summary = await intake(photos);

      if (summary.error !== null) {
        setSavedNote(t("capture.saveFailed", { message: summary.error }));
      } else {
        setSavedNote(t("capture.saved", { count: summary.queued }));
        // Ada foto yang benar-benar tersimpan: keluar kiosk sekarang akan
        // membuang hasil ini (#52).
        kiosk?.noteSaved();
      }
    } finally {
      capture.markProcessed();
    }
  };

  /**
   * Sesi baru dari sisi operator: buang penanda "ada foto tersimpan" milik
   * kiosk — sesi yang bisa hilang itu sudah selesai.
   */
  const onNewSession = (): void => {
    kiosk?.clearSaved();
    capture.newSession();
  };

  /**
   * Tamu selesai di layar hasil: kembali ke layar tarik sekarang.
   *
   * Urutannya penting. Sesi direset **dulu** supaya layar hasil hilang, baru
   * kiosk di-`disarm` supaya layar tarik muncul. Kalau dibalik, ada satu render
   * di mana layar tarik sudah tampil tapi sesi lama masih `composed` — layar
   * hasil menumpuk di atas layar tarik.
   */
  const onResultDone = (): void => {
    capture.newSession();
    kiosk?.disarm();
  };

  // Layar hasil tamu hanya muncul di kiosk, setelah sesi diterima, dan tidak
  // saat operator sedang membuka kunci lewat PIN (layar itu milik operator).
  const showResultScreen = shouldShowResultScreen({
    kioskEnabled: kiosk?.enabled === true,
    finished: currentState === "composed",
    unlocked: kiosk?.locked === true,
  });

  return (
    <section className="capture" aria-labelledby="capture-title">
      <div className="capture-head">
        <h2 id="capture-title">{t("capture.title")}</h2>
        <span className={`badge ${signalLost ? "badge-off" : "badge-ok"}`}>
          {signalLost ? t("capture.noSignal") : t("capture.signalOk")}
        </span>
      </div>

      {capture.demo && <p className="banner banner-warn">{t("capture.demoMode")}</p>}
      {capture.storageKind === "memory" && (
        <p className="banner banner-warn">{t("capture.storageMemory")}</p>
      )}

      {capture.error !== null && (
        <p className="banner banner-error" role="status">
          {t(ERROR_LABEL[capture.error.code])}
          <button className="link" type="button" onClick={capture.clearError}>
            {t("capture.dismiss")}
          </button>
        </p>
      )}

      {currentState === "stalled" && (
        <p className="banner banner-error" role="alert">
          {t("capture.stalledBody", { count: state?.failures ?? 0 })}
          <button className="btn btn-small" type="button" onClick={capture.retry}>
            {t("capture.retry")}
          </button>
        </p>
      )}

      <div className="capture-grid">
        {/* ── preview ── */}
        <div className="preview">
          <div
            className={`preview-stage${capture.mirror ? " is-mirrored" : ""}`}
            style={aspectRatio === null ? undefined : { aspectRatio: String(aspectRatio) }}
          >
            <div className="preview-holder" ref={holderRef} />

            {capture.demo ? (
              <div className="preview-empty">{t("capture.demoPreview")}</div>
            ) : deviceId === null ? (
              // Sebelum ini stage cuma kotak hitam kosong tanpa penjelasan —
              // terbaca sebagai "ruang kosong". Sekarang ada arahan singkat.
              <div className="preview-empty">{t("capture.previewIdle")}</div>
            ) : null}

            {currentState === "countdown" && (
              <div key={seconds} className="preview-count" aria-live="polite">
                {seconds}
              </div>
            )}

            {/* Angka sudah nol tapi frame belum diambil: beri isyarat visual
                supaya operator tidak mengira aplikasi hang. */}
            {currentState === "shutter" && (
              <div className="preview-count preview-shutter" aria-live="polite">
                •
              </div>
            )}

            {signalLost && (
              <div className="preview-overlay">
                {deviceSource === "webcam"
                  ? t("capture.noSignalBodyWebcam")
                  : t("capture.noSignalBody")}
              </div>
            )}
          </div>

          <div className="preview-meta">
            <span
              className={`pill ${currentState === "stalled" ? "pill-off" : "pill-on"}`}
              data-testid="capture-state"
              data-state={currentState}
            >
              {t(STATE_LABEL[currentState] ?? "capture.stateIdle")}
            </span>
            <span>
              {t("capture.progress", { filled, total: shotCount })}
            </span>
            {state?.error !== null && state?.error !== undefined && (
              <span className="muted">{t(ERROR_LABEL[state.error])}</span>
            )}
          </div>
        </div>

        {/* ── kontrol ── */}
        <div className="controls">
          <label className="field">
            <span>{t("capture.device")}</span>
            <select
              value={deviceId ?? DEVICE_NONE}
              disabled={capture.devices.length === 0}
              data-testid="capture-device"
              onChange={(event) => {
                const value = event.target.value;
                // `""` adalah nilai SAH (device yang belum berizin) — jadi
                // yang dilewati hanya sentinel placeholder.
                if (value !== DEVICE_NONE) void capture.connect(value);
              }}
            >
              <option value={DEVICE_NONE}>{t("capture.deviceNone")}</option>
              {capture.devices.map((device) => (
                <option key={device.id === "" ? "belum-berizin" : device.id} value={device.id}>
                  {device.id === ""
                    ? t("capture.deviceNeedsPermission")
                    : `${device.label} — ${deviceBadge(device)}`}
                </option>
              ))}
            </select>
          </label>

          <div className="field-row">
            <button className="btn btn-ghost btn-small" type="button" onClick={() => void capture.refreshDevices()}>
              {t("capture.scan")}
            </button>
            <button
              className="btn btn-ghost btn-small"
              type="button"
              disabled={deviceId === null}
              onClick={() => void capture.disconnect()}
            >
              {t("capture.disconnect")}
            </button>
          </div>

          <label className="field">
            <span>{t("capture.aspect")}</span>
            <select
              value={capture.aspect}
              onChange={(event) => capture.setAspect(event.target.value as typeof capture.aspect)}
            >
              {ASPECT_RATIOS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{t("capture.resolution")}</span>
            <select
              defaultValue=""
              disabled={deviceId === null}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "") return;
                const [width, height] = value.split("x").map(Number);
                void capture.setResolution(width ?? 0, height ?? 0);
              }}
            >
              <option value="">{t("capture.resolutionAuto")}</option>
              {RESOLUTION_PRESETS.map((preset) => (
                <option key={`${preset.width}x${preset.height}`} value={`${preset.width}x${preset.height}`}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={capture.mirror}
              disabled={deviceId === null}
              onChange={(event) => capture.setMirrorOverride(event.target.checked)}
            />
            <span>{t("capture.mirror")}</span>
          </label>


          <div className="field-row">
            <button
              className="btn"
              type="button"
              disabled={!canArm}
              data-testid="capture-arm"
              onClick={capture.arm}
            >
              {t("capture.arm")}
            </button>
            <button
              className="btn"
              type="button"
              disabled={!canBegin}
              data-testid="capture-begin"
              onClick={capture.begin}
            >
              {t("capture.begin")}
            </button>
          </div>

          <div className="field-row">
            <button
              className="btn btn-ghost btn-small"
              type="button"
              disabled={!canShoot}
              onClick={capture.begin}
            >
              {t("capture.shootNow")}
            </button>
            <button className="btn btn-ghost btn-small" type="button" onClick={capture.reset}>
              {t("capture.reset")}
            </button>
            <button className="btn btn-ghost btn-small" type="button" onClick={onNewSession}>
              {t("capture.newSession")}
            </button>
          </div>

          <button
            className="btn"
            type="button"
            disabled={!canAccept}
            data-testid="capture-accept"
            onClick={() => void onAccept()}
          >
            {t("capture.accept")}
          </button>

          {savedNote !== null && (
            <p className="note" data-testid="capture-saved-note">
              {savedNote}
            </p>
          )}

          {active === null && (
            <p className="note" data-testid="capture-no-gallery">
              {t("capture.noGallery")}
            </p>
          )}
        </div>
      </div>

      {/* ── pengaturan sesi (§A2 countdown, §A3 jumlah frame, §B4 review) ── */}
      <fieldset className="settings settings-wide" disabled={settingsLocked}>
        <legend>{t("capture.settings")}</legend>

        <label className="field">
          <span>{t("capture.shotCount")}</span>
          <select
            value={String(capture.config.shotCount)}
            onChange={(event) => capture.setConfig({ shotCount: Number(event.target.value) })}
          >
            {withCurrent(SHOT_OPTIONS, capture.config.shotCount).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={capture.config.countdownMs > 0}
            onChange={(event) =>
              capture.setConfig({ countdownMs: event.target.checked ? 3000 : 0 })
            }
          />
          <span>{t("capture.countdownToggle")}</span>
        </label>

        <label className="field">
          <span>{t("capture.countdownSecs")}</span>
          <select
            value={String(capture.config.countdownMs)}
            disabled={capture.config.countdownMs === 0}
            onChange={(event) => capture.setConfig({ countdownMs: Number(event.target.value) })}
          >
            {withCurrent(COUNTDOWN_OPTIONS, capture.config.countdownMs).map((value) => (
              <option key={value} value={value}>
                {t("capture.secondsShort", { value: value / 1000 })}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("capture.intervalSecs")}</span>
          <select
            value={String(capture.config.intervalMs)}
            onChange={(event) => capture.setConfig({ intervalMs: Number(event.target.value) })}
          >
            {withCurrent(INTERVAL_OPTIONS, capture.config.intervalMs).map((value) => (
              <option key={value} value={value}>
                {t("capture.secondsShort", { value: value / 1000 })}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("capture.reviewSecs")}</span>
          <select
            value={String(capture.config.reviewMs)}
            onChange={(event) => capture.setConfig({ reviewMs: Number(event.target.value) })}
          >
            {withCurrent(REVIEW_OPTIONS, capture.config.reviewMs).map((value) => (
              <option key={value} value={value}>
                {value === 0
                  ? t("capture.reviewManual")
                  : t("capture.secondsShort", { value: value / 1000 })}
              </option>
            ))}
          </select>
        </label>

        {/* Jeda setelah angka nol — bukan menambah hitungan, tapi menunda jepret
            sedikit supaya pose tamu sudah mantap. */}
        <label className="field">
          <span>{t("capture.shutterOffset")}</span>
          <select
            value={String(capture.config.shutterOffsetMs)}
            data-testid="capture-shutter-offset"
            onChange={(event) => capture.setConfig({ shutterOffsetMs: Number(event.target.value) })}
          >
            {withCurrent(SHUTTER_OFFSET_OPTIONS, capture.config.shutterOffsetMs).map((value) => (
              <option key={value} value={value}>
                {describeShutterOffset(value)}
              </option>
            ))}
          </select>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={capture.config.autoConnect}
            data-testid="capture-auto-connect"
            onChange={(event) => capture.setConfig({ autoConnect: event.target.checked })}
          />
          <span>{t("capture.autoConnect")}</span>
        </label>

        <p className="muted small">
          {settingsLocked ? t("capture.settingsLocked") : t("capture.settingsHint")}
        </p>
      </fieldset>

      {/* ── filter foto (§B6 green screen, §B7 adjustments, §B8 latar) ── */}
      <fieldset className="settings settings-wide" data-testid="capture-filters">
        <legend>{t("capture.filters")}</legend>

        <label className="field">
          <span>{t("capture.rotation")}</span>
          <select
            value={String(filters.settings.rotation)}
            data-testid="filter-rotation"
            onChange={(event) =>
              filters.update({ rotation: Number(event.target.value) as RotationDegrees })
            }
          >
            {ROTATION_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {t("capture.rotationDeg", { value })}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("capture.quality")}</span>
          <select
            value={filters.settings.quality}
            data-testid="filter-quality"
            onChange={(event) =>
              filters.update({ quality: event.target.value as typeof filters.settings.quality })
            }
          >
            {QUALITY_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={filters.settings.chromaKey.enabled}
            data-testid="filter-chroma"
            onChange={(event) =>
              filters.update({ chromaKey: { ...filters.settings.chromaKey, enabled: event.target.checked } })
            }
          />
          <span>{t("capture.chromaKey")}</span>
        </label>

        <div className="field-row">
          {CHROMA_SWATCHES.map((swatch) => {
            const activeSwatch =
              filters.settings.chromaKey.color.r === swatch.color.r &&
              filters.settings.chromaKey.color.g === swatch.color.g &&
              filters.settings.chromaKey.color.b === swatch.color.b;

            return (
              <button
                key={swatch.id}
                className={`btn btn-ghost btn-small${activeSwatch ? " is-active" : ""}`}
                type="button"
                data-testid={`filter-chroma-${swatch.id}`}
                onClick={() => filters.update({ chromaKey: { ...filters.settings.chromaKey, color: swatch.color } })}
              >
                {swatch.label}
              </button>
            );
          })}
        </div>

        <label className="field">
          <span>{t("capture.background")}</span>
          <select
            value={filters.settings.background.mode}
            data-testid="filter-background"
            onChange={(event) =>
              filters.update({
                background: { ...filters.settings.background, mode: event.target.value as BackgroundMode },
              })
            }
          >
            {BACKGROUND_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("capture.brightness")}</span>
          <input
            type="range"
            min={-100}
            max={100}
            value={filters.settings.adjustments.brightness}
            data-testid="filter-brightness"
            onChange={(event) =>
              filters.update({
                adjustments: { ...filters.settings.adjustments, brightness: Number(event.target.value) },
              })
            }
          />
        </label>

        <label className="field">
          <span>{t("capture.contrast")}</span>
          <input
            type="range"
            min={-100}
            max={100}
            value={filters.settings.adjustments.contrast}
            data-testid="filter-contrast"
            onChange={(event) =>
              filters.update({
                adjustments: { ...filters.settings.adjustments, contrast: Number(event.target.value) },
              })
            }
          />
        </label>

        <label className="field">
          <span>{t("capture.saturation")}</span>
          <input
            type="range"
            min={-100}
            max={100}
            value={filters.settings.adjustments.saturation}
            data-testid="filter-saturation"
            onChange={(event) =>
              filters.update({
                adjustments: { ...filters.settings.adjustments, saturation: Number(event.target.value) },
              })
            }
          />
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={filters.settings.faceEnhance}
            data-testid="filter-face-enhance"
            onChange={(event) => filters.update({ faceEnhance: event.target.checked })}
          />
          <span>{t("capture.faceEnhance")}</span>
        </label>

        <div className="field-row">
          <button className="btn btn-ghost btn-small" type="button" onClick={filters.reset}>
            {t("capture.filterReset")}
          </button>
        </div>

        <p className="muted small">{t("capture.filterHint")}</p>
      </fieldset>

      {/* ── AI (§B25: gaya anime/3D/comic/watercolor/oil + BYOK Gemini) ── */}
      <fieldset className="settings settings-wide" data-testid="capture-ai">
        <legend>{t("capture.ai")}</legend>

        <label className="check">
          <input
            type="checkbox"
            checked={ai.settings.enabled}
            data-testid="ai-enabled"
            onChange={(event) => ai.update({ enabled: event.target.checked })}
          />
          <span>{t("capture.aiEnabled")}</span>
        </label>

        <label className="field">
          <span>{t("capture.aiKey")}</span>
          <input
            type="password"
            value={ai.settings.key}
            data-testid="ai-key"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("capture.aiKeyPlaceholder")}
            onChange={(event) => ai.update({ key: event.target.value })}
          />
        </label>

        <label className="field">
          <span>{t("capture.aiTask")}</span>
          <select
            value={ai.settings.task}
            data-testid="ai-task"
            onChange={(event) => ai.update({ task: event.target.value as typeof ai.settings.task })}
          >
            {AI_TASK_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("capture.aiStyle")}</span>
          <select
            value={ai.settings.style}
            data-testid="ai-style"
            onChange={(event) => ai.update({ style: event.target.value as typeof ai.settings.style })}
          >
            {AI_STYLE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("capture.aiCustom")}</span>
          <input
            type="text"
            value={ai.settings.custom}
            data-testid="ai-custom"
            maxLength={600}
            placeholder={t("capture.aiCustomPlaceholder")}
            onChange={(event) => ai.update({ custom: event.target.value })}
          />
        </label>

        {/* Pratinjau prompt: operator harus melihat instruksi yang benar-benar
            dikirim ke Gemini, bukan ringkasan yang dibuat UI. */}
        <p className="muted small" data-testid="ai-prompt-preview">
          {previewAiPrompt({
            task: ai.settings.task,
            style: ai.settings.style,
            ...(ai.settings.custom === "" ? {} : { custom: ai.settings.custom }),
          })}
        </p>

        {/* Kunci tidak pernah ditampilkan utuh — hanya bentuk tersamarkan. */}
        {ai.settings.key !== "" && (
          <p className="muted small" data-testid="ai-key-masked">
            {t("capture.aiKeySaved", { masked: ai.maskedKey })}
          </p>
        )}

        {ai.settings.enabled && !ai.ready && (
          <p className="banner banner-warn" data-testid="ai-not-ready">
            {t(operatorSession === null ? "capture.aiNeedLogin" : "capture.aiNeedKey")}
          </p>
        )}

        {ai.lastSummary !== null && (
          <p className="muted small" data-testid="ai-last-summary">
            {ai.lastSummary}
          </p>
        )}

        <div className="field-row">
          <button className="btn btn-ghost btn-small" type="button" onClick={ai.reset}>
            {t("capture.aiReset")}
          </button>
        </div>

        <p className="muted small">{t("capture.aiHint")}</p>
      </fieldset>

      {/* ── video (§B13–§B20: rekam, resolusi/fps/durasi, slow-mo, audio, animasi) ── */}
      <fieldset className="settings settings-wide" data-testid="capture-video">
        <legend>{t("capture.video")}</legend>

        <label className="field">
          <span>{t("capture.videoResolution")}</span>
          <select
            value={video.settings.resolution}
            data-testid="video-resolution"
            onChange={(event) => video.update({ resolution: event.target.value as VideoResolutionId })}
          >
            {VIDEO_RESOLUTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("capture.videoFps")}</span>
          <select
            value={String(video.settings.fps)}
            data-testid="video-fps"
            onChange={(event) => video.update({ fps: Number(event.target.value) as VideoFps })}
          >
            {VIDEO_FPS_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {t("capture.videoFpsValue", { value })}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("capture.videoDuration")}</span>
          <select
            value={String(video.settings.maxDurationSec)}
            data-testid="video-duration"
            onChange={(event) => video.update({ maxDurationSec: Number(event.target.value) })}
          >
            {withCurrent(
              VIDEO_DURATION_OPTIONS.filter(
                (value) =>
                  value >= VIDEO_MAX_DURATION_LIMITS.min && value <= VIDEO_MAX_DURATION_LIMITS.max,
              ),
              video.settings.maxDurationSec,
            ).map((value) => (
              <option key={value} value={value}>
                {t("capture.secondsShort", { value })}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("capture.videoSlowMo")}</span>
          <select
            value={String(video.settings.slowMo)}
            data-testid="video-slowmo"
            onChange={(event) => video.update({ slowMo: Number(event.target.value) as SlowMoFactor })}
          >
            {SLOW_MO_FACTORS.map((value) => (
              <option key={value} value={value}>
                {t(SLOW_MO_LABELS[value])}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("capture.videoQuality")}</span>
          <select
            value={video.settings.quality}
            data-testid="video-quality"
            onChange={(event) => video.update({ quality: event.target.value as VideoQualityId })}
          >
            {VIDEO_QUALITY_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={video.settings.audio}
            data-testid="video-audio"
            onChange={(event) => video.update({ audio: event.target.checked })}
          />
          <span>{t("capture.videoAudio")}</span>
        </label>

        <label className="field">
          <span>{t("capture.videoAnimation")}</span>
          <select
            value={video.settings.animation}
            data-testid="video-animation"
            onChange={(event) =>
              video.update({ animation: event.target.value as VideoAnimationKind })
            }
          >
            {VIDEO_ANIMATION_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("capture.videoFrameMs")}</span>
          <select
            value={String(video.settings.slideshowFrameMs)}
            disabled={video.settings.animation === "none"}
            data-testid="video-frame-ms"
            onChange={(event) => video.update({ slideshowFrameMs: Number(event.target.value) })}
          >
            {withCurrent(
              SLIDESHOW_FRAME_OPTIONS.filter(
                (value) =>
                  value >= SLIDESHOW_FRAME_MS_LIMITS.min && value <= SLIDESHOW_FRAME_MS_LIMITS.max,
              ),
              video.settings.slideshowFrameMs,
            ).map((value) => (
              <option key={value} value={value}>
                {t("capture.secondsShort", { value: value / 1000 })}
              </option>
            ))}
          </select>
        </label>

        <div className="field-row">
          {video.recording ? (
            <button
              className="btn"
              type="button"
              data-testid="video-stop"
              disabled={video.busy}
              onClick={() => void video.stopRecording()}
            >
              {t("capture.videoStop")}
            </button>
          ) : (
            <button
              className="btn"
              type="button"
              data-testid="video-record"
              disabled={!video.canRecord || video.busy}
              onClick={video.startRecording}
            >
              {t("capture.videoRecord")}
            </button>
          )}

          <button
            className="btn btn-ghost btn-small"
            type="button"
            data-testid="video-animate"
            disabled={video.busy || frames.length < 2 || video.settings.animation === "none"}
            onClick={() => void video.renderAnimationClip()}
          >
            {t("capture.videoRender")}
          </button>

          <button className="btn btn-ghost btn-small" type="button" onClick={video.reset}>
            {t("capture.videoReset")}
          </button>
        </div>

        {video.recording && (
          <p className="banner" role="status" data-testid="video-recording">
            {t("capture.videoRecording", { seconds: recordSeconds })}
          </p>
        )}

        {video.plan === null ? (
          <p className="muted small" data-testid="video-unsupported">
            {t("capture.videoNoSupport")}
          </p>
        ) : (
          <p className="muted small" data-testid="video-plan">
            {t("capture.videoPlan", { summary: video.summary ?? "" })}
          </p>
        )}

        {!video.canRecord && video.plan !== null && (
          <p className="muted small" data-testid="video-no-stream">
            {t("capture.videoNoStream")}
          </p>
        )}

        {video.busy && <p className="banner banner-warn">{t("capture.videoBusy")}</p>}

        {video.error !== null && (
          <p className="banner banner-error" role="status" data-testid="video-error">
            {video.error}
          </p>
        )}

        <p className="muted small">{t("capture.videoHint")}</p>

        {/* Klip sesi ini. Tamu harus bisa melihat hasilnya sebelum pulang —
            sama seperti grid foto di bawah, tapi klip perlu diputar. */}
        <div className="video-clips" data-testid="video-clips">
          <div className="field-row">
            <span className="muted small">{t("capture.videoClips")}</span>
            {video.clips.length > 0 && (
              <button
                className="link"
                type="button"
                data-testid="video-clear"
                onClick={video.clearClips}
              >
                {t("capture.videoClear")}
              </button>
            )}
          </div>

          {video.clips.length === 0 ? (
            <p className="muted small" data-testid="video-clips-empty">
              {t("capture.videoClipEmpty")}
            </p>
          ) : (
            <div className="frames">
              {video.clips.map((clip) => (
                <figure key={clip.id} className="shot">
                  <video src={clip.url} controls muted playsInline preload="metadata" />
                  <figcaption>
                    <span>{clip.filename}</span>
                    <span className="muted">{clip.summary}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      </fieldset>

      {/* ── hasil ── */}
      <div className="frames">
        {Array.from({ length: shotCount }, (_, index) => {
          const frame = frames.find((entry) => entry.shotIndex === index) ?? null;

          return (
            <figure key={index} className={`shot${frame === null ? " is-empty" : ""}`}>
              {frame === null ? (
                <div className="shot-empty">{index + 1}</div>
              ) : capture.demo ? (
                <div className="shot-empty">{index + 1}</div>
              ) : (
                <img src={frame.url} alt={t("capture.shotAlt", { index: index + 1 })} />
              )}

              <figcaption>
                <span>
                  {index + 1}/{shotCount}
                </span>
                {frame !== null && (
                  <span className="muted">
                    {frame.width}×{frame.height}
                  </span>
                )}
                <button
                  className="link"
                  type="button"
                  disabled={!canRetake}
                  onClick={() => capture.retake(index)}
                >
                  {t("capture.retake")}
                </button>
              </figcaption>
            </figure>
          );
        })}
      </div>

      {/* Layar hasil tamu (#51). Menumpuk di atas panel: tamu tidak perlu
          melihat tombol operator, dan panel tetap hidup di belakangnya supaya
          operator bisa mengambil alih tanpa memuat ulang. */}
      {showResultScreen && kiosk !== null && (
        <KioskResultScreen
          buttons={kiosk.buttons}
          galleryUrl={active?.url ?? null}
          onPrint={resultPrint.print}
          onDone={onResultDone}
        />
      )}
    </section>
  );
}
