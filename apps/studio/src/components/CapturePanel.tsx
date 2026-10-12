/**
 * Panel capture — wajah dari `useCaptureSession`.
 *
 * Komponen ini sengaja "bodoh": ia tidak menghitung apa pun soal alur sesi,
 * hanya menampilkan `snapshot` dan memanggil aksi. Semua keputusan
 * (kapan boleh jepret, berapa kali retry, kapan berhenti) ada di state machine.
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ASPECT_RATIOS } from "../lib/capture/aspectRatio.ts";
import { RESOLUTION_PRESETS } from "../lib/transports/resolutions.ts";
import { deviceBadge } from "../lib/transports/deviceProfile.ts";
import type { CaptureErrorCode } from "../lib/transports/errors.ts";
import { useCaptureSession } from "../lib/useCaptureSession.ts";

/** Nama state di UI. Semua nilai harus ada — kalau state baru ditambah, ini ikut ketahuan. */
const STATE_LABEL: Record<string, string> = {
  idle: "capture.stateIdle",
  armed: "capture.stateArmed",
  countdown: "capture.stateCountdown",
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

function withCurrent(options: readonly number[], current: number): number[] {
  return options.includes(current) ? [...options] : [...options, current].sort((a, b) => a - b);
}

/** State di mana sesi sedang berjalan — pengaturan ditahan supaya tidak berubah di tengah alur. */
const RUNNING_STATES = new Set(["countdown", "capturing", "processing", "composed"]);

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
  const { state, session, frames } = capture;

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
            <button className="btn" type="button" disabled={!canArm} onClick={capture.arm}>
              {t("capture.arm")}
            </button>
            <button className="btn" type="button" disabled={!canBegin} onClick={capture.begin}>
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

          <button className="btn" type="button" disabled={!canAccept} onClick={capture.accept}>
            {t("capture.accept")}
          </button>
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

        <p className="muted small">
          {settingsLocked ? t("capture.settingsLocked") : t("capture.settingsHint")}
        </p>
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
