/**
 * Layar kiosk (Fase 4) — layar tarik, prompt PIN, dan peringatan idle.
 *
 * Semua elemen di sini hanya muncul saat kiosk aktif, dan sengaja besar:
 * kiosk dipakai dengan jari di layar sentuh, sering oleh orang yang baru
 * pertama kali melihatnya.
 *
 * Prompt PIN memakai keypad numerik sendiri (bukan `input` kecil) karena
 * keyboard virtual di kiosk sering menutupi separuh layar.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PIN_MAX_LENGTH } from "../lib/kiosk/pin.ts";
import type { UseKioskResult } from "../lib/kiosk/useKiosk.ts";

interface Props {
  kiosk: UseKioskResult;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export default function KioskOverlay({ kiosk }: Props): React.JSX.Element | null {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!kiosk.enabled) return null;

  const submit = (): void => {
    if (pin.length === 0 || busy) return;
    setBusy(true);

    void kiosk.unlock(pin).then((ok) => {
      setBusy(false);
      setPin("");
      setError(!ok);
    });
  };

  return (
    <div className="kiosk-layer" data-testid="kiosk-layer">
      {kiosk.showAttract && (
        <div className="kiosk-attract" data-testid="kiosk-attract">
          <div className="kiosk-attract-in">
            <h1>{t("kiosk.attractTitle")}</h1>
            <p>{t("kiosk.attractBody")}</p>
            <button
              className="btn kiosk-tap"
              type="button"
              data-testid="kiosk-start"
              onClick={kiosk.start}
            >
              {t("kiosk.attractCta")}
            </button>
          </div>
        </div>
      )}

      {kiosk.warning && !kiosk.showAttract && (
        <div className="kiosk-warning" role="alert" data-testid="kiosk-warning">
          <span data-testid="kiosk-countdown">
            {t("kiosk.warningBody", { seconds: kiosk.secondsToReset })}
          </span>
          <button className="btn btn-small" type="button" data-testid="kiosk-keepalive" onClick={kiosk.keepAlive}>
            {t("kiosk.warningKeep")}
          </button>
        </div>
      )}

      {!kiosk.showAttract && !kiosk.locked && (
        <button
          className="kiosk-exit"
          type="button"
          data-testid="kiosk-exit"
          onClick={kiosk.requestExit}
        >
          {t("kiosk.exitShort")}
        </button>
      )}

      {/* Peringatan keluar (#52). Sengaja tidak pernah muncul saat layar tarik
          tampil atau PIN sudah terbuka: di dua keadaan itu tidak ada pekerjaan
          yang bisa hilang, dan `exitWarningReason` sudah memutuskan begitu. */}
      {kiosk.exitWarning !== null && !kiosk.locked && (
        <div className="kiosk-lock" data-testid="kiosk-exit-warning">
          <div className="kiosk-lock-in">
            <h2>{t("kiosk.exitWarningTitle")}</h2>
            <p data-testid="kiosk-exit-warning-body">
              {kiosk.exitWarning === "session"
                ? t("kiosk.exitWarningSession")
                : t("kiosk.exitWarningIdle")}
            </p>

            <div className="field-row kiosk-exit-warning-actions">
              <button
                className="btn"
                type="button"
                data-testid="kiosk-exit-warning-cancel"
                onClick={kiosk.cancelExitWarning}
              >
                {t("kiosk.exitWarningCancel")}
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                data-testid="kiosk-exit-warning-confirm"
                onClick={kiosk.confirmExit}
              >
                {t("kiosk.exitWarningConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {kiosk.locked && (
        <div className="kiosk-lock" data-testid="kiosk-lock">
          <div className="kiosk-lock-in">
            <h2>{t("kiosk.pinPrompt")}</h2>
            <p className="kiosk-pin-display" data-testid="kiosk-pin-display" aria-live="polite">
              {"•".repeat(pin.length) || "—"}
            </p>

            <div className="kiosk-keypad">
              {KEYS.map((key) => (
                <button
                  key={key}
                  className="kiosk-key"
                  type="button"
                  data-testid={`kiosk-key-${key}`}
                  onClick={() => {
                    setError(false);
                    setPin((current) => (current.length >= PIN_MAX_LENGTH ? current : current + key));
                  }}
                >
                  {key}
                </button>
              ))}
              <button
                className="kiosk-key kiosk-key-wide"
                type="button"
                data-testid="kiosk-cancel"
                onClick={() => {
                  setPin("");
                  setError(false);
                  kiosk.cancelExit();
                }}
              >
                {t("kiosk.pinCancel")}
              </button>
              <button
                className="kiosk-key"
                type="button"
                data-testid="kiosk-key-0"
                onClick={() => {
                  setError(false);
                  setPin((current) => (current.length >= PIN_MAX_LENGTH ? current : current + "0"));
                }}
              >
                0
              </button>
              <button
                className="kiosk-key"
                type="button"
                data-testid="kiosk-key-del"
                onClick={() => {
                  setError(false);
                  setPin((current) => current.slice(0, -1));
                }}
              >
                ⌫
              </button>
            </div>

            <button
              className="btn kiosk-submit"
              type="button"
              data-testid="kiosk-pin-submit"
              disabled={pin.length === 0 || busy}
              onClick={submit}
            >
              {t("kiosk.pinSubmit")}
            </button>

            {error && (
              <p className="banner banner-error" data-testid="kiosk-pin-error">
                {t("kiosk.pinWrong")}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
