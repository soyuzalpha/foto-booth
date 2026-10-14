/**
 * Panel leads & analytics: data tamu, ekspor CSV, angka per acara, dan
 * konfigurasi field.
 *
 * Urutan blok mengikuti urutan kerja operator:
 *
 *   1. **angka per acara** — dibuka dulu untuk melihat acara mana yang jalan;
 *   2. **data tamu** — tindakan harian: lihat, unduh CSV, buang satu baris;
 *   3. **konfigurasi field** — diubah saat menyiapkan acara baru, jarang;
 *   4. **catatan consent** — pengingat UU PDP, bukan tombol.
 *
 * Sesi operator dipakai bersama tab Galeri (`useGallery()`): masuk sekali di
 * salah satu tab, dan tab lain langsung ikut. Panel ini **tidak** menyimpan
 * tokennya sendiri — dua salinan token cepat atau lambat berbeda.
 *
 * Kolom tabel data tamu **diturunkan dari field yang dikonfigurasi**, bukan
 * dari kunci yang kebetulan ada di baris-baris itu: kalau kolomnya mengikuti
 * data, dua acara menampilkan tabel dengan bentuk berbeda dan operator tidak
 * bisa membandingkan.
 */

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  LEAD_CONSENT_TEXT,
  LEAD_FIELD_TYPES,
  type CreateLeadField,
  type Lead,
  type LeadField,
  type LeadFieldType,
  type UpdateLeadField,
} from "@foto-booth/shared";

import { useGallery } from "../lib/gallery/galleryContext.ts";
import { downloadCsv } from "../lib/leads/downloadCsv.ts";
import { useLeads } from "../lib/leads/useLeads.ts";

/** Sesi belum ada: arahkan ke tab yang punya formulir masuknya. */
function SignedOutCard(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="card" data-testid="leads-signed-out">
      <h2>{t("leads.title")}</h2>
      <p className="note">{t("leads.signedOut")}</p>
    </section>
  );
}

