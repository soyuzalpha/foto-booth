/**
 * Renderer template — fungsi murni ke "context gambar" apa pun.
 *
 * Sengaja **tidak** menyentuh DOM: yang dibutuhkan cuma subset API canvas.
 * Akibatnya file ini bisa:
 *   · diuji di Node dengan context palsu (assert ukuran & posisi, bukan "kelihatan benar"),
 *   · jalan di Worker lewat `OffscreenCanvasRenderingContext2D`,
 *   · dipakai editor maupun export — satu jalur gambar, jadi hasil export
 *     tidak bisa "beda" dari yang dilihat di editor.
 *
 * Editor (Konva) memakai model yang sama; file ini yang jadi acuan hasil akhir.
 */

import {
  substituteTokens,
  templatePixelSize,
  type Template,
  type TemplateFrame,
  type TemplateSticker,
  type TemplateText,
  type TokenValues,
} from "@foto-booth/shared";

import { coverCrop } from "./layout.ts";

/** Subset `CanvasRenderingContext2D` yang benar-benar dipakai. */
export interface DrawTarget {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): CanvasGradient;
}

/** Gambar siap-gambar + ukuran aslinya (biar crop tidak butuh DOM). */
export interface FrameImage {
  image: CanvasImageSource;
  width: number;
  height: number;
}

export interface RenderOptions {
  /** Gambar per slot frame; `null` = slot masih kosong. */
  frames?: readonly (FrameImage | null | undefined)[];
  backgroundImage?: FrameImage | null;
  /** Gambar sticker per id. */
  stickers?: Readonly<Record<string, FrameImage>>;
  /** Nilai token; kalau tidak diberi, token dibiarkan apa adanya. */
  tokens?: TokenValues;
}

export interface RenderStats {
  width: number;
  height: number;
  framesDrawn: number;
  textsDrawn: number;
  stickersDrawn: number;
  /** Berapa elemen yang benar-benar digambar dengan bayangan. */
  shadowsDrawn: number;
  /** `true` kalau vignette latar benar-benar digambar. */
  vignetteDrawn: boolean;
  /** Teks setelah token disubstitusi — bukti bahwa token benar-benar jalan. */
  renderedTexts: string[];
}

const LINE_HEIGHT_RATIO = 1.2;

/**
 * Vignette latar: transparan di tengah, makin gelap ke tepi.
 * Radius dalam 55% dari jari-jari sudut supaya bagian tengah tetap bersih,
 * dan gradient ditutup di `hypot(cx, cy)` supaya keempat sudut ikut tergelapkan.
 */
const VIGNETTE_INNER_RATIO = 0.55;
const VIGNETTE_EDGE_ALPHA = 0.55;

/** Bayangan elemen (Fase 3). Offset tegak saja supaya terlihat seperti benda di atas kertas. */
const SHADOW_COLOR = "rgba(0, 0, 0, 0.45)";
const SHADOW_BLUR = 24;
const SHADOW_OFFSET_X = 0;
const SHADOW_OFFSET_Y = 8;

function drawVignette(ctx: DrawTarget, width: number, height: number): void {
  const centerX = width / 2;
  const centerY = height / 2;
  const outerRadius = Math.hypot(centerX, centerY);
  if (outerRadius <= 0) return;

  const gradient = ctx.createRadialGradient(
    centerX,
    centerY,
    outerRadius * VIGNETTE_INNER_RATIO,
    centerX,
    centerY,
    outerRadius,
  );
  gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
  gradient.addColorStop(1, `rgba(0, 0, 0, ${VIGNETTE_EDGE_ALPHA})`);

  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

function applyShadow(ctx: DrawTarget, hasShadow: boolean): void {
  ctx.shadowColor = hasShadow ? SHADOW_COLOR : "rgba(0, 0, 0, 0)";
  ctx.shadowBlur = hasShadow ? SHADOW_BLUR : 0;
  ctx.shadowOffsetX = hasShadow ? SHADOW_OFFSET_X : 0;
  ctx.shadowOffsetY = hasShadow ? SHADOW_OFFSET_Y : 0;
}

/** Font CSS dari elemen teks. Dipakai juga oleh editor supaya tidak beda. */
export function cssFont(text: Pick<TemplateText, "fontSize" | "fontFamily">): string {
  return `${text.fontSize}px ${text.fontFamily}`;
}

/** Bungkus teks supaya muat di lebar kotak. Satu kata panjang dibiarkan utuh. */
export function wrapText(ctx: Pick<DrawTarget, "measureText">, text: string, maxWidth: number): string[] {
  if (text === "") return [""];
  if (maxWidth <= 0) return [text];

  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/)) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (ctx.measureText(candidate).width <= maxWidth || current === "") {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current !== "") lines.push(current);
  return lines;
}

function drawRotated(
  ctx: DrawTarget,
  centerX: number,
  centerY: number,
  rotationDegrees: number,
  draw: () => void,
): void {
  ctx.save();
  ctx.translate(centerX, centerY);
  if (rotationDegrees !== 0) ctx.rotate((rotationDegrees * Math.PI) / 180);
  draw();
  ctx.restore();
}

