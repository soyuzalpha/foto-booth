/**
 * Panel editor template — bagian stateful dari Fase 2.
 *
 * Ini satu-satunya komponen yang tahu soal penyimpanan template & foto, dan
 * yang memanggil export. Kanvas (`TemplateEditor`) dan daftar (`TemplateList`)
 * tetap bodoh.
 *
 * Alur yang dijaga:
 *   · editor mulai dari template bawaan **atau** template tersimpan terbaru,
 *     jadi membuka aplikasi tidak pernah menampilkan kanvas kosong;
 *   · export selalu pada resolusi cetak penuh (inci × dpi), dan panel
 *     **melaporkan jalur render** yang benar-benar dipakai (worker / main
 *     thread) — bukan menebak;
 *   · foto sesi terakhir dipakai sebagai pratinjau, dan object URL-nya dilepas
 *     saat diganti.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  PRINT_PRESETS,
  TEMPLATE_SIZE_PRESETS,
  nearestPrintPreset,
  printPresetById,
  templatePixelSize,
  type Template,
  type TemplateText,
  type TokenValues,
} from "@foto-booth/shared";

import { createFrameStore } from "../lib/capture/frameStore.ts";
import { editorReducer, createEditorState, isDirty } from "../lib/template/editorState.ts";
import type { ExportFormat } from "../lib/template/exportPng.ts";
import { downloadBlob } from "../lib/template/exportPng.ts";
import { defaultStripTemplate, newId, presetById, resizeTemplate, touchTemplate } from "../lib/template/model.ts";
import { loadLatestSessionFrames } from "../lib/template/previewFrames.ts";
import type { FrameImage } from "../lib/template/render.ts";
import {
  browserOffThreadDeps,
  renderStrip,
  supportsOffThread,
  type RenderResult,
} from "../lib/template/renderOffThread.ts";
import { resolveTokenValues } from "../lib/template/tokens.ts";
import { useTemplates } from "../lib/useTemplates.ts";
import { useStarterTemplates, type StarterTemplate } from "../lib/content/useStarterTemplates.ts";
import {
  exportPrintSheet,
  type ExportedSheet,
} from "../lib/print/exportPrint.ts";
import { planPrintSheet, printSheetPlanSummary } from "../lib/print/printLayout.ts";
import { blobToDataUrl, printImage, type PrintHandle } from "../lib/print/printBrowser.ts";
import TemplateEditor from "./TemplateEditor.tsx";
import TemplateList from "./TemplateList.tsx";

/** Hasil export terakhir + URL blob untuk pratinjau/unduh ulang. */
interface LastExport extends RenderResult {
  url: string;
}

/** Lembar cetak terakhir + URL blob untuk pratinjau/unduh ulang. */
interface LastSheet extends ExportedSheet {
  url: string;
}

