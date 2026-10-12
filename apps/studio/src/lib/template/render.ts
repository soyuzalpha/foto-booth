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
  /** Teks setelah token disubstitusi — bukti bahwa token benar-benar jalan. */
  renderedTexts: string[];
}

const LINE_HEIGHT_RATIO = 1.2;

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
  for (const frame of template.frames) {
    const image = options.frames?.[frame.slot] ?? null;
    if (drawFrame(ctx, frame, image)) framesDrawn += 1;
  }

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
    renderedTexts,
  };
}
