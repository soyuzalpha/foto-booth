/**
 * Sharing (Fase 9, FEATURE-MATRIX #56–#60).
 *
 * Tamu membagikan albumnya lewat WhatsApp, email, SMS, atau tombol share
 * bawaan perangkat. Yang penting di sini bukan tombolnya, tapi **tautannya**:
 *
 *   · **Satu tempat membangun URL share.** Kalau URL dirakit di komponen,
 *     tombol WhatsApp dan tombol copy akan berbeda diam-diam begitu salah satu
 *     diubah — dan yang rusak cuma yang paling jarang dites.
 *   · **Pesan yang dikirim tidak boleh memuat data pribadi.** Tautan galeri
 *     sudah cukup; menambahkan nama tamu ke pesan berarti nama itu ikut
 *     tersimpan di riwayat WhatsApp orang lain.
 *   · **Deep link, bukan SDK.** `wa.me`, `mailto:`, `sms:` tidak butuh skrip
 *     pihak ketiga — kiosk tetap jalan offline setelah halaman dimuat.
 *
 * Modul ini murni: tidak menyentuh `window`/`document`, jadi bisa diuji tanpa
 * browser. Pembukaan jendela dilakukan pemanggil.
 */

export const SHARE_CHANNELS = ["whatsapp", "email", "sms", "native", "copy"] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

export function isShareChannel(value: string): value is ShareChannel {
  return (SHARE_CHANNELS as readonly string[]).includes(value);
}

/** Batas panjang pesan share — cukup untuk judul + tautan, bukan surat. */
export const SHARE_MESSAGE_MAX = 300;

export interface ShareTarget {
  /** URL absolut halaman galeri. */
  url: string;
  /** Judul yang muncul di pesan. Biasanya nama acara/judul branding. */
  title: string;
  /** Kalimat opsional di depan tautan. */
  message?: string;
}

/**
 * Teks pesan yang dikirim lewat WhatsApp/SMS/email.
 *
 * Judul dan pesan dibersihkan dari baris baru: satu `\n` di tengah pesan
 * WhatsApp membuat tautan jatuh ke baris kedua, dan beberapa klien berhenti
 * meng-autolink tautan yang tidak di baris sendiri.
 */
export function shareText(target: ShareTarget): string {
  const clean = (value: string): string =>
    // eslint-disable-next-line no-control-regex
    value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

  const title = clean(target.title);
  const message = clean(target.message ?? "");

  const head = message !== "" ? `${message} — ${title}` : title;
  const composed = `${head}: ${target.url}`;
  return composed.slice(0, SHARE_MESSAGE_MAX);
}

/**
 * Tautan share per kanal.
 *
 * `native` sengaja `null`: Web Share API tidak punya URL — ia dipanggil lewat
 * `navigator.share()`. Mengembalikan `null` di sini membuat pemanggil harus
 * memilih jalur itu secara eksplisit, bukan membuka jendela ke `null`.
 */
export function shareLink(channel: ShareChannel, target: ShareTarget): string | null {
  const text = shareText(target);
  switch (channel) {
    case "whatsapp":
      return `https://wa.me/?text=${encodeURIComponent(text)}`;
    case "email":
      return `mailto:?subject=${encodeURIComponent(target.title)}&body=${encodeURIComponent(text)}`;
    case "sms":
      // `?body=` dipakai iOS; Android menerima keduanya. Tanpa nomor tujuan,
      // aplikasi pesan terbuka dan tamu memilih penerimanya sendiri.
      return `sms:?body=${encodeURIComponent(text)}`;
    case "native":
    case "copy":
      return null;
  }
}

/**
 * Judul halaman share (`/a/<hash>/share`).
 *
 * Dipakai crawler preview link: `og:title` harus berisi sesuatu yang bisa
 * diklik, bukan "Galeri foto" generik untuk semua acara.
 */
export function sharePageTitle(brandingHeading: string, eventName: string | null): string {
  const heading = brandingHeading.trim() !== "" ? brandingHeading.trim() : (eventName ?? "").trim();
  return heading === "" ? "Galeri foto" : heading;
}
