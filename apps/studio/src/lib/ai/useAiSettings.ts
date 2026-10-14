/**
 * Jembatan React ↔ efek AI (Fase 8).
 *
 * Perannya sama dengan `useFilterSettings` untuk filter Fase 6: menyatukan
 * **pengaturan** (kunci, tugas, gaya), **klien**, dan **fungsi `process`** yang
 * dipakai jalur simpan (`Blob → ProcessedFrame | null`). Semua keputusan soal
 * tugas & gaya tetap di `packages/shared/src/ai.ts`; hook ini tidak menambah
 * aturan.
 *
 * Yang dijaga di sini:
 *
 *   · **Token & kunci diperiksa sebelum panggilan.** Tanpa keduanya, `process`
 *     langsung `null` — tidak ada permintaan yang pasti 401.
 *   · **Kegagalan AI tidak pernah menggagalkan foto.** Semua hasil gagal
 *     dikembalikan sebagai `null` (pakai foto asli) sambil menyimpan alasan
 *     terakhir untuk ditampilkan ke operator.
 *   · **Kunci tidak pernah masuk ringkasan/log.** Yang ditampilkan hanya hasil
 *     `maskAiKey`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AiStyleId, AiTaskId } from "@foto-booth/shared";

import { createAiClient, type AiClient, type AiFailureReason } from "./aiClient.ts";
import { applyAiEffect, browserAiImageDeps, previewAiPrompt, type AiEffectRequest } from "./aiEnhance.ts";
import { deviceStorage } from "../capture/rememberedDevice.ts";
import { maskAiKey, readAiSettings, writeAiSettings, type AiSettings } from "./aiSettingsStore.ts";
import type { ProcessedFrame } from "../upload/composedToIntake.ts";

/** Ringkasan hasil terakhir — cukup untuk panel debug, tanpa kunci. */
export interface AiLastRun {
  ok: boolean;
  reason: AiFailureReason | "encode" | "decode" | null;
  /** Prompt yang benar-benar dipakai (sukses) — atau yang akan dipakai (gagal). */
  prompt: string;
  message: string | null;
}

export interface AiSettingsHandle {
  settings: AiSettings;
  /** Ubah sebagian pengaturan; sisanya tetap. */
  update(patch: Partial<AiSettings>): void;
  /** Kembalikan ke default (kunci dibuang, AI dimatikan). */
  reset(): void;
  /**
   * Jalankan efek AI pada satu blob. `null` = pakai blob asli (AI mati, gagal,
   * atau tidak dikonfigurasi). **Tidak pernah melempar.**
   */
  process(blob: Blob): Promise<ProcessedFrame | null>;
  /** Hasil terakhir — untuk panel debug. */
  lastRun: AiLastRun | null;
  /** Ringkasan satu baris untuk operator; aman ditampilkan (tanpa kunci). */
  lastSummary: string | null;
  /** Kunci yang sudah disamarkan — untuk ditampilkan di UI. */
  maskedKey: string;
  /** Ada token operator & kunci yang masuk akal. */
  ready: boolean;
}

export interface UseAiSettingsOptions {
  /** Token sesi operator. `null` = belum login → AI tidak pernah dipanggil. */
  token?: string | null;
  /** Klien yang disuntik (tes); kalau tidak ada, dibuat dari token + kunci. */
  client?: AiClient;
  baseUrl?: string;
}

