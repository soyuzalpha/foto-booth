/**
 * Panel pengaturan kiosk (Fase 4).
 *
 * Panel ini **tidak** memegang logika kiosk; ia hanya menampilkan status dari
 * `useKiosk` dan meneruskan aksi operator. Aturan yang dipegang:
 *
 *   - kiosk tidak boleh dinyalakan tanpa PIN kalau `requirePinOnExit` menyala —
 *     kalau tidak, tamu bisa keluar ke desktop dan menutup aplikasi;
 *   - PIN hanya ditulis sebagai hash (`pinStore`), input selalu `type=password`;
 *   - peringatan konteks tidak aman ditampilkan di sini, karena kiosk tanpa
 *     HTTPS/localhost tidak bisa membuka kamera sama sekali.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, isPinFormatValid } from "../lib/kiosk/pin.ts";
import type { UseKioskResult } from "../lib/kiosk/useKiosk.ts";

const TIMEOUT_CHOICES = [30_000, 60_000, 90_000, 120_000, 300_000] as const;
const WARNING_CHOICES = [10_000, 15_000, 30_000] as const;

interface Props {
  kiosk: UseKioskResult;
}

export default function KioskPanel({ kiosk }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [pinAgain, setPinAgain] = useState("");
  const [pinMessage, setPinMessage] = useState<string | null>(null);

  const pinMismatch = pinAgain.length > 0 && pin !== pinAgain;
  const pinTooShort = pin.length > 0 && !isPinFormatValid(pin);
  const canSavePin = isPinFormatValid(pin) && pin === pinAgain;

  const savePin = (): void => {
    void kiosk
      .setPin(pin)
      .then(() => {
        setPin("");
        setPinAgain("");
        setPinMessage(t("kiosk.pinSaved"));
      })
      .catch(() => setPinMessage(t("kiosk.pinInvalid")));
  };

  return (
    <section className="card card-wide kiosk-panel" data-testid="panel-kiosk">
      <h2>{t("kiosk.title")}</h2>
      <p className="note">{t("kiosk.subtitle")}</p>

      <dl>
        <div className="row">
          <dt>{t("kiosk.state")}</dt>
          <dd>
            <span
              className={`badge ${kiosk.enabled ? "badge-ok" : "badge-off"}`}
              data-testid="kiosk-status"
            >
              {kiosk.enabled ? t("kiosk.stateOn") : t("kiosk.stateOff")}
            </span>
          </dd>
        </div>
        <div className="row">
          <dt>{t("kiosk.fullscreen")}</dt>
          <dd data-testid="kiosk-fullscreen">
            {kiosk.fullscreen === "on"
              ? t("kiosk.fullscreenOn")
              : kiosk.fullscreen === "unsupported"
                ? t("kiosk.fullscreenUnsupported")
                : t("kiosk.fullscreenOff")}
          </dd>
        </div>
        <div className="row">
          <dt>{t("kiosk.wakeLock")}</dt>
          <dd data-testid="kiosk-wakelock">
            {kiosk.wakeLock === "on"
              ? t("kiosk.wakeLockOn")
              : kiosk.wakeLock === "unsupported"
                ? t("kiosk.wakeLockUnsupported")
                : kiosk.wakeLock === "denied"
                  ? t("kiosk.wakeLockDenied")
                  : t("kiosk.wakeLockOff")}
          </dd>
        </div>
      </dl>

      {!kiosk.secureContext && (
        <p className="banner banner-warn" data-testid="kiosk-insecure">
          {t("kiosk.insecureWarning")}
        </p>
      )}

      {kiosk.pinMissingWarning && (
        <p className="banner banner-warn" data-testid="kiosk-pin-missing">
          {t("kiosk.pinMissing")}
        </p>
      )}

      {kiosk.fullscreenBlocked && (
        <p className="banner banner-warn" data-testid="kiosk-fullscreen-blocked">
          {t("kiosk.fullscreenBlocked")}
        </p>
      )}

      <div className="kiosk-actions">
        {kiosk.enabled ? (
          <button className="btn" type="button" data-testid="kiosk-disable" onClick={kiosk.requestExit}>
            {t("kiosk.exit")}
          </button>
        ) : (
          <button className="btn" type="button" data-testid="kiosk-enable" onClick={() => void kiosk.enable()}>
            {t("kiosk.enter")}
          </button>
        )}
      </div>

      <div className="kiosk-settings">
        <label className="field">
          <span>{t("kiosk.idleTimeout")}</span>
          <select
            data-testid="kiosk-idle-timeout"
            value={kiosk.idleConfig.timeoutMs}
            onChange={(event) =>
              kiosk.setIdleConfig({ ...kiosk.idleConfig, timeoutMs: Number(event.target.value) })
            }
          >
            {TIMEOUT_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {t("kiosk.seconds", { value: choice / 1000 })}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("kiosk.warningLead")}</span>
          <select
            data-testid="kiosk-idle-warning"
            value={kiosk.idleConfig.warningMs}
            onChange={(event) =>
              kiosk.setIdleConfig({ ...kiosk.idleConfig, warningMs: Number(event.target.value) })
            }
          >
            {WARNING_CHOICES.filter((choice) => choice <= kiosk.idleConfig.timeoutMs).map((choice) => (
              <option key={choice} value={choice}>
                {t("kiosk.seconds", { value: choice / 1000 })}
              </option>
            ))}
          </select>
        </label>

        <label className="check">
          <input
            type="checkbox"
            data-testid="kiosk-require-pin"
            checked={kiosk.requirePinOnExit}
            onChange={(event) => kiosk.setRequirePinOnExit(event.target.checked)}
          />
          {t("kiosk.requirePin")}
        </label>

        <label className="check">
          <input
            type="checkbox"
            data-testid="kiosk-block-gestures"
            checked={kiosk.blockGestures}
            onChange={(event) => kiosk.setBlockGestures(event.target.checked)}
          />
          {t("kiosk.blockGestures")}
        </label>

        <label className="check">
          <input
            type="checkbox"
            data-testid="kiosk-tap-to-start"
            checked={kiosk.tapToStart}
            onChange={(event) => kiosk.setTapToStart(event.target.checked)}
          />
          {t("kiosk.tapToStart")}
        </label>
      </div>

      <fieldset className="kiosk-buttons">
        <legend>{t("kiosk.buttons")}</legend>
        {(["gallery", "print", "share"] as const).map((key) => (
          <label className="check" key={key}>
            <input
              type="checkbox"
              data-testid={`kiosk-button-${key}`}
              checked={kiosk.buttons[key]}
              onChange={(event) => kiosk.setButton(key, event.target.checked)}
            />
            {t(`kiosk.button_${key}`)}
          </label>
        ))}
        <p className="note">{t("kiosk.buttonsNote")}</p>
      </fieldset>

      <div className="kiosk-pin">
        <h3>{t("kiosk.pinTitle")}</h3>
        <p className="note">
          {kiosk.pinConfigured ? t("kiosk.pinConfigured") : t("kiosk.pinNotConfigured")}
        </p>

        <div className="field-row">
          <label className="field">
            <span>{t("kiosk.pinNew")}</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={PIN_MAX_LENGTH}
              data-testid="kiosk-pin-input"
              value={pin}
              onChange={(event) => {
                setPin(event.target.value.replace(/\D/g, ""));
                setPinMessage(null);
              }}
              placeholder={`${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH}`}
            />
          </label>
          <label className="field">
            <span>{t("kiosk.pinRepeat")}</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={PIN_MAX_LENGTH}
              data-testid="kiosk-pin-repeat"
              value={pinAgain}
              onChange={(event) => {
                setPinAgain(event.target.value.replace(/\D/g, ""));
                setPinMessage(null);
              }}
            />
          </label>
        </div>

        <div className="kiosk-actions">
          <button
            className="btn btn-small"
            type="button"
            data-testid="kiosk-pin-save"
            disabled={!canSavePin}
            onClick={savePin}
          >
            {kiosk.pinConfigured ? t("kiosk.pinChange") : t("kiosk.pinSave")}
          </button>
          {kiosk.pinConfigured && (
            <button
              className="btn btn-ghost btn-small"
              type="button"
              data-testid="kiosk-pin-clear"
              onClick={() => {
                kiosk.clearPin();
                setPinMessage(t("kiosk.pinCleared"));
              }}
            >
              {t("kiosk.pinClear")}
            </button>
          )}
        </div>

        {pinMismatch && (
          <p className="banner banner-error" data-testid="kiosk-pin-mismatch">
            {t("kiosk.pinMismatch")}
          </p>
        )}
        {pinTooShort && !pinMismatch && (
          <p className="banner banner-warn" data-testid="kiosk-pin-short">
            {t("kiosk.pinInvalid")}
          </p>
        )}
        {pinMessage !== null && !pinMismatch && (
          <p className="note" data-testid="kiosk-pin-message">
            {pinMessage}
          </p>
        )}
      </div>
    </section>
  );
}
