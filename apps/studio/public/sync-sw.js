/**
 * Bagian service worker untuk antrian upload.
 *
 * Di-`importScripts` dari SW utama (lihat `workbox.importScripts` di
 * `vite.config.ts`). Tugasnya SEMPIT dan sengaja begitu: membangunkan halaman
 * yang terbuka supaya halaman menjalankan antrian. SW tidak mengirim foto.
 *
 * Kenapa: token sesi operator ada di `localStorage`, dan service worker tidak
 * bisa membacanya. Kalau SW yang mengirim, tokennya harus ikut dipindah ke
 * storage yang bisa dibaca SW — kredensial jadi terjangkau lebih banyak kode.
 * Bangunkan halaman = nol kredensial di SW.
 */

self.addEventListener("sync", (event) => {
  if (event.tag !== "foto-booth-upload") return;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        client.postMessage({ type: "foto-booth:sync", tag: event.tag });
      }
    }),
  );
});
