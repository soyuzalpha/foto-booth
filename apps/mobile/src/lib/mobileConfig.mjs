/**
 * Keputusan konfigurasi shell mobile (Fase 12, FEATURE-MATRIX #89).
 *
 * Berkas ini **murni**: tidak menyentuh Capacitor, tidak butuh Android SDK, dan
 * bisa diuji dengan `node --test`. Itu disengaja — build Android/iOS tidak bisa
 * dijalankan di mesin ini (tidak ada Java/Android SDK, dan iOS memang tidak bisa
 * di Linux), jadi yang bisa dan **harus** dibuktikan di sini adalah
 * keputusannya. Konfigurasi yang salah tidak terlihat sampai aplikasi dibuka di
 * HP, dan di lapangan itu sudah terlambat.
 *
 * Tiga keputusan yang gampang salah dan mahal:
 *
 *   1. **`androidScheme: "https"`.** WebView Android menyajikan aplikasi lewat
 *      `http://localhost` secara default. Origin itu **bukan secure context**,
 *      dan tanpa secure context `getUserMedia` tidak ada — artinya kamera kiosk
 *      mati di HP. `https://localhost` lewat skema `https` membuatnya secure
 *      tanpa sertifikat apa pun. Ini alasan nomor satu shell mobile ada.
 *   2. **`webDir` menunjuk build studio**, bukan folder baru. Aplikasi mobile
 *      adalah studio yang sama; menyalin UI ke sini berarti dua kode yang
 *      berbeda diam-diam.
 *   3. **Tidak ada `server.url` di produksi.** Kalau diisi, aplikasi jadi
 *      pembungkus halaman web jarak jauh: tak bisa jalan offline dan isinya
 *      berubah sendiri di HP orang. `server.url` hanya boleh lewat flag dev
 *      eksplisit.
 */

"use strict";

/** ID aplikasi — harus sama dengan `build.appId` shell desktop. */
export const APP_ID = "id.soyuz.fotobooth";

/** Nama yang muncul di bawah ikon. */
export const APP_NAME = "Foto Booth";

/**
 * Folder build studio, relatif terhadap `apps/mobile`.
 * Studio adalah satu-satunya sumber UI; mobile tidak menggandakannya.
 */
export const WEB_DIR = "../studio/dist";

/**
 * Bangun objek konfigurasi Capacitor.
 *
 * @param {{ devServerUrl?: string | null }} [input]
 *   `devServerUrl` diisi hanya saat mengembangkan UI di mesin lain. Nilainya
 *   harus datang dari operator, bukan dari berkas yang di-commit.
 */
export function buildCapacitorConfig(input = {}) {
  const devServerUrl =
    typeof input.devServerUrl === "string" && input.devServerUrl.trim() !== ""
      ? input.devServerUrl.trim()
      : null;

  /** @type {Record<string, unknown>} */
  const config = {
    appId: APP_ID,
    appName: APP_NAME,
    webDir: WEB_DIR,
    // Kamera butuh secure context; `https` adalah cara mendapatkannya di
    // WebView Android tanpa sertifikat.
    androidScheme: "https",
    // Konten aplikasi datang dari dalam paket. Membiarkan jembatan native
    // membaca origin luar membuka jalan bagi halaman asing untuk memanggil
    // plugin — di kiosk itu tidak bisa dibenarkan.
    server: {
      androidScheme: "https",
      cleartext: false,
      // `null` berarti field ini dibuang saat serialisasi (lihat `toJsonFile`).
      url: devServerUrl,
    },
  };

  return config;
}

/**
 * Serialisasi konfigurasi ke bentuk berkas `capacitor.config.json`.
 *
 * Field bernilai `null` dibuang, bukan ditulis sebagai `null`: Capacitor
 * memperlakukan `"url": null` sebagai diisi dan gagal memuatnya. Konfigurasi
 * yang di-commit karena itu tidak boleh menyimpan kunci kosong.
 */
export function toJsonFile(config) {
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (value !== null && typeof value === "object") {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [key, inner] of Object.entries(value)) {
        if (inner === null || inner === undefined) continue;
        out[key] = strip(inner);
      }
      return out;
    }
    return value;
  };

  return `${JSON.stringify(strip(config), null, 2)}\n`;
}

/**
 * Apakah konfigurasi aman dipakai di lapangan.
 *
 * Dipakai sebagai pemeriksaan sebelum build: mengembalikan daftar alasan, bukan
 * melempar, supaya pemanggil bisa menampilkan semuanya sekaligus.
 */
export function auditConfig(config) {
  const problems = [];

  if (config.androidScheme !== "https") {
    problems.push(
      "androidScheme harus \"https\": tanpa secure context kamera kiosk mati di WebView Android",
    );
  }

  const server = config.server ?? {};
  if (server.cleartext === true) {
    problems.push("cleartext harus false: konten aplikasi tidak boleh lewat HTTP polos");
  }

  const url = server.url;
  if (typeof url === "string" && url.trim() !== "") {
    // Bukan mutlak salah (dipakai saat dev), tapi tidak boleh jadi bentuk rilis.
    problems.push(
      `server.url terisi (${url}): aplikasi akan memuat UI dari jarak jauh, bukan dari paket`,
    );
  }

  if (typeof config.webDir !== "string" || config.webDir.trim() === "") {
    problems.push("webDir kosong: aplikasi tidak punya UI untuk dibungkus");
  }

  return problems;
}