export function useAiSettings(options: UseAiSettingsOptions = {}): AiSettingsHandle {
  const [settings, setSettings] = useState<AiSettings>(() =>
    readAiSettings(typeof localStorage === "undefined" ? null : deviceStorage()),
  );
  const [lastRun, setLastRun] = useState<AiLastRun | null>(null);

  const token = options.token ?? null;

  // Simpan tiap berubah; gagal simpan bukan alasan menghentikan alur.
  useEffect(() => {
    writeAiSettings(typeof localStorage === "undefined" ? null : deviceStorage(), settings);
  }, [settings]);

  // Pengaturan terbaru untuk `process`: callback-nya stabil (`useCallback`),
  // tapi `framesToIntake` memanggilnya berulang kali dalam satu sesi — kalau ia
  // menutup `settings` dari render lama, operator yang baru mengubah gaya masih
  // mendapat gaya lama untuk sisa sesi itu.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const client = useMemo<AiClient | null>(() => {
    if (options.client !== undefined) return options.client;
    if (token === null || token === "") return null;
    if (settings.key === "") return null;
    return createAiClient({
      token,
      key: settings.key,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    });
    // Klien dibangun ulang hanya saat token/kunci berubah — bukan tiap render,
    // dan bukan saat operator mengubah gaya.
  }, [options.client, options.baseUrl, token, settings.key]);

  const update = useCallback((patch: Partial<AiSettings>): void => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const reset = useCallback((): void => {
    setSettings(readAiSettings(null));
    setLastRun(null);
  }, []);

  const process = useCallback(
    async (blob: Blob): Promise<ProcessedFrame | null> => {
      const current = settingsRef.current;
      if (!current.enabled) return null;
      if (client === null) {
        setLastRun({
          ok: false,
          reason: current.key === "" ? "no_key" : "unauthorized",
          prompt: "",
          message: current.key === "" ? "kunci Gemini belum diisi" : "belum masuk sebagai operator",
        });
        return null;
      }

      const request: AiEffectRequest = {
        task: current.task,
        style: current.style,
        ...(current.custom === "" ? {} : { custom: current.custom }),
      };
      const prompt = previewAiPrompt(request);

      try {
        const result = await applyAiEffect(blob, request, browserAiImageDeps(), client);
        if (!result.ok) {
          setLastRun({ ok: false, reason: result.reason, prompt, message: result.message });
          return null;
        }
        setLastRun({ ok: true, reason: null, prompt: result.prompt, message: null });
        return { blob: result.blob, width: result.width, height: result.height };
      } catch {
        // `applyAiEffect` sudah menelan kegagalan internalnya; ini jaring
        // terakhir supaya satu bug tidak menghilangkan foto dari antrian.
        setLastRun({ ok: false, reason: "unknown" as AiFailureReason, prompt, message: "efek AI gagal" });
        return null;
      }
    },
    [client],
  );

  const ready = token !== null && token !== "" && settings.key !== "";

  const lastSummary = useMemo(() => {
    if (lastRun === null) return null;
    if (lastRun.ok) return `AI: ${lastRun.prompt.slice(0, 60)}`;
    const why = lastRun.message ?? lastRun.reason ?? "gagal";
    return `AI dilewati: ${why}`;
  }, [lastRun]);

  return {
    settings,
    update,
    reset,
    process,
    lastRun,
    lastSummary,
    maskedKey: maskAiKey(settings.key),
    ready,
  };
}

/** Nilai untuk `<select>` gaya: id + kunci label locale. */
export const AI_STYLE_OPTIONS: readonly { id: AiStyleId; label: string }[] = [
  { id: "anime", label: "capture.aiStyleAnime" },
  { id: "3d", label: "capture.aiStyle3d" },
  { id: "comic", label: "capture.aiStyleComic" },
  { id: "watercolor", label: "capture.aiStyleWatercolor" },
  { id: "oil", label: "capture.aiStyleOil" },
  { id: "custom", label: "capture.aiStyleCustom" },
];

/** Nilai untuk `<select>` tugas: id + kunci label locale. */
export const AI_TASK_OPTIONS: readonly { id: AiTaskId; label: string }[] = [
  { id: "style", label: "capture.aiTaskStyle" },
  { id: "enhance", label: "capture.aiTaskEnhance" },
  { id: "backdrop", label: "capture.aiTaskBackdrop" },
  { id: "remix", label: "capture.aiTaskRemix" },
];
