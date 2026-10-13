/**
 * Ingatan device terakhir — murni.
 *
 * Auto-connect (`autoConnect.ts`) butuh tahu kamera mana yang terakhir dipakai
 * operator. Nilai itu hidup di luar sesi (localStorage), jadi dipisah ke sini
 * supaya aturannya — kapan dianggap ada, kapan diabaikan — bisa diuji tanpa
 * DOM.
 *
 * Penyimpanan bisa **null**: mode privat / iframe terkunci membuat localStorage
 * melempar saat diakses. Dalam keadaan itu auto-connect tetap jalan, hanya
 * kehilangan ingatan antar-buka — bukan alasan menggagalkan pemilihan kamera.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Kunci penyimpanan; diekspor supaya tes & panel debug menyebut hal yang sama. */
export const REMEMBERED_DEVICE_KEY = "foto-booth:last-device";

/**
 * Id device yang diingat, atau `null` kalau tidak ada / tidak bisa dibaca.
 *
 * String kosong diperlakukan seperti "tidak ada": sebelum izin kamera diberikan
 * browser memberi `deviceId` kosong, dan menyimpannya justru membuat
 * auto-connect memilih device hantu.
 */
export function readRememberedDeviceId(store: KeyValueStore | null): string | null {
  if (store === null) return null;
  try {
    const value = store.getItem(REMEMBERED_DEVICE_KEY);
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * Simpan device yang berhasil tersambung. `null`/kosong menghapus ingatan —
 * lebih baik tidak punya ingatan daripada punya ingatan yang salah.
 */
export function rememberDeviceId(store: KeyValueStore | null, deviceId: string | null): void {
  if (store === null) return;
  try {
    if (deviceId === null || deviceId === "") store.removeItem(REMEMBERED_DEVICE_KEY);
    else store.setItem(REMEMBERED_DEVICE_KEY, deviceId);
  } catch {
    // Penyimpanan penuh/diblokir: ingatan hilang, alur tetap jalan.
  }
}

/**
 * `localStorage` kalau memang bisa dipakai, kalau tidak `null`.
 *
 * Dicek dengan menyentuhnya, bukan dengan `typeof` saja: di beberapa browser
 * properti `localStorage` ada tapi melempar begitu diakses.
 */
export function deviceStorage(): KeyValueStore | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const probe = "__fb-probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}
