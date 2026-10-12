/**
 * Muat gambar dari URL jadi `HTMLImageElement` siap dipakai Konva.
 *
 * react-konva v19 tidak lagi mengekspor `useImage`, jadi hook kecil ini yang
 * mengurusnya. Yang penting di sini **pembatalan**: kalau `src` berganti (atau
 * komponen dibongkar) sementara gambar masih dimuat, hasil lama tidak boleh
 * menimpa yang baru — kalau tidak, sticker akan berkedip menampilkan gambar
 * sebelumnya.
 */

import { useEffect, useState } from "react";

export function useImageSrc(src: string | null | undefined): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (src === null || src === undefined || src === "") {
      setImage(null);
      return;
    }

    let cancelled = false;
    const element = new Image();
    element.crossOrigin = "anonymous";
    element.decoding = "async";

    element.onload = (): void => {
      if (!cancelled) setImage(element);
    };
    element.onerror = (): void => {
      if (!cancelled) setImage(null);
    };

    element.src = src;

    return () => {
      cancelled = true;
      element.onload = null;
      element.onerror = null;
    };
  }, [src]);

  return image;
}
