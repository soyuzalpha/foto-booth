import { fileURLToPath } from "node:url";

/**
 * Direktori yang dibutuhkan server.
 *
 * Semua dihitung relatif ke file ini (`apps/api/src/paths.ts`), jadi tidak
 * bergantung pada cwd — penting karena container menjalankan `node src/index.ts`
 * dari `/app` sementara test jalan dari root repo.
 *
 * Bisa di-override lewat env untuk test / deploy yang layout-nya beda.
 */

const here = new URL(".", import.meta.url);

function dir(envVar: string, relative: string): string {
  const override = process.env[envVar];
  if (override) return fileURLToPath(new URL(override, "file:///"));

  return fileURLToPath(new URL(relative, here));
}

/** Landing page (neo-brutalism) yang di-serve di `/`. */
export const LANDING_DIR = dir("LANDING_DIR", "../static/landing/");

/** Hasil build studio SPA (`pnpm --filter @foto-booth/studio build`). */
export const STUDIO_DIST_DIR = dir("STUDIO_DIST_DIR", "../../studio/dist/");

/** Data runtime (galeri, dsb). Di-mount dari host, di luar image. */
export const STORAGE_DIR = dir("STORAGE_DIR", "../../../storage/");
