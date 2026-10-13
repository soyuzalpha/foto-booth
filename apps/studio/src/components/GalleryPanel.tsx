/**
 * Panel galeri: login operator, daftar galeri, pilih galeri aktif, dan QR.
 *
 * Urutan blok di layar mengikuti urutan kerja di lapangan:
 *
 *   1. **login** — tanpa token, tidak ada yang bisa dikerjakan;
 *   2. **pilih galeri aktif** — kiosk melayani satu acara; semua foto masuk ke sini;
 *   3. **QR** — setelah aktif, yang dibutuhkan operator cuma gambar untuk tamu;
 *   4. **buat galeri** — dibutuhkan sekali per acara, jadi diletakkan paling bawah.
 *
 * QR dirender di perangkat lewat `qr.ts` dan **tidak** menunggu jaringan.
 * Saat sinyal hilang di gedung acara, QR tetap tampil — justru itu gunanya
 * menyimpan hash di perangkat, bukan memanggil API tiap kali gambar dibutuhkan.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CreateEvent } from "@foto-booth/shared";

import { useGallery } from "../lib/gallery/galleryContext.ts";
import { renderQrSvg } from "../lib/gallery/qr.ts";
import { createAuthClient } from "../lib/session/operatorSession.ts";

const QR_SVG_OPTIONS = { size: 240 } as const;

function QrCard({ url, label }: { url: string; label: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);

    void renderQrSvg(url, QR_SVG_OPTIONS)
      .then((markup) => {
        if (!cancelled) setSvg(markup);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="qr-card" data-testid="gallery-qr">
      {failed ? (
        <p className="note" data-testid="gallery-qr-error">
          {t("gallery.qrFailed")}
        </p>
      ) : svg === null ? (
        <p className="note">{t("gallery.qrRendering")}</p>
      ) : (
        // SVG dari paket `qrcode`, bukan masukan pengguna: isinya kotak dan
        // path dari teks yang kita kendalikan sendiri (hash galeri).
        <div className="qr-box" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      <p className="note" data-testid="gallery-qr-url">
        {url}
      </p>
      <p className="muted small">{label}</p>
    </div>
  );
}

function LoginCard(): React.JSX.Element {
  const { t } = useTranslation();
  const { signIn } = useGallery();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestOtp = useCallback(async () => {
    if (email.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const client = createAuthClient();
      const result = await client.requestOtp(email.trim());
      // Di mode dev API mengembalikan kodenya supaya operator tidak perlu
      // membaca email; di produksi `code` tidak ada dan harus diambil dari email.
      setDevCode(result.code ?? null);
      setStage("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [email]);

  const verify = useCallback(async () => {
    if (code.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const client = createAuthClient();
      signIn(await client.verifyOtp(email.trim(), code.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [code, email, signIn]);

  return (
    <section className="card" data-testid="gallery-login">
      <h2>{t("gallery.login")}</h2>
      <p className="note">{t("gallery.loginNote")}</p>

      {error !== null && (
        <p className="banner banner-error" role="status">
          {error}
        </p>
      )}

      <label className="field">
        <span>{t("gallery.email")}</span>
        <input
          type="email"
          autoComplete="email"
          value={email}
          data-testid="gallery-email"
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>

      {stage === "email" ? (
        <div className="field-row">
          <button
            className="btn"
            type="button"
            disabled={busy || email.trim() === ""}
            data-testid="gallery-request-otp"
            onClick={() => void requestOtp()}
          >
            {busy ? t("gallery.sending") : t("gallery.sendCode")}
          </button>
        </div>
      ) : (
        <>
          <label className="field">
            <span>{t("gallery.code")}</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              data-testid="gallery-code"
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          {devCode !== null && (
            <p className="note" data-testid="gallery-dev-code">
              {t("gallery.devCode", { code: devCode })}
            </p>
          )}
          <div className="field-row">
            <button
              className="btn"
              type="button"
              disabled={busy || code.trim() === ""}
              data-testid="gallery-verify"
              onClick={() => void verify()}
            >
              {busy ? t("gallery.verifying") : t("gallery.signIn")}
            </button>
            <button
              className="btn btn-ghost btn-small"
              type="button"
              onClick={() => setStage("email")}
            >
              {t("gallery.back")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export default function GalleryPanel(): React.JSX.Element {
  const { t } = useTranslation();
  const { session, signOut, galleries, active, setActive, clearActive } = useGallery();

  const [eventName, setEventName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const create = useCallback(async () => {
    if (eventName.trim() === "" || eventDate.trim() === "") return;
    setCreating(true);
    setCreateError(null);
    try {
      const body: CreateEvent = { name: eventName.trim(), date: eventDate.trim() };
      const event = await galleries.createEvent(body);
      const gallery = await galleries.createGallery({ eventId: event.id });
      // Galeri baru langsung dijadikan aktif: operator baru saja membuatnya
      // untuk acara ini, jadi menuntut satu klik lagi cuma menambah kesempatan
      // lupa memilih — dan foto masuk ke galeri acara sebelumnya.
      setActive(gallery, event.name);
      setEventName("");
      setEventDate("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [eventDate, eventName, galleries, setActive]);

  if (session === null) {
    return (
      <div data-testid="panel-gallery">
        <LoginCard />
      </div>
    );
  }

  return (
    <div data-testid="panel-gallery">
      <section className="card card-wide">
        <div className="capture-head">
          <h2>{t("gallery.title")}</h2>
          <button className="btn btn-ghost btn-small" type="button" onClick={signOut}>
            {t("gallery.signOut")}
          </button>
        </div>
        <p className="note" data-testid="gallery-account">
          {t("gallery.signedInAs", { email: session.email })}
        </p>
      </section>

      {active !== null && (
        <section className="card card-wide" data-testid="gallery-active">
          <div className="capture-head">
            <h2>{t("gallery.activeTitle")}</h2>
            <span className="badge badge-ok">{active.label}</span>
          </div>
          <QrCard url={active.url} label={t("gallery.qrHint")} />
          <div className="field-row">
            <button
              className="btn btn-ghost btn-small"
              type="button"
              data-testid="gallery-clear-active"
              onClick={clearActive}
            >
              {t("gallery.clearActive")}
            </button>
          </div>
        </section>
      )}

      <section className="card card-wide">
        <div className="capture-head">
          <h2>{t("gallery.listTitle")}</h2>
          <button
            className="btn btn-ghost btn-small"
            type="button"
            disabled={galleries.loading}
            data-testid="gallery-refresh"
            onClick={() => void galleries.refresh()}
          >
            {galleries.loading ? t("gallery.loading") : t("gallery.refresh")}
          </button>
        </div>

        {galleries.error !== null && (
          <p className="banner banner-error" role="status" data-testid="gallery-list-error">
            {galleries.error}
          </p>
        )}

        {galleries.galleries.length === 0 ? (
          <p className="note" data-testid="gallery-list-empty">
            {t("gallery.listEmpty")}
          </p>
        ) : (
          <ul className="gallery-list" data-testid="gallery-list">
            {galleries.galleries.map((gallery) => {
              const isActive = active?.id === gallery.id;
              return (
                <li key={gallery.id} data-testid="gallery-row" data-active={isActive}>
                  <span className="gallery-hash">{gallery.hash}</span>
                  <span className="muted small">
                    {t("gallery.photoCount", { count: gallery.photoCount })}
                  </span>
                  <span className="muted small">
                    {t("gallery.expires", { date: gallery.expiresAt.slice(0, 10) })}
                  </span>
                  <button
                    className="btn btn-small"
                    type="button"
                    disabled={isActive}
                    data-testid="gallery-select"
                    onClick={() => setActive(gallery, gallery.hash)}
                  >
                    {isActive ? t("gallery.isActive") : t("gallery.select")}
                  </button>
                  <button
                    className="link"
                    type="button"
                    data-testid="gallery-delete"
                    onClick={() => void galleries.removeGallery(gallery.id)}
                  >
                    {t("gallery.delete")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card card-wide">
        <h2>{t("gallery.createTitle")}</h2>
        <p className="note">{t("gallery.createNote")}</p>

        {createError !== null && (
          <p className="banner banner-error" role="status">
            {createError}
          </p>
        )}

        <div className="field-row">
          <label className="field">
            <span>{t("gallery.eventName")}</span>
            <input
              type="text"
              value={eventName}
              data-testid="gallery-event-name"
              onChange={(event) => setEventName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{t("gallery.eventDate")}</span>
            <input
              type="date"
              value={eventDate}
              data-testid="gallery-event-date"
              onChange={(event) => setEventDate(event.target.value)}
            />
          </label>
          <button
            className="btn"
            type="button"
            disabled={creating || eventName.trim() === "" || eventDate.trim() === ""}
            data-testid="gallery-create"
            onClick={() => void create()}
          >
            {creating ? t("gallery.creating") : t("gallery.create")}
          </button>
        </div>
      </section>
    </div>
  );
}