function AnalyticsCard({
  analytics,
  loading,
}: {
  analytics: ReturnType<typeof useLeads>["analytics"];
  loading: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <section className="card card-wide" data-testid="leads-analytics">
      <div className="capture-head">
        <h2>{t("leads.analytics.title")}</h2>
        {analytics !== null && (
          <span className="badge" data-testid="leads-analytics-range">
            {analytics.from} → {analytics.to}
          </span>
        )}
      </div>

      {analytics === null ? (
        <p className="note" data-testid="leads-analytics-empty">
          {loading ? t("leads.loading") : t("leads.analytics.noData")}
        </p>
      ) : (
        <>
          <dl className="stat-row">
            <div className="row">
              <dt>{t("leads.analytics.events")}</dt>
              <dd data-testid="leads-total-events">{analytics.totals.events}</dd>
            </div>
            <div className="row">
              <dt>{t("leads.analytics.galleries")}</dt>
              <dd data-testid="leads-total-galleries">{analytics.totals.galleries}</dd>
            </div>
            <div className="row">
              <dt>{t("leads.analytics.photos")}</dt>
              <dd data-testid="leads-total-photos">{analytics.totals.photos}</dd>
            </div>
            <div className="row">
              <dt>{t("leads.analytics.views")}</dt>
              <dd data-testid="leads-total-views">{analytics.totals.views}</dd>
            </div>
            <div className="row">
              <dt>{t("leads.analytics.leads")}</dt>
              <dd data-testid="leads-total-leads">{analytics.totals.leads}</dd>
            </div>
          </dl>

          {analytics.events.length === 0 ? (
            <p className="note" data-testid="leads-analytics-no-events">
              {t("leads.analytics.empty")}
            </p>
          ) : (
            <ul className="gallery-list" data-testid="leads-event-list">
              {analytics.events.map((event) => (
                <li key={event.eventId} data-testid="leads-event-row">
                  <span className="gallery-hash">{event.name}</span>
                  <span className="muted small">{event.date}</span>
                  <span className="muted small">
                    {t("leads.analytics.cellGalleries", { count: event.galleries })}
                  </span>
                  <span className="muted small">
                    {t("leads.analytics.cellPhotos", { count: event.photos })}
                  </span>
                  <span className="muted small">
                    {t("leads.analytics.cellViews", { count: event.views })}
                  </span>
                  <span className="muted small">
                    {t("leads.analytics.cellLeads", { count: event.leads })}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="note">{t("leads.analytics.viewsNote")}</p>
        </>
      )}
    </section>
  );
}

/** Kolom tabel: field yang dikonfigurasi dulu, lalu kunci liar dari data lama. */
function columnKeys(fields: LeadField[], leads: Lead[]): string[] {
  const keys = fields.map((field) => field.key);
  const known = new Set(keys);

  for (const lead of leads) {
    for (const key of Object.keys(lead.values)) {
      if (!known.has(key)) {
        known.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

function LeadTable({ fields, leads }: { fields: LeadField[]; leads: Lead[] }): React.JSX.Element {
  const { t } = useTranslation();
  const columns = useMemo(() => columnKeys(fields, leads), [fields, leads]);
  const labels = useMemo(() => new Map(fields.map((field) => [field.key, field.label])), [fields]);

  return (
    <div className="table-scroll">
      <table className="data-table" data-testid="leads-table">
        <thead>
          <tr>
            <th>{t("leads.table.time")}</th>
            <th>{t("leads.table.gallery")}</th>
            <th>{t("leads.table.consent")}</th>
            {columns.map((key) => (
              <th key={key}>{labels.get(key) ?? key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr key={lead.id} data-testid="leads-row">
              <td>{lead.createdAt.slice(0, 16).replace("T", " ")}</td>
              <td>{lead.galleryId ?? t("leads.table.noGallery")}</td>
              <td>{lead.consent ? t("leads.table.yes") : t("leads.table.no")}</td>
              {columns.map((key) => {
                const value = lead.values[key];
                return (
                  <td key={key}>
                    {value === undefined
                      ? ""
                      : typeof value === "boolean"
                        ? value
                          ? t("leads.table.yes")
                          : t("leads.table.no")
                        : value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FieldConfig({
  fields,
  maxFields,
  createField,
  updateField,
  deleteField,
}: {
  fields: LeadField[];
  maxFields: number | null;
  createField: (body: CreateLeadField) => Promise<LeadField>;
  updateField: (id: string, body: UpdateLeadField) => Promise<LeadField>;
  deleteField: (id: string) => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation();

  const [label, setLabel] = useState("");
  const [type, setType] = useState<LeadFieldType>("text");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (label.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const body: CreateLeadField = {
        label: label.trim(),
        type,
        required,
        // `select` butuh pilihan; dipisah koma supaya operator bisa mengetik
        // "Laki-laki, Perempuan" apa adanya.
        options:
          type === "select"
            ? options
                .split(",")
                .map((option) => option.trim())
                .filter((option) => option !== "")
            : [],
        active: true,
      };
      await createField(body);
      setLabel("");
      setOptions("");
      setRequired(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [createField, label, options, required, type]);

  return (
    <section className="card card-wide" data-testid="leads-fields">
      <div className="capture-head">
        <h2>{t("leads.fields.title")}</h2>
        <span className="badge" data-testid="leads-field-count">
          {maxFields === null
            ? t("leads.fields.count", { count: fields.length })
            : t("leads.fields.countOf", { count: fields.length, max: maxFields })}
        </span>
      </div>
      <p className="note">{t("leads.fields.note")}</p>

      {error !== null && (
        <p className="banner banner-error" role="status" data-testid="leads-field-error">
          {error}
        </p>
      )}

      {fields.length === 0 ? (
        <p className="note" data-testid="leads-fields-empty">
          {t("leads.fields.empty")}
        </p>
      ) : (
        <ul className="gallery-list" data-testid="leads-field-list">
          {fields.map((field) => (
            <li key={field.id} data-testid="leads-field-row" data-active={field.active}>
              <span className="gallery-hash">{field.label}</span>
              <span className="muted small">{field.key}</span>
              <span className="muted small">{t(`leads.fieldType.${field.type}`)}</span>
              {field.required && <span className="badge badge-warn">{t("leads.fields.required")}</span>}
              <button
                className="btn btn-small btn-ghost"
                type="button"
                data-testid="leads-field-toggle"
                onClick={() => void updateField(field.id, { active: !field.active })}
              >
                {field.active ? t("leads.fields.deactivate") : t("leads.fields.activate")}
              </button>
              <button
                className="link"
                type="button"
                data-testid="leads-field-delete"
                onClick={() => void deleteField(field.id)}
              >
                {t("leads.fields.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="field-row">
        <label className="field">
          <span>{t("leads.fields.label")}</span>
          <input
            type="text"
            value={label}
            data-testid="leads-field-label"
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("leads.fields.type")}</span>
          <select
            value={type}
            data-testid="leads-field-type"
            onChange={(event) => setType(event.target.value as LeadFieldType)}
          >
            {LEAD_FIELD_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`leads.fieldType.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {type === "select" && (
          <label className="field">
            <span>{t("leads.fields.options")}</span>
            <input
              type="text"
              value={options}
              placeholder={t("leads.fields.optionsHint")}
              data-testid="leads-field-options"
              onChange={(event) => setOptions(event.target.value)}
            />
          </label>
        )}
        <label className="field field-check">
          <input
            type="checkbox"
            checked={required}
            data-testid="leads-field-required"
            onChange={(event) => setRequired(event.target.checked)}
          />
          <span>{t("leads.fields.requiredLabel")}</span>
        </label>
        <button
          className="btn"
          type="button"
          disabled={busy || label.trim() === ""}
          data-testid="leads-field-add"
          onClick={() => void submit()}
        >
          {busy ? t("leads.saving") : t("leads.fields.add")}
        </button>
      </div>
    </section>
  );
}

export default function LeadsPanel(): React.JSX.Element {
  const { t } = useTranslation();
  const { session } = useGallery();
  const token = session?.token ?? null;

  const {
    fields,
    maxFields,
    leads,
    analytics,
    loading,
    error,
    refresh,
    exportCsv,
    removeLead,
    createField,
    updateField,
    deleteField,
  } = useLeads({ token });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const doExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      const result = await exportCsv();
      downloadCsv(result.filename, result.csv);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [exportCsv]);

  if (session === null) {
    return (
      <div data-testid="panel-leads">
        <SignedOutCard />
      </div>
    );
  }

  return (
    <div data-testid="panel-leads">
      <AnalyticsCard analytics={analytics} loading={loading} />

      <section className="card card-wide" data-testid="leads-data">
        <div className="capture-head">
          <h2>{t("leads.data.title")}</h2>
          <span className="badge" data-testid="leads-count">
            {t("leads.data.count", { count: leads.length })}
          </span>
        </div>

        {error !== null && (
          <p className="banner banner-error" role="status" data-testid="leads-error">
            {error}
          </p>
        )}
        {exportError !== null && (
          <p className="banner banner-error" role="status" data-testid="leads-export-error">
            {exportError}
          </p>
        )}

        <div className="field-row">
          <button
            className="btn btn-ghost btn-small"
            type="button"
            disabled={loading}
            data-testid="leads-refresh"
            onClick={() => void refresh()}
          >
            {loading ? t("leads.loading") : t("leads.refresh")}
          </button>
          <button
            className="btn btn-small"
            type="button"
            disabled={exporting || leads.length === 0}
            data-testid="leads-export"
            onClick={() => void doExport()}
          >
            {exporting ? t("leads.exporting") : t("leads.export")}
          </button>
        </div>

        {leads.length === 0 ? (
          <p className="note" data-testid="leads-empty">
            {t("leads.data.empty")}
          </p>
        ) : (
          <>
            <LeadTable fields={fields} leads={leads} />
            <ul className="gallery-list" data-testid="leads-delete-list">
              {leads.map((lead) => (
                <li key={lead.id} data-testid="leads-delete-row">
                  <span className="muted small">{lead.createdAt.slice(0, 16).replace("T", " ")}</span>
                  <span className="muted small">{lead.galleryId ?? t("leads.table.noGallery")}</span>
                  <button
                    className="link"
                    type="button"
                    data-testid="leads-delete"
                    onClick={() => void removeLead(lead.id)}
                  >
                    {t("leads.data.delete")}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <FieldConfig
        fields={fields}
        maxFields={maxFields}
        createField={createField}
        updateField={updateField}
        deleteField={deleteField}
      />

      <section className="card card-wide" data-testid="leads-consent">
        <h2>{t("leads.consent.title")}</h2>
        <p className="note">{t("leads.consent.note")}</p>
        <blockquote className="consent-text" data-testid="leads-consent-text">
          {LEAD_CONSENT_TEXT}
        </blockquote>
      </section>
    </div>
  );
}
