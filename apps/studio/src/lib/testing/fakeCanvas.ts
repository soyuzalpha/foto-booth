/**
 * Kanvas 2D palsu untuk tes — perangkat lunak, bukan DOM.
 *
 * Tes filter tidak boleh butuh browser, tapi juga tidak boleh "percaya" pada
 * nilai yang ditulis kode: kalau `drawImage`/`getImageData` cuma dicatat, tes
 * chroma key akan hijau walau pikselnya tidak pernah benar-benar berubah.
 * Karena itu kanvas ini **benar-benar memindahkan piksel**: `drawImage`
 * memetakan balik tiap piksel tujuan lewat matriks transform (jadi rotasi &
 * skala ikut jalan) dan mengomposit alpha seperti canvas asli.
 *
 * Yang **tidak** ditiru: blur (`ctx.filter`) — itu urusan GPU dan memang tidak
 * bisa diuji di Node. `filter` hanya dicatat supaya tes bisa memastikan nilainya
 * pernah di-set.
 */

import type { Filter2DContext, FilterCanvas, FilterImageData, FilterSource } from "../filters/applyFilters.ts";

export interface FakePixels {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export interface FakeSource extends FilterSource, FakePixels {}

export interface FakeCanvas extends FilterCanvas, FakePixels {
  /** Nilai `ctx.filter` yang pernah di-set (bukti jalur blur/penyesuaian). */
  filtersUsed: string[];
  /** Berapa kali `drawImage` dipanggil. */
  draws: number;
  /**
   * Konteks asli + `globalAlpha`: fake ini benar-benar menerapkan alpha saat
   * mengomposit, jadi kode yang menumpuk gambar berbobot bisa diuji.
   */
  context: Filter2DContext & { globalAlpha: number };
}

export interface FakeCanvasOptions {
  /**
   * `false` (default) = `ctx.filter` **tidak** diterapkan, seperti Safari lama.
   * Ini penting: adapter harus jatuh ke jalur piksel, dan jalur itulah yang
   * benar-benar diuji. `true` meniru Chromium, tempat filter dikerjakan GPU.
   */
  supportsFilter?: boolean;
}

function parseColor(css: string): { r: number; g: number; b: number } {
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(css);
  if (rgb !== null) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(css);
  if (hex !== null) {
    const value = Number.parseInt(hex[1] as string, 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
  }
  return { r: 0, g: 0, b: 0 };
}

function pixelsOf(image: unknown): FakePixels | null {
  const candidate = image as Partial<FakePixels> | null;
  if (candidate !== null && candidate.pixels instanceof Uint8ClampedArray) {
    return {
      width: candidate.width ?? 0,
      height: candidate.height ?? 0,
      pixels: candidate.pixels,
    };
  }
  return null;
}

export function createFakeCanvas(
  width: number,
  height: number,
  options: FakeCanvasOptions = {},
): FakeCanvas {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const filtersUsed: string[] = [];
  const supportsFilter = options.supportsFilter ?? false;

  let transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  let filterValue = "none";

  const canvas: FakeCanvas = {
    width,
    height,
    pixels,
    filtersUsed,
    draws: 0,
    context: undefined as unknown as Filter2DContext & { globalAlpha: number },
    getContext: () => context as unknown as Filter2DContext & { globalAlpha: number },
  };

  const context = {
    fillStyle: "#000000",
    /**
     * `globalAlpha` ikut diterapkan di `drawImage` supaya kode yang menumpuk
     * gambar dengan bobot (mis. interpolasi pencampuran slow-mo) benar-benar
     * bisa diuji — bukan sekadar dicatat. Default 1 = tidak mengubah apa pun.
     */
    globalAlpha: 1,
    save() {},
    restore() {},
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
      transform = { a, b, c, d, e, f };
    },
    clearRect(x: number, y: number, w: number, h: number) {
      for (let py = Math.max(0, y); py < Math.min(canvas.height, y + h); py += 1) {
        for (let px = Math.max(0, x); px < Math.min(canvas.width, x + w); px += 1) {
          pixels.fill(0, (py * canvas.width + px) * 4, (py * canvas.width + px) * 4 + 4);
        }
      }
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const color = parseColor(context.fillStyle);
      for (let py = Math.max(0, y); py < Math.min(canvas.height, y + h); py += 1) {
        for (let px = Math.max(0, x); px < Math.min(canvas.width, x + w); px += 1) {
          const i = (py * canvas.width + px) * 4;
          pixels[i] = color.r;
          pixels[i + 1] = color.g;
          pixels[i + 2] = color.b;
          pixels[i + 3] = 255;
        }
      }
    },
    getImageData(_x: number, _y: number, w: number, h: number): FilterImageData {
      return { data: new Uint8ClampedArray(pixels), width: w, height: h };
    },
    putImageData(image: FilterImageData) {
      pixels.set(image.data.subarray(0, pixels.length));
    },
    drawImage(image: unknown, dx: number, dy: number, dw?: number, dh?: number) {
      canvas.draws += 1;
      filtersUsed.push(filterValue);

      const src = pixelsOf(image);
      if (src === null || src.width <= 0 || src.height <= 0) return;

      const { a, b, c, d, e, f } = transform;
      const det = a * d - b * c;
      if (det === 0) return;

      // Bentuk 5-argumen (`drawImage(img, dx, dy, dw, dh)`) menskalakan sumber
      // ke kotak tujuan; tanpa itu sumber digambar 1:1.
      const outW = dw ?? src.width;
      const outH = dh ?? src.height;
      if (outW <= 0 || outH <= 0) return;
      const scaleX = src.width / outW;
      const scaleY = src.height / outH;

      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const px = x + 0.5 - e;
          const py = y + 0.5 - f;
          // Balik matriks: titik kanvas → titik ruang-tujuan `drawImage`.
          const lx = (d * px - c * py) / det - dx;
          const ly = (-b * px + a * py) / det - dy;
          if (lx < 0 || ly < 0 || lx >= outW || ly >= outH) continue;

          const sx = Math.min(src.width - 1, Math.floor(lx * scaleX));
          const sy = Math.min(src.height - 1, Math.floor(ly * scaleY));

          const si = (sy * src.width + sx) * 4;
          const di = (y * canvas.width + x) * 4;
          const sa = ((src.pixels[si + 3] ?? 0) / 255) * context.globalAlpha;
          if (sa === 0) continue;

          pixels[di] = (src.pixels[si] ?? 0) * sa + (pixels[di] ?? 0) * (1 - sa);
          pixels[di + 1] = (src.pixels[si + 1] ?? 0) * sa + (pixels[di + 1] ?? 0) * (1 - sa);
          pixels[di + 2] = (src.pixels[si + 2] ?? 0) * sa + (pixels[di + 2] ?? 0) * (1 - sa);
          pixels[di + 3] = Math.max(pixels[di + 3] ?? 0, src.pixels[si + 3] ?? 0);
        }
      }
    },
  };

  // `ctx.filter` di-set lewat accessor supaya tes bisa memaksa browser "lama"
  // (supportsFilter = false) dan memastikan adapter jatuh ke jalur piksel.
  Object.defineProperty(context, "filter", {
    get: () => (supportsFilter ? filterValue : ""),
    set: (value: string) => {
      filterValue = value;
      filtersUsed.push(value);
    },
    enumerable: true,
    configurable: true,
  });

  canvas.context = context as unknown as Filter2DContext & { globalAlpha: number };
  canvas.convertToBlob = async () => new Blob([pixels.slice().buffer], { type: "image/jpeg" });

  return canvas;
}

