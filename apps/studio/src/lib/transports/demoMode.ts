/**
 * Mode demo: memaksa `FakeTransport` lewat query string.
 *
 * Kamera sungguhan tidak selalu ada — CI, mesin pengembang tanpa webcam,
 * dan harness e2e headless semuanya butuh alur sesi yang bisa dijalankan
 * tanpa perangkat. Tanpa jalur eksplisit, satu-satunya cara memaksa transport
 * palsu adalah menambal `navigator.mediaDevices` dari luar, dan itu membuat
 * perilaku aplikasi bergantung pada trik penguji, bukan pada kode.
 *
 * Jadi permintaan mode demo dibaca dari `?fake=`:
 *
 *   · `?fake=webcam`        → hanya webcam palsu;
 *   · `?fake=capture-card`  → hanya capture card palsu (alias `hdmi`);
 *   · `?fake` / nilai lain  → semua perangkat palsu.
 *
 * Tanpa parameter itu fungsi ini mengembalikan `null`, dan pemanggil memakai
 * transport sungguhan. Fungsi ini **murni** — tidak menyentuh `location` atau
 * `navigator` — supaya bisa diuji tanpa DOM.
 */

import {
  FAKE_CAPTURE_CARD,
  FAKE_DEVICES,
  FAKE_WEBCAM,
  type FakeDeviceSpec,
} from "./fakeTransport.ts";

/** Nama parameter query untuk meminta mode demo. */
export const DEMO_PARAM = "fake";

/**
 * Perangkat palsu yang diminta `search`, atau `null` kalau mode demo tidak
 * dipinta.
 *
 * `search` boleh dengan atau tanpa tanda tanya — `URLSearchParams` menerima
 * keduanya.
 */
export function demoSpecs(search: string): readonly FakeDeviceSpec[] | null {
  const raw = new URLSearchParams(search).get(DEMO_PARAM);
  if (raw === null) return null;

  switch (raw.trim().toLowerCase()) {
    case "webcam":
      return [FAKE_WEBCAM];
    case "capture-card":
    case "hdmi":
      return [FAKE_CAPTURE_CARD];
    // `?fake`, `?fake=1`, `?fake=all`, atau nilai tak dikenal: pakai semuanya.
    // Nilai tak dikenal sengaja tidak dianggap "tidak ada permintaan" — kalau
    // salah ketik, lebih baik dapat mode demo daripada kamera yang tak ada.
    default:
      return FAKE_DEVICES;
  }
}
