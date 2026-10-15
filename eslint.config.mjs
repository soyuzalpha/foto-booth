import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-probe/**",
      "**/dev-dist/**",
      "**/node_modules/**",
      "**/storage/**",
      "apps/api/static/**",
      // Projekt native Capacitor: isinya template Gradle + **salinan build
      // studio** (`android/app/src/main/assets/public`). Menyalin hasil build
      // studio ke dalam `android/` membuat ribuan error lint dari kode yang
      // tidak pernah disunting di sini — dan yang lebih buruk, menutupi error
      // nyata di berkas sumber. Folder native tetap di-commit (tanpa itu
      // `cap sync` harus digenerate ulang tiap build), tapi tidak di-lint.
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "**/*.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Node: API + shared + konfigurasi root + skrip docs + harness e2e.
  // Harness e2e berjalan di Node tapi juga mengevaluasi kode di dalam halaman
  // (lihat `page.evaluate`), jadi keduanya butuh global node **dan** browser.
  {
    files: [
      "apps/api/**/*.ts",
      "packages/shared/**/*.ts",
      "*.ts",
      "*.mjs",
      "docs/**/*.mjs",
      "e2e/**/*.mjs",
      // Keputusan konfigurasi shell mobile (murni, diuji `node --test`).
      "apps/mobile/**/*.mjs",
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // CommonJS Node: shell desktop Electron (`main.cjs`/`preload.cjs`) dan probe
  // e2e. File-file ini memang `require()` — itu bentuk modul Electron, bukan
  // kesalahan. Global `process`/`console` juga sengaja dipakai.
  {
    files: ["apps/desktop/**/*.cjs", "e2e/**/*.cjs"],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: "commonjs",
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // Browser: studio app.
  {
    files: ["apps/studio/src/**/*.{ts,tsx}", "apps/studio/vite.config.ts"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // Probe produksi faceEnhance: entri browser yang dibangun lewat pipeline Vite
  // sungguhan (`vite.probe.config.ts`) untuk membuktikan jalur ORT + wasm +
  // cache model benar-benar jalan di bundel produksi. Dijalankan manual
  // (`vite build --config vite.probe.config.ts`), bukan bagian app.
  {
    files: ["apps/studio/probe/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // Service worker studio: global-nya sendiri (`self`, `clients`), bukan
  // `window`. File ini di-`importScripts` dari SW hasil build, jadi tidak
  // lewat bundler dan tidak punya tipe apa pun.
  {
    files: ["apps/studio/public/**/*.js"],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },

  // Import `.ts` eksplisit dipakai Node (type stripping) — bukan kesalahan.
  {
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
