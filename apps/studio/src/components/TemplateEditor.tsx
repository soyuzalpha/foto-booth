/**
 * Kanvas editor template (Konva).
 *
 * Komponen ini **tipis**: semua perubahan geometri dikirim sebagai aksi ke
 * `editorState.ts` (reducer murni yang sudah diuji di Node). Di sini cuma ada
 * terjemahan pointer → aksi, dan gambar.
 *
 * Dua hal yang gampang salah dan sengaja dijaga:
 *   · **Rotasi berpusat di tengah elemen.** Model menyimpan `x`/`y` sebagai
 *     sudut kiri-atas, sementara Konva memutar terhadap titik origin node. Jadi
 *     node dipasang dengan `offset` setengah ukuran — tanpa itu elemen akan
 *     "mengorbit" saat diputar, dan posisinya tidak lagi cocok dengan hasil
 *     export (`render.ts` memutar terhadap pusat).
 *   · **Skala layar dipisah dari skala model.** Yang disimpan selalu piksel
 *     canvas hasil (600×1800 untuk 2×6 in @300 dpi), bukan piksel layar. Semua
 *     angka dari Konva dibagi `scale` dulu sebelum dikirim ke reducer.
 */

import type Konva from "konva";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image as KonvaImage, Layer, Rect, Stage, Text as KonvaText, Transformer } from "react-konva";

import {
  templatePixelSize,
  type Template,
  type TemplateFrame,
  type TemplateSticker,
  type TemplateText,
} from "@foto-booth/shared";

import type { EditorAction, EditorState, Selection } from "../lib/template/editorState.ts";
import { coverCrop } from "../lib/template/layout.ts";
import type { FrameImage } from "../lib/template/render.ts";
import { useImageSrc } from "../lib/useImageSrc.ts";

/** Kotak tampil maksimum; kanvas diskalakan supaya muat tanpa mengubah model. */
const MAX_DISPLAY_WIDTH = 420;
const MAX_DISPLAY_HEIGHT = 620;

/** Ukuran minimum elemen, dalam piksel canvas (sama dengan `editorState.ts`). */
const MIN_SIZE = 24;

export interface TemplateEditorProps {
  state: EditorState;
  dispatch: (action: EditorAction) => void;
  /** Foto dari sesi terakhir; `null` = slot kosong. */
  frames: readonly (FrameImage | null)[];
  /** Nilai token buat pratinjau teks. */
  tokens?: Record<string, string>;
}

type Element = TemplateFrame | TemplateText | TemplateSticker;

interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

function nodeId(kind: Selection["kind"], id: string): string {
  return `${kind}:${id}`;
}

function boxOf(element: Element): NodeBox {
  return {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    rotation: element.rotation,
  };
}

function StickerNode({
  sticker,
  selected,
  scale,
  onSelect,
  onTransformEnd,
  onDragEnd,
}: {
  sticker: TemplateSticker;
  selected: boolean;
  scale: number;
  onSelect: () => void;
  onTransformEnd: (node: Konva.Node) => void;
  onDragEnd: (node: Konva.Node) => void;
}): React.JSX.Element | null {
  const image = useImageSrc(sticker.src);
  if (image === null) return null;

  return (
    <KonvaImage
      id={nodeId("sticker", sticker.id)}
      image={image}
      x={(sticker.x + sticker.width / 2) * scale}
      y={(sticker.y + sticker.height / 2) * scale}
      width={sticker.width * scale}
      height={sticker.height * scale}
      offsetX={(sticker.width * scale) / 2}
      offsetY={(sticker.height * scale) / 2}
      rotation={sticker.rotation}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(event) => onDragEnd(event.target)}
      onTransformEnd={(event) => onTransformEnd(event.target)}
      stroke={selected ? "#4ecdc4" : undefined}
      strokeWidth={selected ? 2 / scale : 0}
    />
  );
}

