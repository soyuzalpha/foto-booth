/**
 * Layar hasil kiosk (Fase 12 — titipan #51 & #52 dari Fase 9).
 *
 * Dua keputusan di sini murni supaya bisa diuji tanpa React dan tanpa layar:
 *
 *   1. **Tombol tamu mana yang tampil** setelah sesi foto selesai (#51).
 *      Konfigurasinya sudah ada sejak Fase 4 (`KioskButtons` di `kioskConfig`),
 *      tetapi belum pernah dipakai layar hasil — jadi tamu selalu melihat nol
 *      tombol, apa pun setelan operatornya.
 *   2. **Kapan keluar dari kiosk perlu peringatan dulu** (#52). Keluar dari
 *      kiosk mematikan fullscreen, melepas wake lock, dan (kalau sesi masih
 *      jalan) membuang frame yang belum diterima. Itu terlalu mudah terjadi
 *      karena satu ketukan jari yang salah di layar sentuh.
 *
 * Keduanya sengaja tidak menyentuh DOM: aturan "tombol share muncul" adalah
 * aturan produk, bukan detail render.
 */

import type { KioskButtons } from "./kioskConfig.ts";

export type KioskResultAction = "gallery" | "print" | "share";

/**
 * Urutan tampil tombol tamu.
 *
 * Cetak dulu: itu tindakan yang paling sering diinginkan tamu setelah sesi,
 * dan antrean cetak sudah jalan sendiri. Berbagi paling akhir karena butuh
 * sinyal — di venue tanpa wifi tombol itu sering tidak berguna.
 */
export const RESULT_ACTION_ORDER: readonly KioskResultAction[] = ["print", "gallery", "share"];

/** Tombol tamu yang menyala. `undefined`/null = tidak ada yang menyala. */
export function visibleResultActions(buttons: KioskButtons | null | undefined): KioskResultAction[] {
  if (buttons === null || buttons === undefined) return [];
  return RESULT_ACTION_ORDER.filter((action) => buttons[action] === true);
}

export interface ResultScreenInput {
  /** Kiosk sedang aktif. Di luar kiosk, layar hasil adalah panel operator. */
  kioskEnabled: boolean;
  /** Sesi terakhir sudah diterima (foto sudah tersimpan). */
  finished: boolean;
  /** Operator sudah membuka kunci lewat PIN — layar kembali jadi milik operator. */
  unlocked: boolean;
}

/**
 * Layar hasil tamu hanya untuk tamu: kiosk aktif, sesi sudah diterima, dan
 * layar tidak sedang dalam mode operator. Panel operator (yang punya tombol
 * hapus, ekspor, dan utak-atik template) tidak boleh muncul di depan tamu.
 */
export function shouldShowResultScreen(input: ResultScreenInput): boolean {
  return input.kioskEnabled && input.finished && !input.unlocked;
}

export interface ExitConfirmInput {
  enabled: boolean;
  /** Layar tarik sedang tampil — belum ada yang dikerjakan, keluar itu aman. */
  showAttract: boolean;
  /** Prompt PIN sedang terbuka; jangan menumpuk peringatan di atasnya. */
  locked: boolean;
  /** Sesi foto sedang berjalan (termasuk saat memproses). */
  sessionRunning: boolean;
  /** Sudah ada foto yang tersimpan di sesi ini. */
  hasSaved: boolean;
}

export type ExitWarningReason = "session" | "kiosk";

/**
 * Alasan peringatan keluar, atau `null` kalau boleh langsung keluar.
 *
 * `"session"` dipakai saat ada pekerjaan yang bisa hilang (sesi berjalan atau
 * sudah ada foto) — pesannya menyebut itu, karena tamu perlu tahu apa yang
 * hilang, bukan sekadar "yakin keluar?".
 */
export function exitWarningReason(input: ExitConfirmInput): ExitWarningReason | null {
  if (!input.enabled) return null;
  if (input.locked) return null;
  if (input.showAttract) return null;
  if (input.sessionRunning || input.hasSaved) return "session";
  return "kiosk";
}