/** Sumber gambar palsu: buffer RGBA + ukuran, seperti hasil `createImageBitmap`. */
export function createFakeSource(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number] = () => [0, 0, 0, 255],
): FakeSource {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * width + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = a;
    }
  }
  return { image: { width, height, pixels }, width, height, pixels };
}

/** Dependensi `applyFilters` yang memakai kanvas palsu + sumber tetap. */
export function fakeFilterDeps(
  source: FakeSource,
  options: FakeCanvasOptions = {},
): {
  createCanvas(width: number, height: number): FakeCanvas;
  decode(blob: Blob): Promise<FilterSource>;
  /** Semua kanvas yang dibuat, urut pembuatannya — untuk memeriksa `filtersUsed`. */
  canvases: FakeCanvas[];
} {
  const canvases: FakeCanvas[] = [];
  return {
    canvases,
    createCanvas: (width, height) => {
      const canvas = createFakeCanvas(width, height, options);
      canvases.push(canvas);
      return canvas;
    },
    decode: async () => source,
  };
}

/** Ambil RGBA satu piksel dari kanvas hasil. */
export function pixelAt(canvas: FakeCanvas, x: number, y: number): [number, number, number, number] {
  const i = (y * canvas.width + x) * 4;
  return [
    canvas.pixels[i] ?? 0,
    canvas.pixels[i + 1] ?? 0,
    canvas.pixels[i + 2] ?? 0,
    canvas.pixels[i + 3] ?? 0,
  ];
}

/** Baca ulang buffer jadi kanvas (untuk memeriksa hasil `convertToBlob`). */
export function decodeBlob(blob: Blob): Promise<FakePixels> {
  return blob.arrayBuffer().then((buffer) => ({
    width: 0,
    height: 0,
    pixels: new Uint8ClampedArray(buffer),
  }));
}
