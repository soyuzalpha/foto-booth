/**
 * Auto-connect kamera — murni.
 *
 * Kiosk dijalankan operator yang sama tiap hari dengan perangkat yang sama.
 * Memilih kamera dari dropdown tiap kali buka aplikasi itu pekerjaan yang tidak
 * perlu, jadi studio menyambung sendiri saat dibuka.
 *
 * Pemilihannya murni & teruji supaya aturannya jelas dan bisa diaudit:
 *
 *   1. **device yang terakhir dipakai** — kalau masih ada, itu yang paling
 *      benar; operator sudah memutuskan sekali dan tidak perlu memutuskan lagi;
 *   2. **capture card** — di studio, feed dari kamera utama masuk lewat HDMI
 *      capture; itu pilihan yang hampir selalu diinginkan;
 *   3. **device pertama** yang terdaftar — jaring terakhir supaya kamera tetap
 *      tersambung tanpa operator menekan apa pun;
 *   4. kalau tidak ada device sama sekali → `null`, dan UI menampilkan pesan.
 */

import type { CameraDevice } from "../transports/types.ts";

export type AutoConnectReason = "remembered" | "capture-card" | "first" | "none";

export interface AutoConnectPick {
  deviceId: string | null;
  reason: AutoConnectReason;
}

/**
 * Pilih device untuk disambung otomatis.
 *
 * `rememberedId` = id yang tersimpan dari sesi terakhir; boleh `null` (belum
 * pernah ada). Device dengan id yang sama tapi sudah tidak terpasang **tidak**
 * dipakai — menyambung ke device hantu hanya menghasilkan error di layar.
 */
export function pickAutoConnectDevice(
  devices: readonly CameraDevice[],
  rememberedId: string | null,
): AutoConnectPick {
  if (devices.length === 0) return { deviceId: null, reason: "none" };

  if (rememberedId !== null) {
    const remembered = devices.find((device) => device.id === rememberedId);
    if (remembered !== undefined) return { deviceId: remembered.id, reason: "remembered" };
  }

  const captureCard = devices.find((device) => device.source === "capture-card");
  if (captureCard !== undefined) return { deviceId: captureCard.id, reason: "capture-card" };

  const first = devices[0];
  return first === undefined
    ? { deviceId: null, reason: "none" }
    : { deviceId: first.id, reason: "first" };
}

/**
 * Apakah auto-connect harus jalan sekarang.
 *
 * Sengaja tidak menyambung ulang kalau sudah ada device tersambung: operator
 * yang sedang memakai kamera lain jangan direbut kameranya oleh kode.
 */
export function shouldAutoConnect(options: {
  enabled: boolean;
  devices: readonly CameraDevice[];
  currentDeviceId: string | null;
}): boolean {
  if (!options.enabled) return false;
  if (options.currentDeviceId !== null) return false;
  return options.devices.length > 0;
}

/** Label singkat alasan pemilihan, untuk log/panel debug. */
export function describeAutoConnectReason(reason: AutoConnectReason): string {
  switch (reason) {
    case "remembered":
      return "kamera terakhir";
    case "capture-card":
      return "capture card";
    case "first":
      return "kamera pertama";
    default:
      return "tidak ada kamera";
  }
}
