/**
 * Panel branding / white-label (Fase 9, FEATURE-MATRIX #61).
 *
 * Operator mengubah judul, subjudul, logo, dan footer yang tampil di halaman
 * galeri tamu dan kartu share. Panel ini **tidak menyimpan tokennya sendiri** —
 * sesi dipakai bersama tab Galeri lewat `useGallery()`, sama seperti `LeadsPanel`.
 *
 * Keputusan yang terlihat di sini:
 *
 *   · **Pratinjau di atas, formulir di bawah.** Operator perlu melihat hasilnya
 *     di halaman tamu; menaruh formulir dulu memaksa mereka membayangkan.
 *   · **Judul kosong tidak berarti halaman tanpa judul.** Kalau heading
 *     dikosongkan, halaman jatuh ke nama acara lalu nama aplikasi — pratinjau
 *     menunjukkan hasil akhirnya, bukan string kosong.
 *   · **Logo kosong = tidak ada tag gambar**, bukan `<img src="">` yang
 *     menghasilkan kotak rusak.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  BRANDING_FOOTER_MAX,
  BRANDING_HEADING_MAX,
  BRANDING_LOGO_URL_MAX,
  BRANDING_SUBHEADING_MAX,
  DEFAULT_BRANDING,
  resolvedHeading,
  resolvedSubheading,
  type Branding,
  type UpdateBranding,
} from "@foto-booth/shared";

import { useGallery } from "../lib/gallery/galleryContext.ts";
import { useBranding } from "../lib/branding/useBranding.ts";

/** Sesi belum ada: arahkan ke tab yang punya formulir masuknya. */
function SignedOutCard(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="card" data-testid="branding-signed-out">
      <h2>{t("branding.title")}</h2>
      <p className="note">{t("branding.signedOut")}</p>
    </section>
  );
}

/** Bidang teks dengan batas panjang yang sama dengan yang dipakai server. */
function TextField({
  label,
  value,
  max,
  testId,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  testId: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        maxLength={max}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export default function BrandingPanel(): React.JSX.Element {
  const { t } = useTranslation();
  const { session } = useGallery();
  const token = session?.token ?? null;

  const { branding, isDefault, loading, saving, error, save, refresh } = useBranding({ token });

  // Nilai yang sedang diketik. Dipisah dari `branding` (nilai server) supaya
  // simpan yang gagal tidak menghapus ketikan operator.
  const [draft, setDraft] = useState<Branding>(branding);
  const [saved, setSaved] = useState(false);

  // Server selesai memuat / berubah → ketikan disegarkan. `isDefault` dan
  // `branding` saja yang jadi pemicu: menyertakan `draft` akan menimpa ketikan.
  useEffect(() => {
    setDraft(branding);
  }, [branding]);

  const update = useCallback((patch: Partial<Branding>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  }, []);

  const submit = useCallback(async () => {
    const patch: UpdateBranding = {
      heading: draft.heading,
      subheading: draft.subheading,
      footer: draft.footer,
      logoUrl: draft.logoUrl,
    };
    try {
      await save(patch);
      setSaved(true);
    } catch {
      // Kesalahan sudah tampil lewat `error`.
    }
  }, [draft, save]);

  const reset = useCallback(() => {
    setDraft({ ...DEFAULT_BRANDING });
    setSaved(false);
  }, []);

  if (session === null) {
    return (
      <div data-testid="panel-branding">
        <SignedOutCard />
      </div>
    );
  }

  // Pratinjau memakai fungsi resolusi yang sama dengan halaman publik, jadi apa
  // yang dilihat operator di sini persis yang dibaca tamu.
  const previewHeading = resolvedHeading(draft, null);
  const previewSubheading = resolvedSubheading(draft, null);

  return (
    <div data-testid="panel-branding">
      <section className="card card-wide" data-testid="branding-preview">
        <div className="capture-head">
          <h2>{t("branding.preview.title")}</h2>
          {isDefault && <span className="badge badge-warn">{t("branding.preview.isDefault")}</span>}
        </div>
        <div className="branding-preview">
          {draft.logoUrl !== null && draft.logoUrl !== "" && (
            <img className="logo" src={draft.logoUrl} alt="" data-testid="branding-preview-logo" />
          )}
          <h1 data-testid="branding-preview-heading">{previewHeading}</h1>
          {previewSubheading !== "" && (
            <p data-testid="branding-preview-subheading">{previewSubheading}</p>
          )}
          {draft.footer !== "" && (
            <p className="note" data-testid="branding-preview-footer">
              {draft.footer}
            </p>
          )}
        </div>
      </section>

      <section className="card card-wide" data-testid="branding-form">
        <div className="capture-head">
          <h2>{t("branding.form.title")}</h2>
          <span className="badge">{loading ? t("branding.loading") : t("branding.form.hint")}</span>
        </div>

        {error !== null && (
          <p className="banner banner-error" role="status" data-testid="branding-error">
            {error}
          </p>
        )}
        {saved && error === null && (
          <p className="banner banner-ok" role="status" data-testid="branding-saved">
            {t("branding.saved")}
          </p>
        )}

        <div className="field-row">
          <TextField
            label={t("branding.fields.heading")}
            value={draft.heading}
            max={BRANDING_HEADING_MAX}
            testId="branding-heading"
            onChange={(value) => update({ heading: value })}
          />
          <TextField
            label={t("branding.fields.subheading")}
            value={draft.subheading}
            max={BRANDING_SUBHEADING_MAX}
            testId="branding-subheading"
            onChange={(value) => update({ subheading: value })}
          />
          <TextField
            label={t("branding.fields.footer")}
            value={draft.footer}
            max={BRANDING_FOOTER_MAX}
            testId="branding-footer"
            onChange={(value) => update({ footer: value })}
          />
          <TextField
            label={t("branding.fields.logoUrl")}
            value={draft.logoUrl ?? ""}
            max={BRANDING_LOGO_URL_MAX}
            testId="branding-logo-url"
            onChange={(value) => update({ logoUrl: value === "" ? null : value })}
          />
        </div>

        <p className="note">{t("branding.fields.logoHint")}</p>

        <div className="field-row">
          <button
            className="btn"
            type="button"
            disabled={saving}
            data-testid="branding-save"
            onClick={() => void submit()}
          >
            {saving ? t("branding.saving") : t("branding.save")}
          </button>
          <button
            className="btn btn-ghost btn-small"
            type="button"
            disabled={loading || saving}
            data-testid="branding-refresh"
            onClick={() => void refresh()}
          >
            {t("branding.refresh")}
          </button>
          <button
            className="btn btn-ghost btn-small"
            type="button"
            data-testid="branding-reset"
            onClick={reset}
          >
            {t("branding.reset")}
          </button>
        </div>
      </section>
    </div>
  );
}