function drawFrame(
  ctx: DrawTarget,
  frame: TemplateFrame,
  image: FrameImage | null | undefined,
): boolean {
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;

  drawRotated(ctx, centerX, centerY, frame.rotation, () => {
    applyShadow(ctx, frame.hasShadow);

    // Latar slot kosong supaya tata letak tetap terbaca sebelum ada foto.
    if (image === null || image === undefined) {
      ctx.fillStyle = "#e8e5da";
      ctx.fillRect(-frame.width / 2, -frame.height / 2, frame.width, frame.height);
    } else {
      const crop = coverCrop(image.width, image.height, frame, frame.aspectRatio);
      ctx.drawImage(
        image.image,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        -frame.width / 2,
        -frame.height / 2,
        frame.width,
        frame.height,
      );
    }

    // Garis tepi digambar tanpa bayangan: kalau tidak, garis tipis jadi dobel kabur.
    applyShadow(ctx, false);

    if (frame.borderThickness > 0) {
      ctx.strokeStyle = frame.borderColor;
      ctx.lineWidth = frame.borderThickness;
      const inset = frame.borderThickness / 2;
      ctx.strokeRect(
        -frame.width / 2 + inset,
        -frame.height / 2 + inset,
        frame.width - frame.borderThickness,
        frame.height - frame.borderThickness,
      );
    }
  });

  return image !== null && image !== undefined;
}

function drawText(ctx: DrawTarget, element: TemplateText, resolved: string): void {
  const centerX = element.x + element.width / 2;
  const centerY = element.y + element.height / 2;

  drawRotated(ctx, centerX, centerY, element.rotation, () => {
    ctx.font = cssFont(element);
    ctx.fillStyle = element.color;
    ctx.textBaseline = "middle";
    ctx.textAlign = element.align;

    const anchorX =
      element.align === "left"
        ? -element.width / 2
        : element.align === "right"
          ? element.width / 2
          : 0;

    const lines = wrapText(ctx, resolved, element.width);
    const lineHeight = element.fontSize * LINE_HEIGHT_RATIO;
    const firstY = -((lines.length - 1) * lineHeight) / 2;

    if (element.stroke !== undefined && element.strokeWidth > 0) {
      ctx.strokeStyle = element.stroke;
      ctx.lineWidth = element.strokeWidth;
    }

    lines.forEach((line, index) => {
      const y = firstY + index * lineHeight;
      if (element.stroke !== undefined && element.strokeWidth > 0) {
        ctx.strokeText(line, anchorX, y);
      }
      ctx.fillText(line, anchorX, y);
    });
  });
}

function drawSticker(ctx: DrawTarget, sticker: TemplateSticker, image: FrameImage | undefined): boolean {
  if (image === undefined) return false;

  const centerX = sticker.x + sticker.width / 2;
  const centerY = sticker.y + sticker.height / 2;

  drawRotated(ctx, centerX, centerY, sticker.rotation, () => {
    ctx.drawImage(
      image.image,
      0,
      0,
      image.width,
      image.height,
      -sticker.width / 2,
      -sticker.height / 2,
      sticker.width,
      sticker.height,
    );
  });

  return true;
}

/**
 * Gambar seluruh template. Urutan: background → frame → sticker → teks.
 * Teks paling atas supaya tidak pernah tertutup foto.
 */
export function renderTemplate(
  ctx: DrawTarget,
  template: Template,
  options: RenderOptions = {},
): RenderStats {
  const pixels = templatePixelSize(template.size);
  const tokens = options.tokens ?? {};

  // Background.
  if (template.background.type === "image" && options.backgroundImage != null) {
    const background = options.backgroundImage;
    const crop = coverCrop(background.width, background.height, { x: 0, y: 0, ...pixels }, undefined);
    ctx.drawImage(
      background.image,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      0,
      0,
      pixels.width,
      pixels.height,
    );
  } else {
    ctx.fillStyle = template.background.type === "image" ? "#ffffff" : template.background.value;
    ctx.fillRect(0, 0, pixels.width, pixels.height);
  }

  let framesDrawn = 0;
  let shadowsDrawn = 0;
  for (const frame of template.frames) {
    const image = options.frames?.[frame.slot] ?? null;
    if (drawFrame(ctx, frame, image)) framesDrawn += 1;
    if (frame.hasShadow) shadowsDrawn += 1;
  }

  // Vignette digambar SETELAH latar tapi SEBELUM elemen, supaya foto tetap tajam
  // dan hanya latar yang tergelapkan.
  const vignetteDrawn = template.background.hasVignette;
  if (vignetteDrawn) drawVignette(ctx, pixels.width, pixels.height);

  let stickersDrawn = 0;
  for (const sticker of template.stickers) {
    if (drawSticker(ctx, sticker, options.stickers?.[sticker.id])) stickersDrawn += 1;
  }

  const renderedTexts: string[] = [];
  for (const element of template.textElements) {
    const resolved = substituteTokens(element.text, tokens);
    drawText(ctx, element, resolved);
    renderedTexts.push(resolved);
  }

  return {
    width: pixels.width,
    height: pixels.height,
    framesDrawn,
    textsDrawn: renderedTexts.length,
    stickersDrawn,
    shadowsDrawn,
    vignetteDrawn,
    renderedTexts,
  };
}
