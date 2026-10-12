/**
 * Klasifikasi device: webcam atau capture card?
 *
 * Browser tidak memberi tahu. `enumerateDevices()` cuma memberi `label` dan
 * `deviceId`. Jadi ini **heuristik**, dan itu fakta yang harus diterima — bukan
 * disembunyikan. Karena itu hasilnya selalu membawa `confidence`, dan operator
 * bisa menimpanya lewat UI (`override`).
 *
 * Yang bergantung pada hasil ini: mirror default. Salah klasifikasi = hasil foto
 * kebalik. Itu kerusakan yang kelihatan setelah tamu pulang, jadi lebih baik
 * operator bisa mengoreksi manual daripada kita berpura-pura yakin.
 */

import type { CameraDevice, DeviceClassification, DeviceSource } from "./types.ts";

/**
 * Petunjuk capture card. Nama produk nyata yang sering muncul di
 * `enumerateDevices()` — Elgato, AVerMedia, Magewell, dongle murah MS2109, dan
 * perangkat lunak capture bawaan.
 */
const CAPTURE_CARD_HINTS: readonly string[] = [
  "cam link",
  "camlink",
  "elgato",
  "avermedia",
  "live gamer",
  "magewell",
  "blackmagic",
  "decklink",
  "ultra studio",
  "game capture",
  "hd60",
  "evga xt",
  "usb video",
  "usb3.0 video",
  "usb 3.0 video",
  "usb video grabber",
  "video grabber",
  "hdmi",
  "capture",
  "uvc hdmi",
  "hauppauge",
  "colossus",
  "ezcap",
  "ms2109",
  "macro silicon",
  "ugo",
];

/** Petunjuk webcam. Menang atas petunjuk capture card kalau keduanya cocok. */
const WEBCAM_HINTS: readonly string[] = [
  "facetime",
  "integrated camera",
  "integrated webcam",
  "hd user facing",
  "user facing",
  "front camera",
  "rear camera",
  "webcam",
  "logitech",
  "c920",
  "c922",
  "c930",
  "brio",
  "obsbot",
  "insta360",
  "kamera depan",
  "kamera belakang",
];

function scoreLabel(label: string, hints: readonly string[]): string[] {
  const lower = label.toLowerCase();
  return hints.filter((hint) => lower.includes(hint));
}

/**
 * Tentukan jenis device dari label.
 *
 * Aturan:
 * 1. Label kosong (izin belum diberikan) → default `webcam`, `confidence: "default"`.
 * 2. Cocok petunjuk webcam → `webcam`, menang atas petunjuk capture card
 *    (banyak capture card memakai chip UVC yang sama dengan webcam, tapi
 *    "Logitech BRIO" tidak pernah berarti capture card).
 * 3. Cocok petunjuk capture card → `capture-card`.
 * 4. Tidak ada petunjuk → `webcam` (default aman: mirror nyala lebih jarang
 *    merusak daripada mirror mati pada webcam).
 */
export function classifyLabel(label: string): DeviceClassification {
  const trimmed = label.trim();

  if (trimmed === "") {
    return { source: "webcam", score: 0, matched: [], confidence: "default" };
  }

  const webcamMatches = scoreLabel(trimmed, WEBCAM_HINTS);
  if (webcamMatches.length > 0) {
    return {
      source: "webcam",
      score: webcamMatches.length,
      matched: webcamMatches,
      confidence: "hint",
    };
  }

  const cardMatches = scoreLabel(trimmed, CAPTURE_CARD_HINTS);
  if (cardMatches.length > 0) {
    return {
      source: "capture-card",
      score: cardMatches.length,
      matched: cardMatches,
      confidence: "hint",
    };
  }

  return { source: "webcam", score: 0, matched: [], confidence: "default" };
}

/** Terapkan hasil klasifikasi ke sebuah device, dengan override manual opsional. */
export function describeDevice(
  id: string,
  rawLabel: string,
  override?: DeviceSource,
): CameraDevice {
  const classification =
    override === undefined
      ? classifyLabel(rawLabel)
      : {
          source: override,
          score: 0,
          matched: [],
          confidence: "override" as const,
        };

  const label = rawLabel.trim() === "" ? `Kamera ${id.slice(0, 6)}` : rawLabel.trim();

  return { id, label, source: classification.source, classification };
}

/** Label singkat untuk ditampilkan di dropdown, biar operator tahu ini device apa. */
export function deviceBadge(device: CameraDevice): string {
  return device.source === "capture-card" ? "HDMI" : "Webcam";
}
