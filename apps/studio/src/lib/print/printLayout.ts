/**
 * Render lembar cetak — inti Fase 3.
 *
 * Yang dihasilkan di sini **bukan** gambar template, tapi **lembar kertas**:
 * kertas (putih) → template ditempelkan di area trim → tanda potong di area
 * bleed. Pemisahan itu yang bikin satu template bisa dicetak ke 2×6, 4×6, 5×7,
 * atau A4 tanpa mengubah modelnya sama sekali.
 *
 * Dua keputusan yang sengaja diambil, dan alasannya:
 *
 *   · **Template dipasangkan ke area TRIM, bukan area aman.** Template sudah
 *     punya margin sendiri (36 px di dalam 600×1800). Kalau ditempelkan ke
 *     area aman, margin-nya dobel dan strip 2×6 di kertas 2×6 menyusut jadi
 *     ~88 % — kelihatan salah. Area aman tetap dipakai, tapi sebagai **panduan
 *     pratinjau** (`safeBox`), bukan sebagai pemaksa ukuran.
 *   · **Tidak pernah diperbesar melebihi trim.** Sisa kertas jadi margin
 *     (letterbox), bukan distorsi. Foto booth yang melebar itu bug, bukan fitur.
 *
 * Semua geometri murni dan bisa diuji tanpa canvas (`planPrintSheet`), lalu
 * penggambarannya cuma menerjemahkan rencana itu ke perintah canvas.
 */

import {
  printPixelSize,
  printSafeBox,
  printTrimBox,
  templatePixelSize,
  cutMarkLines,
  fitBox,
  type CutMarkLine,
  type PrintBox,
  type PrintPreset,
  type Template,
} from "@foto-booth/shared";

import type { DrawTarget, RenderOptions, RenderStats } from "../template/render.ts";
import { renderTemplate } from "../template/render.ts";

/**
 * Target gambar untuk lembar cetak.
 *
 * `DrawTarget` (dari `render.ts`) ditambah `scale` dan operasi path — canvas
 * asli memenuhi keduanya, jadi tidak ada perantara.
 */
export interface PrintTarget extends DrawTarget {
  scale(x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

export interface PrintSheetOptions extends RenderOptions {
  /** Ikutkan area bleed (kanvas jadi lebih besar dari trim). */
  includeBleed?: boolean;
  /** Warna kertas. Default putih — tinta tidak dicetak di area kosong. */
  paper?: string;
  /** Pasangkan template ke area aman, bukan trim. Default: trim. */
  fit?: "trim" | "safe";
}

/** Rencana gambar: semua angka yang dipakai, tanpa satu pun perintah canvas. */
export interface PrintSheetPlan {
  /** Ukuran kanvas lembar, piksel. */
  width: number;
  height: number;
  /** Area trim (hasil akhir setelah dipotong). */
  trimBox: PrintBox;
  /** Area aman di dalam trim — panduan, bukan pemaksa. */
  safeBox: PrintBox;
  /** Di mana template ditempelkan. */
  templateBox: PrintBox;
  /** Faktor skala dari piksel template ke piksel lembar. */
  scale: number;
  /** Garis tanda potong; kosong kalau preset tidak minta. */
  cutMarks: CutMarkLine[];
}

/**
 * Hitung semua geometri lembar cetak.
 *
 * Dipisah dari penggambaran supaya validasi bisa **mengukur angka** (600×1800,
 * templateBox 600×1800, dst.) tanpa perlu canvas sama sekali.
 */
export function planPrintSheet(
  template: Template,
  preset: PrintPreset,
  options: PrintSheetOptions = {},
): PrintSheetPlan {
  const includeBleed = options.includeBleed === true;
  const sheet = printPixelSize(preset, { includeBleed });
  const trimBox = printTrimBox(preset, { includeBleed });
  const safeBox = printSafeBox(preset, { includeBleed });

  const content = templatePixelSize(template.size);
  const area = options.fit === "safe" ? safeBox : trimBox;
  const templateBox = fitBox(content, area);

  // Skala dari template → lembar. `fitBox` menjaga rasio, jadi satu skalar
  // cukup; diambil dari lebar, dan 0 kalau template kosong.
  const scale = content.width > 0 ? templateBox.width / content.width : 0;

  return {
    width: sheet.width,
    height: sheet.height,
    trimBox,
    safeBox,
    templateBox,
    scale,
    cutMarks: cutMarkLines(preset, { includeBleed }),
  };
}

/**
 * Gambar lembar cetak ke target.
 *
 * Urutan: kertas → template (diskalakan) → tanda potong. Tanda potong digambar
 * paling akhir supaya tidak pernah tertutup template.
 */
export function renderPrintSheet(
  ctx: PrintTarget,
  template: Template,
  preset: PrintPreset,
  options: PrintSheetOptions = {},
): PrintSheetPlan & { stats: RenderStats } {
  const plan = planPrintSheet(template, preset, options);

  // 1. Kertas. `fillRect` penuh — termasuk area bleed, karena bleed memang
  //    harus berisi tinta/gambar, bukan putih.
  ctx.save();
  ctx.fillStyle = options.paper ?? "#ffffff";
  ctx.fillRect(0, 0, plan.width, plan.height);
  ctx.restore();

  // 2. Template, ditempelkan di `templateBox` dengan skala yang sama untuk
  //    sumbu x dan y (tidak pernah distorsi).
  let stats: RenderStats = {
    width: plan.width,
    height: plan.height,
    framesDrawn: 0,
    textsDrawn: 0,
    stickersDrawn: 0,
    shadowsDrawn: 0,
    vignetteDrawn: false,
    renderedTexts: [],
  };

  if (plan.scale > 0) {
    ctx.save();
    ctx.translate(plan.templateBox.x, plan.templateBox.y);
    ctx.scale(plan.scale, plan.scale);
    const inner = renderTemplate(ctx, template, {
      frames: options.frames,
      backgroundImage: options.backgroundImage,
      stickers: options.stickers,
      tokens: options.tokens,
    });
    ctx.restore();

    // Lembar lebih besar dari template; ukuran yang dilaporkan adalah lembar,
    // tapi hitungan elemen tetap dari render template (itu yang informatif).
    stats = { ...inner, width: plan.width, height: plan.height };
  }

  // 3. Tanda potong — tipis, di area bleed.
  if (plan.cutMarks.length > 0) {
    ctx.save();
    ctx.strokeStyle = options.paper === undefined || options.paper === "#ffffff" ? "#0a0a0a" : "#ffffff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const line of plan.cutMarks) {
      ctx.moveTo(line.x1, line.y1);
      ctx.lineTo(line.x2, line.y2);
    }
    ctx.stroke();
    ctx.restore();
  }

  return { ...plan, stats };
}

/**
 * Lembar kosong yang aman untuk diukur: dipakai validator Playwright supaya
 * bisa membandingkan "yang direncanakan" dengan "yang benar-benar digambar".
 */
export function printSheetPlanSummary(plan: PrintSheetPlan): string {
  const { width, height, templateBox, scale } = plan;
  return [
    `sheet=${width}x${height}`,
    `template=${Math.round(templateBox.width)}x${Math.round(templateBox.height)}`,
    `at=${Math.round(templateBox.x)},${Math.round(templateBox.y)}`,
    `scale=${scale.toFixed(4)}`,
  ].join(" ");
}
