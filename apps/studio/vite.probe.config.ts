/**
 * Konfigurasi build **probe** — memakai pipeline Vite/Rollup sungguhan (termasuk
 * plugin `runtimeAssets()` dari `vite.config.ts`), tapi tanpa plugin PWA.
 *
 * Gunanya: membuktikan bahwa bundling produksi faceEnhance benar-benar
 * menghasilkan chunk malas ORT (impor literal, bukan bare specifier yang mati),
 * dan wasm di-emit ke `models/ort/`. PWA dimatikan karena probe di-serve di
 * path `/` oleh API, sementara precache SW mengharapkan `/studio/`.
 */
import { defineConfig } from "vite";
import { runtimeAssets } from "./vite.config.ts";

export default defineConfig({
  // Base `/studio/` **sama persis** dengan aplikasi produksi, supaya
  // `import.meta.env.BASE_URL` menghasilkan `models/ort/` di `/studio/models/ort/`
  // dan topologi serve-nya identik (wasm bundled vs model dari API).
  base: "/studio/",
  plugins: [runtimeAssets()],
  build: {
    outDir: "dist-probe",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: "probe/index.html",
    },
  },
});
