/**
 * Panel video guestbook (Fase 9, FEATURE-MATRIX #19).
 *
 * Operator melihat pesan video/audio tamu untuk acara galeri yang sedang aktif,
 * memutar yang mencurigakan, menyembunyikan yang tidak pantas, dan menghapus
 * yang harus hilang.
 *
 * Kenapa acara diambil dari galeri aktif, bukan dipilih di panel ini: kiosk
 * melayani satu acara pada satu waktu, dan memilih acara lagi di sini
 * menciptakan dua sumber kebenaran — operator bisa memoderasi acara A sambil
 * galeri aktif menunjuk acara B tanpa sadar.
 *
 * **Berkas diputar lewat URL API, bukan URL bucket.** Bucket privat; entri yang
 * disembunyikan harus lewat jalur yang bisa menolak, bukan tautan yang tetap
 * bisa dibuka siapa pun yang menyimpannya.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useGallery } from "../lib/gallery/galleryContext.ts";
import { useGuestbook } from "../lib/guestbook/useGuestbook.ts";

/** Sesi belum ada: arahkan ke tab yang punya formulir masuknya. */
function SignedOutCard(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="card" data-testid="guestbook-signed-out">
      <h2>{t("guestbook.title")}</h2>
      <p className="note">{t("guestbook.signedOut")}</p>
    </section>
  );
}

/** Belum ada galeri aktif: guestbook melekat pada acara, jadi tidak ada yang bisa dimoderasi. */
function NoGalleryCard(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="card" data-testid="guestbook-no-gallery">
      <h2>{t("guestbook.title")}</h2>
      <p className="note">{t("guestbook.noGallery")}</p>
    </section>
  );
}

export default function GuestbookPanel(): React.JSX.Element {
  const { t } = useTranslation();
  const { session, active, galleries } = useGallery();
  const token = session?.token ?? null;

  // Acara dari galeri aktif — lihat catatan di atas kenapa tidak dipilih di sini.
  const eventId = useMemo(() => {
    if (active === null) return null;
    const match = galleries.galleries.find((gallery) => gallery.id === active.id);
    return match?.eventId ?? null;
  }, [active, galleries.galleries]);

  const { entries, total, totalDurationSeconds, loading, error, refresh, setVisible, remove, mediaUrl } =
    useGuestbook({ token, eventId });

  if (session === null) {
    return (
      <div data-testid="panel-guestbook">
        <SignedOutCard />
      </div>
    );
  }

  if (active === null || eventId === null) {
    return (
      <div data-testid="panel-guestbook">
        <NoGalleryCard />
      </div>
    );
  }

  return (
    <div data-testid="panel-guestbook">
      <section className="card card-wide" data-testid="guestbook-list-card">
        <div className="capture-head">
          <h2>{t("guestbook.title")}</h2>
          <span className="badge" data-testid="guestbook-count">
            {t("guestbook.count", { count: total })}
          </span>
        </div>

        <p className="note">{t("guestbook.note", { seconds: totalDurationSeconds })}</p>

        {error !== null && (
          <p className="banner banner-error" role="status" data-testid="guestbook-error">
            {error}
          </p>
        )}

        <div className="field-row">
          <button
            className="btn btn-ghost btn-small"
            type="button"
            disabled={loading}
            data-testid="guestbook-refresh"
            onClick={() => void refresh()}
          >
            {loading ? t("guestbook.loading") : t("guestbook.refresh")}
          </button>
        </div>

        {entries.length === 0 ? (
          <p className="note" data-testid="guestbook-empty">
            {t("guestbook.empty")}
          </p>
        ) : (
          <ul className="guestbook-grid" data-testid="guestbook-entries">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="guestbook-item"
                data-testid="guestbook-entry"
                data-visible={entry.visible}
              >
                <video
                  className="guestbook-media"
                  src={mediaUrl(entry.id)}
                  controls
                  preload="metadata"
                  data-testid="guestbook-media"
                />
                <div className="guestbook-meta">
                  <span className="muted small">{entry.kind}</span>
                  <span className="muted small">
                    {t("guestbook.duration", { seconds: entry.durationSeconds })}
                  </span>
                  {!entry.visible && (
                    <span className="badge badge-warn" data-testid="guestbook-hidden-badge">
                      {t("guestbook.hidden")}
                    </span>
                  )}
                  {entry.label !== "" && (
                    <span className="muted small">{entry.label}</span>
                  )}
                </div>
                <div className="field-row">
                  <button
                    className="btn btn-small btn-ghost"
                    type="button"
                    data-testid="guestbook-toggle-visible"
                    onClick={() => void setVisible(entry.id, !entry.visible)}
                  >
                    {entry.visible ? t("guestbook.hide") : t("guestbook.show")}
                  </button>
                  <button
                    className="link"
                    type="button"
                    data-testid="guestbook-delete"
                    onClick={() => void remove(entry.id)}
                  >
                    {t("guestbook.delete")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
