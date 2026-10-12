import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

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
