/**
 * Panel capture — wajah dari `useCaptureSession`.
 *
 * Komponen ini sengaja "bodoh": ia tidak menghitung apa pun soal alur sesi,
 * hanya menampilkan `snapshot` dan memanggil aksi. Semua keputusan
 * (kapan boleh jepret, berapa kali retry, kapan berhenti) ada di state machine.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ASPECT_RATIOS } from "../lib/capture/aspectRatio.ts";
import { QUALITY_PRESETS } from "../lib/capture/quality.ts";
import { describeShutterOffset } from "../lib/capture/shutterOffset.ts";
import { CHROMA_SWATCHES } from "../lib/filters/filterSettingsStore.ts";
import { useFilterSettings } from "../lib/filters/useFilterSettings.ts";
import type { BackgroundMode, RotationDegrees } from "../lib/filters/types.ts";
import { useGallery } from "../lib/gallery/galleryContext.ts";
import { RESOLUTION_PRESETS } from "../lib/transports/resolutions.ts";
import { deviceBadge } from "../lib/transports/deviceProfile.ts";
import type { CaptureErrorCode } from "../lib/transports/errors.ts";
import { framesToIntake } from "../lib/upload/composedToIntake.ts";
import { makeThumb } from "../lib/upload/makeThumb.ts";
import { useCaptureSession } from "../lib/useCaptureSession.ts";

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

function withCurrent(options: readonly number[], current: number): number[] {
  return options.includes(current) ? [...options] : [...options, current].sort((a, b) => a - b);
}

/** State di mana sesi sedang berjalan — pengaturan ditahan supaya tidak berubah di tengah alur. */
const RUNNING_STATES = new Set(["countdown", "shutter", "capturing", "processing", "composed"]);

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

export default function CapturePanel(): React.JSX.Element {
  const { t } = useTranslation();
  const capture = useCaptureSession();
  const filters = useFilterSettings();
  const { state, session, frames } = capture;
  const { intake, active } = useGallery();

  // Hasil simpan sesi terakhir. Ditampilkan sebagai pesan, bukan toast: di
  // kiosk, pesan yang hilang sendiri berarti operator tidak pernah tahu
  // fotonya tersimpan atau tidak.
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const holderRef = useRef<HTMLDivElement>(null);
  const deviceId = state?.deviceId ?? null;

  // Elemen video dibuat transport, bukan React. React cuma meminjamkan tempat.
  useEffect(() => {
    const holder = holderRef.current;
    if (holder === null || session === null) return;

    const video = session.videoElement();
    if (video === null) return;

    if (video.parentElement !== holder) {
      holder.replaceChildren(video);
    }

    video.className = "preview-video";
    void video.play().catch(() => undefined);
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
   * Terima hasil sesi, lalu simpan: arsip lokal dulu, baru antrian upload.
   *
   * `accept()` dipanggil lebih dulu supaya alur sesi tidak tertahan menunggu
   * disk — operator bisa langsung menyiapkan sesi berikutnya. Frame-nya masih
   * hidup di sesi (blob tidak dibuang saat accept), jadi urutannya aman.
   */
  const onAccept = async (): Promise<void> => {
    const source = capture.session;
    capture.accept();
    if (source === null) return;

    const photos = await framesToIntake(source.frames(), {
      makeThumb,
      // Filter dijalankan sebelum thumbnail: yang diunggah & yang tampil di
      // galeri harus foto yang sudah difilter, bukan versi mentahnya.
      process: filters.process,
    });
    const summary = await intake(photos);

    if (summary.error !== null) {
      setSavedNote(t("capture.saveFailed", { message: summary.error }));
    } else {
      setSavedNote(t("capture.saved", { count: summary.queued }));
    }
  };

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
            <span className={`pill ${currentState === "stalled" ? "pill-off" : "pill-on"}`}>
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
            <button className="btn btn-ghost btn-small" type="button" onClick={capture.newSession}>
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
    </section>
  );
}
