/**
 * Panel antrean cetak (Fase 9, FEATURE-MATRIX #44 & #46 · Fase 12, #45/#80/#88).
 *
 * Yang ditampilkan di sini bukan sekadar daftar tugas. Auto-print berarti kiosk
 * mencetak tanpa operator menyentuh apa pun; kalau ada lembar yang tidak keluar,
 * panel ini satu-satunya tempat kejadian itu terlihat. Karena itu urutannya:
 *
 *   1. **ringkasan** — berapa antre, berapa lembar sudah keluar;
 *   2. **tugas yang perlu perhatian** — gagal lebih dulu, karena itu yang
 *      menuntut tindakan;
 *   3. **tugas selesai** — riwayat, boleh dibersihkan.
 *
 * Panel **tidak** memilih gambar sendiri: `PrintJob` di `packages/shared`
 * sengaja tidak membawa blob. Gambar ditempelkan lewat `registerImage`, dan
 * pencetak bisa diganti lewat prop `print` (dipakai tes & integrasi kiosk).
 *
 * **Sejak Fase 12 panel memilih pencetaknya sendiri.** Tanpa prop `print`, ia
 * memakai `desktopPrinter`: jalur Electron (printer bernama, tanpa dialog) kalau
 * jembatan desktopnya ada, dan jatuh ke iframe browser kalau tidak. Prop `print`
 * tetap menang supaya tes dan panel debug tidak pernah benar-benar mencetak.
 */

import { useTranslation } from "react-i18next";

import type { PrintJob, PrintJobStatus } from "@foto-booth/shared";

import { browserPrinter, usePrintQueue } from "../lib/print/usePrintQueue.ts";
import type { PrintFn } from "../lib/print/printQueueRunner.ts";
import { desktopPrinter } from "../lib/print/desktopPrinter.ts";
import { desktopBridge, usePrinters } from "../lib/print/usePrinters.ts";

const STATUS_ORDER: readonly PrintJobStatus[] = ["printing", "queued", "failed", "done"];

/** Urutan tampil: yang gagal naik ke atas supaya tidak terlewat. */
function byAttention(a: PrintJob, b: PrintJob): number {
  const rank = (job: PrintJob): number => {
    if (job.status === "failed") return 0;
    if (job.status === "printing") return 1;
    if (job.status === "queued") return 2;
    return 3;
  };
  return rank(a) - rank(b) || a.seq - b.seq;
}

function JobRow({
  job,
  onReprint,
}: {
  job: PrintJob;
  onReprint: (seq: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const statusLabel = t(`print.status.${job.status}`);

  return (
    <li className="print-job" data-testid={`print-job-${job.seq}`} data-status={job.status}>
      <div className="print-job-main">
        <span className={`badge badge-${job.status}`}>{statusLabel}</span>
        <span className="print-job-id">{job.id}</span>
        <span className="muted small">
          {t("print.copies", { count: job.copies })} · {t("print.attempts", { count: job.attempts })}
        </span>
        {job.reprintOf !== null && (
          <span className="muted small">{t("print.reprintOf", { seq: job.reprintOf })}</span>
        )}
      </div>
      {job.lastError !== null && <p className="print-job-error">{job.lastError}</p>}
      {(job.status === "done" || job.status === "failed") && (
        <button type="button" onClick={() => onReprint(job.seq)}>
          {t("print.reprint")}
        </button>
      )}
    </li>
  );
}

export default function PrintQueuePanel({ print }: { print?: PrintFn }): React.JSX.Element {
  const { t } = useTranslation();

  // Printer yang dipilih operator di panel Printer & diagnostik. Dibaca di sini
  // supaya cetakan benar-benar menuju printer itu, bukan printer bawaan sistem.
  const printers = usePrinters();

  const queue = usePrintQueue(
    print !== undefined
      ? { print }
      : {
          makePrint: (resolveImage) =>
            desktopPrinter({
              bridge: desktopBridge(),
              getTransport: () => printers.transport,
              getDeviceName: () =>
                printers.chosen === null ? null : printers.chosen.name,
              getSilent: () => printers.preference.silent,
              resolveImage,
              fallback: browserPrinter(resolveImage),
            }),
        },
  );

  const jobs = queue.jobs.slice().sort(byAttention);
  const summary = queue.summary;

  const viaDesktop =
    print === undefined &&
    printers.transport === "electron" &&
    printers.chosen !== null &&
    desktopBridge() !== null;

  return (
    <section className="panel" data-testid="print-panel">
      <header className="panel-head">
        <h2>{t("print.title")}</h2>
        <div className="row">
          <button type="button" onClick={() => void queue.runNext()} disabled={queue.busy}>
            {t("print.runNext")}
          </button>
          <button type="button" onClick={queue.clearFinished}>
            {t("print.clear")}
          </button>
        </div>
      </header>

      {queue.error !== null && <p className="error">{queue.error}</p>}

      <p className="muted" data-testid="print-route">
        {viaDesktop
          ? t("print.routeDesktop", {
              name: printers.chosen?.name ?? "",
              silent: printers.preference.silent ? t("print.silentOn") : t("print.silentOff"),
            })
          : t("print.routeBrowser")}
      </p>

      <div className="print-summary" data-testid="print-summary">
        {STATUS_ORDER.map((status) => (
          <div key={status} className="print-summary-cell">
            <span className="print-summary-value">{summary[status]}</span>
            <span className="muted small">{t(`print.status.${status}`)}</span>
          </div>
        ))}
        <div className="print-summary-cell">
          <span className="print-summary-value">{summary.sheetsPrinted}</span>
          <span className="muted small">{t("print.sheets")}</span>
        </div>
      </div>

      {jobs.length === 0 ? (
        <p className="note">{t("print.empty")}</p>
      ) : (
        <ul className="print-jobs">
          {jobs.map((job) => (
            <JobRow key={job.seq} job={job} onReprint={(seq) => queue.reprint(seq)} />
          ))}
        </ul>
      )}
    </section>
  );
}
