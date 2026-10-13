/**
 * Status antrian upload — wajah dari `useUploadQueue`.
 *
 * Panel ini sengaja menampilkan **angka dan sebab**, bukan cuma "sedang
 * mengunggah". Operator kiosk harus bisa menjawab tiga pertanyaan tanpa
 * membuka DevTools:
 *
 *   1. berapa foto yang belum terkirim?
 *   2. kalau ada yang gagal, kenapa?
 *   3. kalau menunggu, sampai kapan?
 *
 * Karena itu tiap item menampilkan percobaan ke-berapa dan jadwal coba
 * berikutnya — "menunggu" tanpa jam bikin orang menekan tombol terus.
 */

import { useTranslation } from "react-i18next";

import { countByState, type UploadState } from "@foto-booth/shared";

import { useGallery } from "../lib/gallery/galleryContext.ts";

const STATE_LABEL: Record<UploadState, string> = {
  "local-only": "upload.stateLocalOnly",
  queued: "upload.stateQueued",
  uploading: "upload.stateUploading",
  uploaded: "upload.stateUploaded",
  failed: "upload.stateFailed",
};

const STATE_BADGE: Record<UploadState, string> = {
  "local-only": "badge",
  queued: "badge badge-warn",
  uploading: "badge badge-warn",
  uploaded: "badge badge-ok",
  failed: "badge badge-off",
};

/** Jeda menuju percobaan berikutnya dalam detik; `null` kalau tidak terjadwal. */
function secondsUntil(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const diff = new Date(iso).getTime() - now.getTime();
  return diff <= 0 ? 0 : Math.ceil(diff / 1000);
}

export default function UploadStatusPanel(): React.JSX.Element {
  const { t } = useTranslation();
  const { queue, active, session } = useGallery();

  const counts = countByState(queue.items);
  const now = new Date();

  if (session === null) {
    return (
      <p className="note" data-testid="upload-need-login">
        {t("upload.needLogin")}
      </p>
    );
  }

  if (active === null) {
    return (
      <p className="note" data-testid="upload-need-gallery">
        {t("upload.needGallery")}
      </p>
    );
  }

  return (
    <div data-testid="upload-status">
      <dl>
        <div className="row">
          <dt>{t("upload.pending")}</dt>
          <dd data-testid="upload-pending">{counts.pending}</dd>
        </div>
        <div className="row">
          <dt>{t("upload.uploaded")}</dt>
          <dd data-testid="upload-done">{counts.uploaded}</dd>
        </div>
        <div className="row">
          <dt>{t("upload.failed")}</dt>
          <dd data-testid="upload-failed">{counts.failed}</dd>
        </div>
      </dl>

      {queue.storageError !== null && (
        <p className="note" data-testid="upload-storage-error">
          {t("upload.storageError", { message: queue.storageError })}
        </p>
      )}

      <p className="note" data-testid="upload-sync">
        {queue.sync === null
          ? t("upload.syncChecking")
          : queue.sync.registered
            ? t("upload.syncRegistered")
            : t("upload.syncFallback", { reason: queue.sync.reason ?? t("upload.syncUnsupported") })}
      </p>

      <div className="field-row" style={{ marginTop: 12 }}>
        <button
          className="btn btn-small"
          type="button"
          data-testid="upload-run-now"
          disabled={queue.running || counts.pending === 0}
          onClick={() => void queue.runNow()}
        >
          {queue.running ? t("upload.running") : t("upload.runNow")}
        </button>
      </div>

      {queue.items.length > 0 && (
        <ul className="upload-list" data-testid="upload-items">
          {queue.items.map((item) => {
            const wait = secondsUntil(item.nextAttemptAt, now);
            return (
              <li key={item.id} data-testid="upload-item" data-state={item.state}>
                <span className="upload-name" title={item.filename}>
                  {item.filename}
                </span>
                <span className={STATE_BADGE[item.state]}>{t(STATE_LABEL[item.state])}</span>
                {item.attempts > 0 && (
                  <span className="muted">
                    {t("upload.attempts", { count: item.attempts })}
                  </span>
                )}
                {item.state === "queued" && wait !== null && (
                  <span className="muted">{t("upload.retryIn", { seconds: wait })}</span>
                )}
                {item.lastError !== null && <span className="upload-error">{item.lastError}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
