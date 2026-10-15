/**
 * Penulis `capacitor.config.json` (Fase 12, #89).
 *
 * Berkas konfigurasi **dihasilkan**, bukan ditulis tangan. Alasannya praktis:
 * `capacitor.config.json` tidak bisa berisi komentar, jadi keputusan yang
 * menjelaskan *kenapa* `androidScheme` harus `https` tidak punya tempat di
 * sana. Keputusannya hidup di `src/lib/mobileConfig.mjs` (berkomentar + teruji),
 * dan berkas JSON-nya hanya cerminannya.
 *
 * Dua mode:
 *   · `node scripts/write-config.mjs`          → tulis berkas
 *   · `node scripts/write-config.mjs --check`  → gagal kalau berkas berbeda
 *
 * Mode `--check` yang dipakai di CI: kalau seseorang menyunting JSON-nya
 * langsung (melewati tes keputusan), CI menolak.
 *
 * Dev server dibaca dari env `FOTO_BOOTH_MOBILE_DEV_URL` supaya UI yang sedang
 * dikembangkan di mesin lain bisa dibuka dari HP. Nilainya **tidak** boleh ikut
 * ke commit — tanpa env, berkasnya kembali ke bentuk rilis.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { auditConfig, buildCapacitorConfig, toJsonFile } from "../src/lib/mobileConfig.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "..", "capacitor.config.json");

const check = process.argv.includes("--check");
const devServerUrl = process.env.FOTO_BOOTH_MOBILE_DEV_URL ?? null;

const config = buildCapacitorConfig({ devServerUrl });
const problems = auditConfig(config);
if (problems.length > 0) {
  // Dev server jarak jauh memang dilaporkan `auditConfig`, tapi itu keadaan
  // yang operator minta sendiri — bukan alasan menggagalkan penulisan.
  const blocking = problems.filter((p) => !p.startsWith("server.url terisi"));
  if (blocking.length > 0) {
    console.error("konfigurasi mobile tidak sah:");
    for (const problem of blocking) console.error(`  · ${problem}`);
    process.exit(1);
  }
  console.warn(`peringatan: ${problems.join("; ")}`);
}

const next = toJsonFile(config);

if (check) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    console.error(`capacitor.config.json belum ada — jalankan: pnpm config`);
    process.exit(1);
  }

  if (current !== next) {
    console.error("capacitor.config.json tidak cocok dengan keputusan di src/lib/mobileConfig.mjs");
    console.error("jalankan `pnpm config` dan commit hasilnya (jangan sunting JSON-nya langsung)");
    process.exit(1);
  }

  console.log("capacitor.config.json cocok");
} else {
  writeFileSync(target, next);
  console.log(`ditulis: ${path.relative(process.cwd(), target)}`);
}
