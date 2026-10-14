/**
 * Panel bagikan album (Fase 9, FEATURE-MATRIX #56–#59).
 *
 * Operator mengirim tautan galeri ke WhatsApp/email/SMS, membuka dialog share
 * sistem, atau menyalin tautannya. Semua tombol memakai kanal & tautan dari
 * `shareClient`, yang sendiri memakai fungsi murni shared — jadi kartu yang
 * dibuka tamu dan pesan yang dikirim operator tidak bisa berbeda.
 *
 * Kenapa menampilkan juga URL kartu share (`/a/<hash>/share`): itulah yang
 * dipratinjau WhatsApp/Telegram dengan gambar & judul acara. Mengirim tautan
 * galeri langsung sering tampil sebagai tautan polos.
 *
 * **Judul memakai branding, bukan data acara.** Ringkasan galeri tidak membawa
 * nama/tanggal acara, dan mengarangnya dari `label` akan menampilkan tanggal
 * kedaluwarsa sebagai tanggal acara. Kalau operator mengisi subjudul branding,
 * itulah yang dipakai; kalau tidak, deskripsi jatuh ke ajakan umum.
 */

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { GALLERY_BASE_PATH } from "@foto-booth/shared";

import { useBranding } from "../lib/branding/useBranding.ts";
import { useGallery } from "../lib/gallery/galleryContext.ts";
import {
  runShare,
  shareDescriptionOf,
  shareOptionsOf,
  type ShareContext,
} from "../lib/sharing/shareClient.ts";

/** Sesi belum ada: arahkan ke tab yang punya formulir masuknya. */
function SignedOutCard(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="card" data-testid="share-signed-out">
      <h2>{t("share.title")}</h2>
      <p className="note">{t("share.signedOut")}</p>
    </section>
  );
}

function NoGalleryCard(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="card" data-testid="share-no-gallery">
      <h2>{t("share.title")}</h2>
      <p className="note">{t("share.noGallery")}</p>
    </section>
  );
}

/** Satu tombol kanal: `<a>` kalau kanal punya URL, `<button>` kalau butuh aksi. */
function ShareButton({
  channel,
  label,
  href,
  onClick,
}: {
  channel: string;
  label: string;
  href: string | null;
  onClick: () => void;
}): React.JSX.Element {
  if (href !== null) {
    return (
      <a
        className="btn"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-testid={`share-channel-${channel}`}
      >
        {label}
      </a>
    );
  }

  return (
    <button
      className="btn"
      type="button"
      data-testid={`share-channel-${channel}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export default function SharePanel(): React.JSX.Element {
  const { t } = useTranslation();
  const { session, active } = useGallery();
  const token = session?.token ?? null;

  const { branding } = useBranding({ token });
  const [feedback, setFeedback] = useState<string | null>(null);

  const context = useMemo<ShareContext | null>(() => {
    if (active === null) return null;
    return { branding, event: null, galleryUrl: active.url };
  }, [active, branding]);

  const options = useMemo(() => (context === null ? [] : shareOptionsOf(context)), [context]);

  const run = useCallback(
    async (channel: (typeof options)[number]["channel"]) => {
      if (context === null) return;
      const outcome = await runShare(channel, context);
      setFeedback(t(`share.result.${outcome.result}`));
    },
    [context, t],
  );

  if (session === null) {
    return (
      <div data-testid="panel-share">
        <SignedOutCard />
      </div>
    );
  }

  if (active === null || context === null) {
    return (
      <div data-testid="panel-share">
        <NoGalleryCard />
      </div>
    );
  }

  // Kartu share hidup di bawah prefiks galeri (`/a/<hash>` → `/a/<hash>/share`),
  // sebaris dengan halaman tamu dan ZIP-nya.
  const cardUrl = `${active.url.replace(/\/$/, "")}/share`;

  return (
    <div data-testid="panel-share">
      <section className="card card-wide" data-testid="share-card">
        <div className="capture-head">
          <h2>{t("share.title")}</h2>
          <span className="badge">{active.label}</span>
        </div>

        <p className="note" data-testid="share-description">
          {shareDescriptionOf(context)}
        </p>

        <label className="field">
          <span>{t("share.galleryUrl")}</span>
          <input type="text" readOnly value={active.url} data-testid="share-gallery-url" />
        </label>

        <label className="field">
          <span>{t("share.cardUrl")}</span>
          <input type="text" readOnly value={cardUrl} data-testid="share-card-url" />
        </label>

        <p className="note">{t("share.cardHint")}</p>

        {feedback !== null && (
          <p className="banner banner-ok" role="status" data-testid="share-feedback">
            {feedback}
          </p>
        )}

        <div className="field-row" data-testid="share-channels">
          {options.map((option) => (
            <ShareButton
              key={option.channel}
              channel={option.channel}
              label={option.label}
              href={option.href}
              onClick={() => void run(option.channel)}
            />
          ))}
        </div>

        <p className="note" data-testid="share-api-hint">
          {t("share.apiHint", { prefix: GALLERY_BASE_PATH })}
        </p>
      </section>
    </div>
  );
}