export default function TemplateEditor({
  state,
  dispatch,
  frames,
  tokens,
}: TemplateEditorProps): React.JSX.Element {
  const { t } = useTranslation();
  const template: Template = state.template;
  const pixels = templatePixelSize(template.size);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const layerRef = useRef<Konva.Layer | null>(null);
  const [wrapWidth, setWrapWidth] = useState(360);

  // Ukuran tampil diukur dari kontainer, bukan dari jendela — biar kanvas tetap
  // benar di dalam kolom yang sempit tanpa mengubah model.
  useEffect(() => {
    const element = wrapRef.current;
    if (element === null) return;

    const update = (): void => setWrapWidth(element.clientWidth);
    update();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { stageWidth, stageHeight, scale } = useMemo(() => {
    let width = Math.max(120, Math.min(wrapWidth, MAX_DISPLAY_WIDTH));
    let height = (width * pixels.height) / pixels.width;

    if (height > MAX_DISPLAY_HEIGHT) {
      height = MAX_DISPLAY_HEIGHT;
      width = (height * pixels.width) / pixels.height;
    }

    return { stageWidth: Math.round(width), stageHeight: Math.round(height), scale: width / pixels.width };
  }, [wrapWidth, pixels.width, pixels.height]);

  const findElement = (id: string): Element | null => {
    const separator = id.indexOf(":");
    const kind = id.slice(0, separator);
    const elementId = id.slice(separator + 1);

    if (kind === "frame") return template.frames.find((item) => item.id === elementId) ?? null;
    if (kind === "text") return template.textElements.find((item) => item.id === elementId) ?? null;
    return template.stickers.find((item) => item.id === elementId) ?? null;
  };

  // Pasang Transformer ke node yang sedang dipilih.
  useEffect(() => {
    const transformer = transformerRef.current;
    const layer = layerRef.current;
    if (transformer === null || layer === null) return;

    if (state.selected === null) {
      transformer.nodes([]);
      transformer.getLayer()?.batchDraw();
      return;
    }

    const node = layer.findOne(`#${nodeId(state.selected.kind, state.selected.id)}`);
    transformer.nodes(node === undefined ? [] : [node]);
    transformer.getLayer()?.batchDraw();
  }, [state.selected, state.template, stageWidth, stageHeight, scale]);

  const handleTransformEnd = (node: Konva.Node): void => {
    const element = findElement(node.id());
    if (element === null) return;

    const width = Math.max(MIN_SIZE, element.width * node.scaleX());
    const height = Math.max(MIN_SIZE, element.height * node.scaleY());
    // Skala Konva dibakar ke `width`/`height` model, jadi node harus balik ke 1
    // — kalau tidak, render berikutnya menggandakan penskalaan.
    node.scaleX(1);
    node.scaleY(1);

    // Konva memberi koordinat pusat (karena `offset`); model mau sudut kiri-atas.
    dispatch({
      type: "transform",
      box: {
        x: node.x() / scale - width / 2,
        y: node.y() / scale - height / 2,
        width,
        height,
      },
      rotation: node.rotation(),
    });
  };

  const handleDragEnd = (node: Konva.Node): void => {
    const element = findElement(node.id());
    if (element === null) return;
    dispatch({
      type: "moveTo",
      x: node.x() / scale - element.width / 2,
      y: node.y() / scale - element.height / 2,
    });
  };

  const select = (kind: Selection["kind"], id: string) => (): void => {
    dispatch({ type: "select", selection: { kind, id } });
  };

  const isSelected = (kind: Selection["kind"], id: string): boolean =>
    state.selected?.kind === kind && state.selected.id === id;

  const selectedBox = (() => {
    if (state.selected === null) return "";
    const element = findElement(nodeId(state.selected.kind, state.selected.id));
    if (element === null) return "";
    const box = boxOf(element);
    return `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)},${Math.round(box.rotation)}`;
  })();

  /** Substitusi token untuk pratinjau; token tanpa nilai dibiarkan apa adanya. */
  const previewText = (text: string): string =>
    text.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = tokens?.[name];
      return value === undefined || value === "" ? match : value;
    });

  return (
    <div
      className="tpl-canvas"
      ref={wrapRef}
      data-testid="tpl-canvas"
      data-template-size={`${pixels.width}x${pixels.height}`}
      data-stage-scale={scale.toFixed(6)}
      data-selected-id={state.selected === null ? "" : nodeId(state.selected.kind, state.selected.id)}
      data-selected-box={selectedBox}
    >
      <Stage
        width={stageWidth}
        height={stageHeight}
        onMouseDown={(event) => {
          if (event.target === event.target.getStage()) dispatch({ type: "select", selection: null });
        }}
        onTouchStart={(event) => {
          if (event.target === event.target.getStage()) dispatch({ type: "select", selection: null });
        }}
      >
        <Layer ref={layerRef}>
          <Rect
            x={0}
            y={0}
            width={stageWidth}
            height={stageHeight}
            fill={template.background.type === "image" ? "#ffffff" : template.background.value}
          />

          {template.frames.map((frame) => {
            const image = frames[frame.slot] ?? null;
            const selectedFrame = isSelected("frame", frame.id);
            const common = {
              id: nodeId("frame", frame.id),
              x: (frame.x + frame.width / 2) * scale,
              y: (frame.y + frame.height / 2) * scale,
              width: frame.width * scale,
              height: frame.height * scale,
              offsetX: (frame.width * scale) / 2,
              offsetY: (frame.height * scale) / 2,
              rotation: frame.rotation,
              stroke: selectedFrame ? "#4ecdc4" : frame.borderColor,
              strokeWidth: selectedFrame ? 2 / scale : Math.max(1 / scale, frame.borderThickness * scale),
              draggable: true,
              onClick: select("frame", frame.id),
              onTap: select("frame", frame.id),
              onDragEnd: (event: Konva.KonvaEventObject<Event>) => handleDragEnd(event.target),
              onTransformEnd: (event: Konva.KonvaEventObject<Event>) => handleTransformEnd(event.target),
            };

            if (image === null) {
              // Slot kosong tetap terlihat sebagai kotak — kalau tidak, operator
              // tidak bisa menilai tata letak sebelum ada foto.
              return <Rect key={frame.id} {...common} fill="#e8e5da" />;
            }

            const crop = coverCrop(
              image.width,
              image.height,
              { x: 0, y: 0, width: frame.width, height: frame.height },
              frame.aspectRatio,
            );

            return (
              <KonvaImage
                key={frame.id}
                {...common}
                image={image.image as HTMLImageElement}
                crop={{ x: crop.sx, y: crop.sy, width: crop.sw, height: crop.sh }}
              />
            );
          })}

          {template.stickers.map((sticker) => (
            <StickerNode
              key={sticker.id}
              sticker={sticker}
              selected={isSelected("sticker", sticker.id)}
              scale={scale}
              onSelect={select("sticker", sticker.id)}
              onTransformEnd={handleTransformEnd}
              onDragEnd={handleDragEnd}
            />
          ))}

          {template.textElements.map((element) => (
            <KonvaText
              key={element.id}
              id={nodeId("text", element.id)}
              text={previewText(element.text)}
              x={(element.x + element.width / 2) * scale}
              y={(element.y + element.height / 2) * scale}
              width={element.width * scale}
              height={element.height * scale}
              offsetX={(element.width * scale) / 2}
              offsetY={(element.height * scale) / 2}
              rotation={element.rotation}
              fontSize={element.fontSize * scale}
              fontFamily={element.fontFamily}
              fill={element.color}
              align={element.align}
              verticalAlign="middle"
              wrap="word"
              draggable
              onClick={select("text", element.id)}
              onTap={select("text", element.id)}
              onDragEnd={(event) => handleDragEnd(event.target)}
              onTransformEnd={(event) => handleTransformEnd(event.target)}
              stroke={isSelected("text", element.id) ? "#4ecdc4" : undefined}
              strokeWidth={isSelected("text", element.id) ? 1 / scale : 0}
            />
          ))}

          <Transformer
            ref={transformerRef}
            rotateEnabled
            flipEnabled={false}
            keepRatio={false}
            ignoreStroke
            anchorSize={9}
            borderStroke="#4ecdc4"
            anchorStroke="#0a0a0a"
            anchorFill="#ffd93d"
            boundBoxFunc={(oldBox, newBox) =>
              newBox.width < MIN_SIZE * scale || newBox.height < MIN_SIZE * scale ? oldBox : newBox
            }
          />
        </Layer>
      </Stage>

      <p className="tpl-hint small">
        {t("template.canvasHint", { width: pixels.width, height: pixels.height })}
      </p>
    </div>
  );
}
