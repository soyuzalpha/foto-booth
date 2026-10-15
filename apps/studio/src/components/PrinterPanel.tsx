/**
 * Panel printer & diagnostik (Fase 12, FEATURE-MATRIX #45, #80, #81, #88).
 *
 * Diurutkan berdasar apa yang dibutuhkan operator saat booth bermasalah:
 *
 *   1. **Printer mana yang dipakai** — pilihan yang bertahan antar-reload;
 *   2. **Apa yang terlihat** — termasuk yang bermasalah, dengan transportnya;
 *   3. **Diagnostik** — satu tombol untuk membuat laporan siap kirim, karena
 *      inilah yang diminta teknisi saat dihubungi.
 *
 * Panel ini **tidak** mencetak. Mencetak tetap tugas `PrintQueuePanel`; di sini
 * hanya jawaban "printer mana" yang dipakai auto-print.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DiagnosticReport } from "@foto-booth/shared";
import {
  APP_VERSION,
  buildDiagnosticReport,
  diagnosticFileName,
  diagnosticReportText,
  readinessLabel,
  readinessScore,
  missingCapabilities,
  CAPABILITY_LABELS,
} from "@foto-booth/shared";

import { usePrinters, desktopBridge } from "../lib/print/usePrinters.ts";
import {
  detectRuntimeName,
  isSecureContext,
  probeCapabilities,
} from "../lib/diagnostics/runtimeCapabilities.ts";

export default function PrinterPanel(): React.JSX.Element {
  const { t } = useTranslation();
  const printers = usePrinters();
  const [copied, setCopied] = useState(false);
  const [report, setReport] = useState<DiagnosticReport | null>(null);

  const bridge = desktopBridge();

  const buildReportData = (): DiagnosticReport => {
    return buildDiagnosticReport({
      appVersion: APP_VERSION,
      generatedAt: new Date().toISOString(),
      runtime: detectRuntimeName({
        hasDesktopBridge: bridge !== null,
        isCapacitor: printers.transport === "capacitor",
      }),
      runtimeVersion: bridge?.versions?.electron ?? null,
      platform: typeof navigator === "undefined" ? null : navigator.platform,
      userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
      secureContext: isSecureContext(),
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      capabilities: probeCapabilities(),
      printers: printers.printers,
      printersSummary: printers.summary,
      notes: printers.problems,
    });
  };

  const buildReport = (): void => {
    setReport(buildReportData());
  };

  const reportText = report === null ? null : diagnosticReportText(report);

  const copyReport = (): void => {
    const text = reportText;
    if (text === null || text === "") return;

    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false),
    );
  };

  /**
   * Simpan laporan lewat dialog sistem. Hanya ada di shell desktop — di web
   * tombol ini tidak ditampilkan sama sekali, jadi tidak ada jalan buntu.
   */
  const saveReport = (): void => {
    if (bridge?.saveFile === undefined) return;
    const built = report ?? buildReportData();
    void bridge.saveFile({ name: diagnosticFileName(built), data: diagnosticReportText(built) });
  };

  const caps = probeCapabilities();
  const score = readinessScore(caps);
  const missing = missingCapabilities(caps);

  return (
    <section className="panel" data-testid="panel-printer">
      <h2>{t("printer.title")}</h2>
      <p className="muted">{t("printer.subtitle")}</p>

      {/* 1. Printer yang dipakai */}
      <div className="printer-chosen" data-testid="printer-chosen">
        <strong>{t("printer.chosen")}: </strong>
        {printers.loading ? (
          <span className="muted">{t("printer.loading")}</span>
        ) : printers.chosen === null ? (
          <span className="muted">{t("printer.none")}</span>
        ) : (
          <span data-testid="printer-chosen-name">
            {printers.chosen.name} <span className="muted">({printers.chosen.transport})</span>
          </span>
        )}
      </div>

      {printers.chosenMissing && (
        <p className="warn" data-testid="printer-chosen-missing">
          {t("printer.chosenMissing")}
        </p>
      )}

      {/* 2. Daftar printer */}
      <label className="field">
        <span>{t("printer.select")}</span>
        <select
          data-testid="printer-select"
          value={printers.preference.printerId ?? ""}
          onChange={(event) =>
            printers.select(event.target.value === "" ? null : event.target.value)
          }
        >
          <option value="">{t("printer.systemDefault")}</option>
          {printers.printers.map((printer) => (
            <option key={printer.id} value={printer.id}>
              {printer.name} — {printer.status}
              {printer.isDefault ? ` (${t("printer.defaultTag")})` : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="field field-check">
        <input
          type="checkbox"
          data-testid="printer-silent"
          checked={printers.preference.silent}
          disabled={printers.transport !== "electron"}
          onChange={(event) => printers.setSilent(event.target.checked)}
        />
        <span>{t("printer.silent")}</span>
      </label>
      {printers.transport !== "electron" && (
        <p className="muted">{t("printer.silentOnlyDesktop")}</p>
      )}

      <button
        className="btn"
        type="button"
        data-testid="printer-refresh"
        onClick={() => void printers.refresh()}
      >
        {t("printer.refresh")}
      </button>

      <p className="muted" data-testid="printer-summary">
        {printers.summary.note} · {t("printer.transport")}: {printers.transport}
      </p>

      {printers.problems.length > 0 && (
        <ul className="warn" data-testid="printer-problems">
          {printers.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {/* 3. Diagnostik */}
      <h3>{t("diagnostics.title")}</h3>
      <p className="muted" data-testid="diagnostics-score">
        {t("diagnostics.readiness")}: {score}/100 ({readinessLabel(score)})
      </p>

      <ul data-testid="diagnostics-capabilities">
        {missing.length === 0 ? (
          <li>{t("diagnostics.allPresent")}</li>
        ) : (
          missing.map((key) => (
            <li key={key}>{t("diagnostics.missing", { name: CAPABILITY_LABELS[key] })}</li>
          ))
        )}
      </ul>

      <div className="row">
        <button
          className="btn"
          type="button"
          data-testid="diagnostics-build"
          onClick={buildReport}
        >
          {t("diagnostics.build")}
        </button>
        <button
          className="btn"
          type="button"
          data-testid="diagnostics-copy"
          disabled={reportText === null}
          onClick={copyReport}
        >
          {copied ? t("diagnostics.copied") : t("diagnostics.copy")}
        </button>
        {bridge?.saveFile !== undefined && (
          <button
            className="btn"
            type="button"
            data-testid="diagnostics-save"
            onClick={saveReport}
          >
            {t("diagnostics.save")}
          </button>
        )}
      </div>

      {reportText !== null && (
        <textarea
          className="diagnostics-text"
          data-testid="diagnostics-text"
          readOnly
          value={reportText}
          rows={12}
        />
      )}
    </section>
  );
}

