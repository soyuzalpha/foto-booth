/**
 * Layar hasil kiosk (Fase 12 — titipan #51 dari Fase 9).
 *
 * Setelah sesi diterima, tamu melihat satu layar besar dengan tombol yang
 * **operator** nyalakan di panel kiosk (`KioskButtons`). Tombolnya sengaja
 * besar dan sedikit: kiosk dipakai jari di layar sentuh, dan tamu yang melihat
 * delapan pilihan akan ragu.
 *
 * Keputusan "tombol mana yang tampil" tidak dihitung di sini — ia ada di
 * `resultActions.ts` yang murni dan teruji. Komponen ini hanya merender hasil
 * keputusan itu dan menjalankan aksinya.
 *
 * Yang perlu diperhatikan:
 *
 *   · **Tidak pernah mentok.** Tombol "Selesai" selalu ada, walau operator
 *     mematikan semua tombol tamu. Layar hasil yang tidak punya jalan keluar
 *     akan mengunci kiosk sampai ada yang menekan keluar.
 *   · **Cetak dilaporkan, bukan diam.** Tamu harus tahu apakah fotonya keluar
 *     atau gagal; kegagalan printer yang tidak terlihat membuat tamu menunggu
 *     di depan mesin.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { renderQrDataUrl } from "../lib/gallery/qr.ts";
import type { KioskButtons } from "../lib/kiosk/kioskConfig.ts";
import { visibleResultActions } from "../lib/kiosk/resultActions.ts";
import type { ResultPrintOutcome } from "../lib/kiosk/resultPrint.ts";

export interface KioskResultScreenProps {
  /** Tombol yang dinyalakan operator. */
  buttons: KioskButtons;
  /** URL galeri tamu; `null` = belum ada galeri aktif. */
  galleryUrl: string | null;
  /** Cetak foto hasil sesi. Tidak melempar — hasilnya selalu nilai. */
  onPrint: () => Promise<ResultPrintOutcome>;
  /** Tamu selesai; layar kembali ke tarik. */
  onDone: () => void;
}

type PrintStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

export default function KioskResultScreen({
  buttons,
  galleryUrl,
  onPrint,
  onDone,
}: KioskResultScreenProps): React.JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PrintStatus>({ kind: "idle" });
  const [showQr, setShowQr] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const actions = visibleResultActions(buttons);

  // QR dibuat saat panelnya dibuka, bukan saat render: pembuatannya asinkron dan
  // tamu yang tidak menekan "kirim ke ponsel" tidak perlu menunggunya.
  useEffect(() => {
    if (!showQr || galleryUrl === null) {
      setQr(null);
      return;
    }

    let cancelled = false;
    void renderQrDataUrl(galleryUrl)
      .then((dataUrl) => {
        if (!cancelled) setQr(dataUrl);
      })
      .catch(() => {
        // Galeri bisa punya URL yang tidak bisa dipakai QR (mis. terlalu panjang
        // untuk versi QR ini). URL-nya tetap ditampilkan sebagai teks.
        if (!cancelled) setQr(null);
      });

    return () => {
      cancelled = true;
    };
  }, [showQr, galleryUrl]);

  const handlePrint = (): void => {
    if (status.kind === "busy") return;
    setNote(null);
    setStatus({ kind: "busy" });

    void onPrint().then((outcome) => {
      setStatus(outcome.ok ? { kind: "ok" } : { kind: "error", message: outcome.message });
    });
  };

  const handleGallery = (): void => {
    if (galleryUrl === null) {
      setNote(t("kiosk.resultNoGallery"));
      return;
    }
    setNote(null);
    globalThis.open(galleryUrl, "_blank", "noopener,noreferrer");
  };

  const handleShare = (): void => {
    if (galleryUrl === null) {
      setNote(t("kiosk.resultNoGallery"));
      return;
    }
    setNote(null);
    setShowQr((current) => !current);
  };

  return (
    <div className="kiosk-result" data-testid="kiosk-result">
      <div className="kiosk-result-in">
        <h1>{t("kiosk.resultTitle")}</h1>
        <p>{t("kiosk.resultBody")}</p>

        {actions.length === 0 && (
          <p className="note" data-testid="kiosk-result-no-actions">
            {t("kiosk.resultNoActions")}
          </p>
        )}

        <div className="kiosk-result-actions">
          {actions.includes("print") && (
            <button
              className="btn kiosk-result-btn"
              type="button"
              data-testid="kiosk-result-print"
              disabled={status.kind === "busy"}
              onClick={handlePrint}
            >
              {status.kind === "busy" ? t("kiosk.resultPrinting") : t("kiosk.resultPrint")}
            </button>
          )}

          {actions.includes("gallery") && (
            <button
              className="btn kiosk-result-btn"
              type="button"
              data-testid="kiosk-result-gallery"
              onClick={handleGallery}
            >
              {t("kiosk.resultGallery")}
            </button>
          )}

          {actions.includes("share") && (
            <button
              className="btn kiosk-result-btn"
              type="button"
              data-testid="kiosk-result-share"
              onClick={handleShare}
            >
              {t("kiosk.resultShare")}
            </button>
          )}

          <button
            className="btn kiosk-result-btn kiosk-result-done"
            type="button"
            data-testid="kiosk-result-done"
            onClick={onDone}
          >
            {t("kiosk.resultDone")}
          </button>
        </div>

        {status.kind === "ok" && (
          <p className="note" role="status" data-testid="kiosk-result-print-ok">
            {t("kiosk.resultPrinted")}
          </p>
        )}

        {status.kind === "error" && (
          <p className="banner banner-error" role="alert" data-testid="kiosk-result-print-error">
            {t("kiosk.resultPrintFailed", { message: status.message })}
          </p>
        )}

        {note !== null && (
          <p className="note" role="status" data-testid="kiosk-result-note">
            {note}
          </p>
        )}

        {showQr && galleryUrl !== null && (
          <div className="kiosk-result-qr" data-testid="kiosk-result-qr">
            {qr !== null ? (
              <img src={qr} alt={t("kiosk.resultQrAlt")} width={220} height={220} />
            ) : (
              <p className="note">{galleryUrl}</p>
            )}
            <p className="note">{t("kiosk.resultQrHint")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
