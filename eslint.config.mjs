import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dev-dist/**",
      "**/node_modules/**",
      "**/storage/**",
      "apps/api/static/**",
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
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
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
