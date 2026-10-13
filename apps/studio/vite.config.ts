import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Berkas wasm MediaPipe (≈13 MB × 3 varian) yang harus tersedia di
 * `/studio/models/mediapipe/`. **Tidak di-commit** — disajikan dari
 * `node_modules` saat dev dan di-emit ke `dist/` saat build, jadi git tetap
 * ramping sementara kiosk tetap bisa memuat segmenter tanpa jaringan.
 */
const MEDIAPIPE_WASM_FILES = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
  "vision_wasm_module_internal.js",
  "vision_wasm_module_internal.wasm",
] as const;

/**
 * Berkas runtime wasm `onnxruntime-web` (≈14 MB) untuk face enhance. Sama
 * seperti MediaPipe: **tidak di-commit** — disajikan dari `node_modules` saat
 * dev dan di-emit ke `dist/models/ort/` saat build, supaya kiosk memuat face
 * enhance tanpa CDN. Varian `simd-threaded` (bukan `jsep`) cukup: face enhance
 * memakai backend wasm, bukan WebGPU.
 */
const ORT_WASM_FILES = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"] as const;

/** Sajikan aset runtime AI dari `node_modules` (dev) & emit ke build (prod). */
export function runtimeAssets(): Plugin {
  const require = createRequire(import.meta.url);
  // `exports` paket tidak membuka `./package.json`, jadi resolusi lewat entri
  // utama lalu naik satu level ke akar paket.
  const mediapipeDir = (): string => join(dirname(require.resolve("@mediapipe/tasks-vision")), "wasm");
  // Entri `onnxruntime-web` = `dist/ort.node.min.js`, jadi `dirname` sudah
  // menunjuk ke `dist/` tempat `.wasm` berada — jangan tambah `dist` lagi.
  const ortDir = (): string => dirname(require.resolve("onnxruntime-web"));

  /** Pasangan (marker URL, direktori sumber, daftar berkas yang boleh disajikan). */
  const mounts: readonly { marker: string; dir: () => string; files: readonly string[] }[] = [
    { marker: "/models/mediapipe/", dir: mediapipeDir, files: MEDIAPIPE_WASM_FILES },
    { marker: "/models/ort/", dir: ortDir, files: ORT_WASM_FILES },
  ];

  return {
    name: "foto-booth:runtime-assets",

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        for (const mount of mounts) {
          const at = path.lastIndexOf(mount.marker);
          if (at === -1) continue;
          const file = path.slice(at + mount.marker.length);
          if (!mount.files.includes(file)) return next();
          try {
            res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript");
            res.end(readFileSync(join(mount.dir(), file)));
          } catch {
            next();
          }
          return;
        }
        next();
      });
    },

    buildStart() {
      for (const mount of mounts) {
        for (const file of mount.files) {
          this.emitFile({
            type: "asset",
            fileName: `${mount.marker.slice(1)}${file}`,
            source: readFileSync(join(mount.dir(), file)),
          });
        }
      }
    },

    /**
     * Buang salinan ganda wasm ORT dari `assets/`.
     *
     * Glue `onnxruntime-web` memuat wasm lewat `new URL("…wasm", import.meta.url)`,
     * jadi Vite ikut menyalin berkas 14 MB itu ke `assets/` dengan hash — padahal
     * runtime **tidak pernah** memakainya: `configureWasmPaths()` mengarahkan ORT
     * ke `models/ort/` (yang kita emit sendiri di `buildStart`). Menghapusnya
     * menghemat 14 MB per build. Hanya berlaku untuk berkas di luar `models/`,
     * jadi salinan yang kita host tetap utuh.
     */
    generateBundle(_options, bundle) {
      const hosted = new Set(ORT_WASM_FILES.map((f) => `models/ort/${f}`));
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "asset" || hosted.has(fileName)) continue;
        const base = fileName.slice(fileName.lastIndexOf("/") + 1);
        if (ORT_WASM_FILES.some((f) => base.startsWith(f.replace(/\.(mjs|wasm)$/, "")))) {
          delete bundle[fileName];
        }
      }
    },
  };
}

/**
 * Studio app = SPA (bukan SSR) karena butuh akses device — kamera, WebUSB,
 * WebCodecs, fullscreen — dan harus tetap jalan tanpa internet.
 *
 * Di-serve API di `/studio/`, jadi `base` diset ke situ juga supaya aset dan
 * scope service worker konsisten antara dev, preview, dan produksi.
 */
export default defineConfig({
  base: "/studio/",

  plugins: [
    react(),
    runtimeAssets(),

    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png"],

      manifest: {
        name: "Foto Booth Studio",
        short_name: "Foto Booth",
        description:
          "Photo booth di browser. Capture, template, cetak, kiosk, galeri QR — jalan tanpa internet.",
        lang: "id",
        start_url: "/studio/",
        scope: "/studio/",
        display: "standalone",
        orientation: "any",
        theme_color: "#ffd93d",
        background_color: "#fffdf5",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },

      workbox: {
        // App shell di-precache: ini yang bikin aplikasi tetap kebuka offline.
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        navigateFallback: "/studio/index.html",
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        // Handler Background Sync untuk antrian upload. Path-nya relatif
        // terhadap lokasi SW (`/studio/sw.js`), bukan terhadap root situs.
        importScripts: ["./sync-sw.js"],
      },

      // Service worker aktif juga saat `pnpm dev`, biar mode offline bisa
      // diuji tanpa build produksi.
      devOptions: { enabled: true, type: "module" },
    }),
  ],

  server: {
    port: 5173,
    proxy: {
      "/v1": "http://127.0.0.1:5050",
      "/health": "http://127.0.0.1:5050",
      "/version": "http://127.0.0.1:5050",
      // Katalog konten yang dibundel — dipakai sync offline. Tanpa ini,
      // aset tidak bisa di-cache saat dev/preview.
      "/content": "http://127.0.0.1:5050",
      // Model AI besar (GFPGAN ~340 MB) dilayani API dari `$STORAGE_DIR/models/`.
      // Path `/models/*` **tidak** bertabrakan dengan wasm bundled
      // (`/studio/models/*`), jadi aman diproksi. Tanpa ini, face enhance selalu
      // gagal di dev karena `/models/*` jatuh ke SPA fallback (HTML, bukan ONNX).
      "/models": "http://127.0.0.1:5050",
    },
  },

  // `vite preview` memakai blok `preview`, bukan `server`. Validasi Fase 3
  // (offline & print) jalan di produksi build, jadi proxy-nya harus ada di sini
  // juga — kalau tidak, sync konten selalu gagal di `:5174`.
  preview: {
    port: 5174,
    proxy: {
      "/v1": "http://127.0.0.1:5050",
      "/health": "http://127.0.0.1:5050",
      "/version": "http://127.0.0.1:5050",
      "/content": "http://127.0.0.1:5050",
      "/models": "http://127.0.0.1:5050",
    },
  },

  build: {
    target: "es2022",
    sourcemap: true,
  },

  /**
   * Worker render template meng-import `@foto-booth/shared`, jadi bundelnya
   * **code-split**. Format default worker adalah `iife`, dan Rollup menolak
   * `iife` untuk bundel yang di-split. `es` juga yang benar untuk
   * `new Worker(url, { type: "module" })` — sama dengan yang dipakai runtime.
   */
  worker: {
    format: "es",
  },
});