export default function TemplatePanel(): React.JSX.Element {
  const { t } = useTranslation();
  const api = useTemplates();
  const starters = useStarterTemplates();

  const [state, dispatch] = useReducer(editorReducer, undefined, () =>
    createEditorState(defaultStripTemplate()),
  );
  const template: Template = state.template;

  const [activeId, setActiveId] = useState<string | null>(null);
  const [eventName, setEventName] = useState("");
  const [preview, setPreview] = useState<{ frames: (FrameImage | null)[]; blobs: (Blob | null)[] }>({
    frames: [],
    blobs: [],
  });
  const [previewNote, setPreviewNote] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [lastExport, setLastExport] = useState<LastExport | null>(null);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);

  // ── cetak ─────────────────────────────────────────────────────────────
  const [printPresetId, setPrintPresetId] = useState<string>(() =>
    nearestPrintPreset(template.size.width, template.size.height).id,
  );
  const [includeBleed, setIncludeBleed] = useState(false);
  const [lastSheet, setLastSheet] = useState<LastSheet | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);

  const releaseRef = useRef<(() => void) | null>(null);
  const exportUrlRef = useRef<string | null>(null);
  const sheetUrlRef = useRef<string | null>(null);
  const printHandleRef = useRef<PrintHandle | null>(null);
  const initializedRef = useRef(false);

  const tokens: TokenValues = useMemo(
    () => resolveTokenValues({ eventName, custom: eventName, now: new Date() }),
    [eventName],
  );

  // ── pratinjau: foto dari sesi terakhir ────────────────────────────────
  const loadPreview = useCallback(async (): Promise<void> => {
    const { store } = createFrameStore();
    const loaded = await loadLatestSessionFrames(store);

    releaseRef.current?.();
    releaseRef.current = loaded.release;
    setPreview({ frames: loaded.frames, blobs: loaded.blobs });
    setPreviewNote(
      loaded.sessionId === null
        ? t("template.previewEmpty")
        : t("template.previewLoaded", { count: loaded.count }),
    );
  }, [t]);

  useEffect(() => {
    void loadPreview();
    return () => {
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, [loadPreview]);

  // ── buka template tersimpan terbaru begitu daftar siap ────────────────
  useEffect(() => {
    if (api.loading || initializedRef.current) return;
    initializedRef.current = true;
    if (api.templates.length === 0) return;

    const newest = [...api.templates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (newest === undefined) return;
    dispatch({ type: "replace", template: newest });
    setActiveId(newest.id);
  }, [api.loading, api.templates]);

  // Buang object URL export sebelumnya — kalau tidak, tiap export meninggalkan
  // blob hidup sampai tab ditutup.
  useEffect(
    () => () => {
      if (exportUrlRef.current !== null) URL.revokeObjectURL(exportUrlRef.current);
      if (sheetUrlRef.current !== null) URL.revokeObjectURL(sheetUrlRef.current);
      printHandleRef.current?.dispose();
      printHandleRef.current = null;
    },
    [],
  );

  // ── aksi ──────────────────────────────────────────────────────────────

  const handleNew = (): void => {
    const fresh = defaultStripTemplate();
    dispatch({ type: "replace", template: fresh });
    setActiveId(null);
    setLastExport(null);
  };

  const handleOpen = (id: string): void => {
    const found = api.templates.find((item) => item.id === id);
    if (found === undefined) return;
    dispatch({ type: "replace", template: found });
    setActiveId(found.id);
  };

  /**
   * Buka template bawaan dari katalog konten (Fase 3 §B39).
   *
   * Starter **tidak** langsung disimpan: user dulu boleh ubah, baru Save.
   * `activeId` dikosongkan supaya tidak terlihat seperti template tersimpan —
   * kalau nanti di-Save, `touchTemplate` memberi id baru lewat `api.save`.
   */
  const handleOpenStarter = (starter: StarterTemplate): void => {
    // Salinan dengan id baru: kalau id katalog dipakai apa adanya, Save pertama
    // langsung menimpa entri katalog dan user kehilangan aslinya.
    const copy: Template = {
      ...structuredClone(starter.template),
      id: newId("tpl"),
      name: `${starter.name} (salinan)`,
    };
    dispatch({ type: "replace", template: copy });
    setActiveId(null);
    setLastExport(null);
    setLastSheet(null);
    setPrintPresetId(nearestPrintPreset(copy.size.width, copy.size.height).id);
  };

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    try {
      const saved = touchTemplate(template, new Date());
      await api.save(saved);
      dispatch({ type: "replace", template: saved });
      dispatch({ type: "select", selection: null });
      setActiveId(saved.id);
      dispatch({ type: "markSaved" });
    } finally {
      setBusy(false);
    }
  };

  const handleSize = (presetId: string): void => {
    const preset = presetById(presetId);
    if (preset === null) return;
    dispatch({ type: "replace", template: resizeTemplate(template, preset) });
    setLastExport(null);
    setLastSheet(null);
    // Ukuran template berubah → preset kertas yang paling dekat juga berubah.
    setPrintPresetId(nearestPrintPreset(preset.width, preset.height).id);
  };

  /**
   * Frame untuk export.
   *
   * Kalau `createImageBitmap` ada, tiap blob diubah jadi `ImageBitmap` **baru**.
   * Itu syarat jalur worker: `ImageBitmap` bisa dipindah ke Worker, sementara
   * `HTMLImageElement` yang dipakai kanvas editor tidak bisa — dan kalau
   * dipaksa, `postMessage` melempar dan export cuma pura-pura off-thread.
   */
  const buildExportFrames = async (): Promise<(FrameImage | null)[]> => {
    if (typeof createImageBitmap !== "function") return preview.frames;

    const built: (FrameImage | null)[] = [];
    for (const blob of preview.blobs) {
      if (blob === null) {
        built.push(null);
        continue;
      }
      const bitmap = await createImageBitmap(blob);
      built.push({
        image: bitmap as unknown as CanvasImageSource,
        width: bitmap.width,
        height: bitmap.height,
      });
    }
    return built;
  };

  const handleExport = async (format: ExportFormat): Promise<void> => {
    setBusy(true);
    setFallbackReason(null);
    try {
      const frames = await buildExportFrames();
      const result = await renderStrip(template, browserOffThreadDeps(), {
        frames,
        tokens,
        format,
        now: new Date(),
        onFallback: (reason) => setFallbackReason(reason),
      });

      downloadBlob(result.blob, result.filename);

      if (exportUrlRef.current !== null) URL.revokeObjectURL(exportUrlRef.current);
      const url = URL.createObjectURL(result.blob);
      exportUrlRef.current = url;

      setLastExport({ ...result, url, offThread: result.offThread });
    } catch (cause) {
      setFallbackReason(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // ── cetak ─────────────────────────────────────────────────────────────

  /**
   * Render lembar cetak, simpan blob-nya, dan kembalikan hasilnya.
   *
   * Dipakai oleh **unduh** dan **cetak**. Keduanya harus memakai render yang
   * sama supaya yang diunduh dan yang dicetak tidak pernah berbeda — kalau
   * tidak, user bisa mengunduh satu versi lalu mencetak versi lain.
   */
  const buildSheet = async (): Promise<LastSheet> => {
    const preset = printPresetById(printPresetId);
    if (preset === null) throw new Error(`preset cetak tidak dikenal: ${printPresetId}`);

    const frames = await buildExportFrames();
    const result = await exportPrintSheet(template, preset, browserOffThreadDeps(), {
      frames,
      tokens,
      includeBleed,
      format: "png",
      now: new Date(),
    });

    if (sheetUrlRef.current !== null) URL.revokeObjectURL(sheetUrlRef.current);
    const url = URL.createObjectURL(result.blob);
    sheetUrlRef.current = url;

    const sheet: LastSheet = { ...result, url };
    setLastSheet(sheet);
    return sheet;
  };

  const handlePrint = async (): Promise<void> => {
    setBusy(true);
    setPrintError(null);
    try {
      const sheet = await buildSheet();

      // Lepas iframe sebelumnya kalau user menekan Cetak dua kali cepat.
      printHandleRef.current?.dispose();

      // Data URL, bukan blob URL: dokumen di dalam iframe tidak selalu boleh
      // membaca blob URL milik halaman induk (orisinnya opaque).
      const dataUrl = await blobToDataUrl(sheet.blob);
      const preset = printPresetById(printPresetId);
      printHandleRef.current = printImage(
        preset ?? { name: template.name, width: 2, height: 6, bleed: 0 },
        dataUrl,
        {},
      );
    } catch (cause) {
      setPrintError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handlePrintDownload = async (): Promise<void> => {
    setBusy(true);
    setPrintError(null);
    try {
      const sheet = await buildSheet();
      downloadBlob(sheet.blob, sheet.filename);
    } catch (cause) {
      setPrintError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const selected = state.selected;
  const selectedText =
    selected?.kind === "text"
      ? (template.textElements.find((item) => item.id === selected.id) ?? null)
      : null;
  const selectedFrame =
    selected?.kind === "frame"
      ? (template.frames.find((item) => item.id === selected.id) ?? null)
      : null;
  const pixels = templatePixelSize(template.size);

  // Rencana lembar cetak dihitung dari template + preset yang dipilih. Ini
  // murni angka (tanpa canvas), jadi bisa ditampilkan dan diukur validator
  // sebelum satu piksel pun digambar.
  const printPreset =
    printPresetById(printPresetId) ??
    nearestPrintPreset(template.size.width, template.size.height);
  const sheetPlan = useMemo(
    () => planPrintSheet(template, printPreset, { includeBleed }),
    [template, printPreset, includeBleed],
  );
  const sheetPlanText = printSheetPlanSummary(sheetPlan);

  const renderPath = lastExport === null ? "—" : lastExport.offThread ? "worker" : "main-thread";

  return (
    <section
      className="tpl"
      data-testid="template-panel"
      data-template-pixels={`${pixels.width}x${pixels.height}`}
      data-dirty={isDirty(state) ? "1" : "0"}
      data-export-size={lastExport === null ? "" : `${lastExport.width}x${lastExport.height}`}
      data-export-bytes={lastExport === null ? "" : String(lastExport.bytes)}
      data-export-path={renderPath}
      data-export-filename={lastExport === null ? "" : lastExport.filename}
      data-offthread-capable={supportsOffThread() ? "1" : "0"}
      data-fallback-reason={fallbackReason ?? ""}
      data-print-preset={printPreset.id}
      data-print-bleed={includeBleed ? "1" : "0"}
      data-print-plan={sheetPlanText}
      data-print-filename={lastSheet === null ? "" : lastSheet.filename}
      data-print-size={lastSheet === null ? "" : `${lastSheet.width}x${lastSheet.height}`}
      data-print-error={printError ?? ""}
    >
      <header className="tpl-head">
        <h2>{t("template.title")}</h2>
        <p className="note small">{t("template.subtitle")}</p>

        <div className="tpl-toolbar">
          <label className="field">
            <span>{t("template.name")}</span>
            <input
              type="text"
              data-testid="tpl-name"
              value={template.name}
              onChange={(event) => dispatch({ type: "rename", name: event.target.value })}
            />
          </label>

          <label className="field">
            <span>{t("template.size")}</span>
            <select
              data-testid="tpl-size"
              value={presetIdOf(template)}
              onChange={(event) => handleSize(event.target.value)}
            >
              {TEMPLATE_SIZE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
              {presetIdOf(template) === "" && <option value="">{t("template.sizeCustom")}</option>}
            </select>
          </label>

          <label className="field">
            <span>{t("template.eventName")}</span>
            <input
              type="text"
              data-testid="tpl-event"
              value={eventName}
              placeholder={t("template.eventPlaceholder")}
              onChange={(event) => setEventName(event.target.value)}
            />
          </label>
        </div>

        <div className="tpl-toolbar tpl-toolbar-buttons">
          <button className="btn-small" type="button" data-testid="tpl-undo" disabled={state.past.length === 0} onClick={() => dispatch({ type: "undo" })}>
            {t("template.undo")}
          </button>
          <button className="btn-small" type="button" data-testid="tpl-redo" disabled={state.future.length === 0} onClick={() => dispatch({ type: "redo" })}>
            {t("template.redo")}
          </button>
          <button className="btn-small btn-ghost" type="button" data-testid="tpl-add-text" onClick={() => dispatch({ type: "addText" })}>
            {t("template.addText")}
          </button>
          <button className="btn-small btn-ghost" type="button" data-testid="tpl-delete" disabled={selected === null} onClick={() => dispatch({ type: "delete" })}>
            {t("template.deleteElement")}
          </button>
          <button className="btn-small" type="button" data-testid="tpl-save" disabled={busy} onClick={() => void handleSave()}>
            {t("template.save")}
          </button>
          <button className="btn-small" type="button" data-testid="tpl-reload-frames" onClick={() => void loadPreview()}>
            {t("template.reloadFrames")}
          </button>
          <button className="btn-small" type="button" data-testid="tpl-export-png" disabled={busy} onClick={() => void handleExport("png")}>
            {t("template.exportPng")}
          </button>
          <button className="btn-small" type="button" data-testid="tpl-export-jpeg" disabled={busy} onClick={() => void handleExport("jpeg")}>
            {t("template.exportJpeg")}
          </button>
        </div>

        <div className="tpl-toolbar tpl-toolbar-print" data-testid="tpl-print-bar">
          <label className="field">
            <span>{t("template.printPaper")}</span>
            <select
              data-testid="tpl-print-preset"
              value={printPresetId}
              onChange={(event) => {
                setPrintPresetId(event.target.value);
                setLastSheet(null);
              }}
            >
              {PRINT_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>

          <label className="check" title={t("template.printBleedHint")}>
            <input
              type="checkbox"
              data-testid="tpl-print-bleed"
              checked={includeBleed}
              onChange={(event) => {
                setIncludeBleed(event.target.checked);
                setLastSheet(null);
              }}
            />
            <span>{t("template.printBleed")}</span>
          </label>

          <button className="btn-small" type="button" data-testid="tpl-print-now" disabled={busy} onClick={() => void handlePrint()}>
            {t("template.printNow")}
          </button>
          <button className="btn-small btn-ghost" type="button" data-testid="tpl-print-download" disabled={busy} onClick={() => void handlePrintDownload()}>
            {t("template.printDownload")}
          </button>
        </div>
      </header>

      <div className="tpl-grid">
        <TemplateList
          templates={api.templates}
          activeId={activeId}
          loading={api.loading}
          storageKind={api.kind}
          starters={starters.starters}
          onOpen={handleOpen}
          onOpenStarter={handleOpenStarter}
          onDelete={(id) => void api.remove(id)}
          onNew={handleNew}
        />

        <TemplateEditor state={state} dispatch={dispatch} frames={preview.frames} tokens={tokens} />

        <div className="tpl-inspector" data-testid="tpl-inspector">
          <h3>{t("template.inspector")}</h3>
          <p className="note small" data-testid="tpl-preview-note">
            {previewNote}
          </p>

          {selectedText !== null ? (
            <>
              <label className="field">
                <span>{t("template.textContent")}</span>
                <input
                  type="text"
                  data-testid="tpl-text-content"
                  value={selectedText.text}
                  onChange={(event) =>
                    dispatch({
                      type: "updateText",
                      id: selectedText.id,
                      patch: { text: event.target.value } satisfies Partial<TemplateText>,
                    })
                  }
                />
              </label>

              <label className="field">
                <span>{t("template.fontSize")}</span>
                <input
                  type="number"
                  min={8}
                  max={400}
                  data-testid="tpl-font-size"
                  value={selectedText.fontSize}
                  onChange={(event) =>
                    dispatch({
                      type: "updateText",
                      id: selectedText.id,
                      patch: { fontSize: Number(event.target.value) },
                    })
                  }
                />
              </label>

              <label className="field">
                <span>{t("template.color")}</span>
                <input
                  type="color"
                  data-testid="tpl-text-color"
                  value={selectedText.color}
                  onChange={(event) =>
                    dispatch({
                      type: "updateText",
                      id: selectedText.id,
                      patch: { color: event.target.value },
                    })
                  }
                />
              </label>
            </>
          ) : (
            <p className="note small" data-testid="tpl-no-selection">
              {t("template.noSelection")}
            </p>
          )}

          {selectedFrame !== null && (
            <label className="check" title={t("template.frameShadowHint")}>
              <input
                type="checkbox"
                data-testid="tpl-frame-shadow"
                checked={selectedFrame.hasShadow}
                onChange={(event) =>
                  dispatch({
                    type: "updateFrame",
                    id: selectedFrame.id,
                    patch: { hasShadow: event.target.checked },
                  })
                }
              />
              <span>{t("template.frameShadow")}</span>
            </label>
          )}

          <label className="check" title={t("template.vignetteHint")}>
            <input
              type="checkbox"
              data-testid="tpl-vignette"
              checked={template.background.hasVignette}
              onChange={(event) =>
                dispatch({
                  type: "setBackground",
                  background: { ...template.background, hasVignette: event.target.checked },
                })
              }
            />
            <span>{t("template.vignette")}</span>
          </label>

          <p className="note small" data-testid="tpl-render-path">
            {t("template.renderPath", { path: renderPath })}
          </p>
          <p className="note small" data-testid="tpl-print-plan">
            {sheetPlanText}
          </p>
          {printError !== null && (
            <p className="note small" data-testid="tpl-print-error">
              {t("template.printError", { message: printError })}
            </p>
          )}
          {lastSheet !== null && (
            <a
              className="link small"
              data-testid="tpl-last-sheet"
              href={lastSheet.url}
              download={lastSheet.filename}
            >
              {t("template.printLast", {
                filename: lastSheet.filename,
                width: lastSheet.width,
                height: lastSheet.height,
              })}
            </a>
          )}
          {fallbackReason !== null && (
            <p className="note small" data-testid="tpl-fallback">
              {fallbackReason}
            </p>
          )}
          {lastExport !== null && (
            <a
              className="link small"
              data-testid="tpl-last-export"
              href={lastExport.url}
              download={lastExport.filename}
            >
              {lastExport.filename} — {lastExport.width}×{lastExport.height} px
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

/** Preset id yang cocok dengan ukuran sekarang, atau "" kalau ukurannya custom. */
function presetIdOf(template: Template): string {
  const match = TEMPLATE_SIZE_PRESETS.find(
    (preset) => preset.width === template.size.width && preset.height === template.size.height,
  );
  return match?.id ?? "";
}
