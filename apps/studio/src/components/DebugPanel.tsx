/**
 * Panel debug kiosk — muncul hanya kalau mode debug dinyalakan.
 *
 * Kenapa panel ini ada: meja foto booth sering tanpa keyboard dan tanpa orang
 * teknis. Kalau foto gagal terkirim atau model AI tidak mau jalan, satu-satunya
 * cara memeriksa adalah membaca keadaan dari layar. Karena itu panel ini
 * menampilkan **angka dan sebab** (kuota, service worker, cache model), bukan
 * cuma "OK".
 *
 * Dinyalakan lewat `?debug=1` atau tersimpan di `localStorage`. Tanpa itu
 * komponen ini mengembalikan `null` — nol DOM, nol biaya, dan itu memang
 * perilaku yang diuji.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEBUG_STORAGE_KEY,
  parseDebugFlag,
  summarizeStorageReport,
  type StorageReport,
  type StorageSummary,
} from "../lib/debug/debugMode.ts";
import { browserReportSources, collectStorageReport } from "../lib/debug/storageReport.ts";
import { createModelCache } from "../lib/models/modelCache.ts";
import { useServiceWorkerStatus } from "../lib/useServiceWorkerStatus.ts";

function readStoredFlag(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(DEBUG_STORAGE_KEY);
  } catch {
    return null;
  }
}

export default function DebugPanel(): React.JSX.Element | null {
  const { t } = useTranslation();
  const sw = useServiceWorkerStatus();

  const [enabled] = useState<boolean>(() =>
    parseDebugFlag(typeof location === "undefined" ? "" : location.search, readStoredFlag()),
  );
  const [report, setReport] = useState<StorageReport | null>(null);
  const [summary, setSummary] = useState<StorageSummary | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    // Cache model dibuat sekali per pemanggilan; `caches` global dipakai apa
    // adanya — kalau tidak ada, `modelCache.has` mengembalikan false.
    const modelCache = createModelCache({
      caches: typeof caches === "undefined" ? null : caches,
    });
    const collected = await collectStorageReport(
      browserReportSources(modelCache, sw === "active"),
    );
    setReport(collected);
    setSummary(summarizeStorageReport(collected));
  }, [sw]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  if (!enabled) return null;

  return (
    <section className="card card-wide" data-testid="debug-panel">
      <h2>{t("debug.title")}</h2>

      {summary === null ? (
        <p className="note">{t("status.checking")}</p>
      ) : (
        <>
          <dl data-testid="debug-lines">
            {summary.lines.map((line) => (
              <div className="row" key={line}>
                <dd>{line}</dd>
              </div>
            ))}
          </dl>

          {summary.warnings.length > 0 && (
            <ul className="debug-warnings" data-testid="debug-warnings">
              {summary.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </>
      )}

      <p className="note">
        {report === null ? "" : t("debug.hint")}
      </p>

      <div className="field-row" style={{ marginTop: 12 }}>
        <button
          className="btn btn-small"
          type="button"
          data-testid="debug-refresh"
          onClick={() => void refresh()}
        >
          {t("debug.refresh")}
        </button>
      </div>
    </section>
  );
}
