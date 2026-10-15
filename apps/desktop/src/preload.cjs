/**
 * Jembatan sempit antara renderer studio dan proses utama (Fase 12, #88).
 *
 * Renderer **tidak** mendapat `require`, `ipcRenderer`, atau akses modul apa
 * pun. Yang diekspos hanya beberapa fungsi bernama, dengan bentuk data yang
 * sudah ditentukan. Itu disengaja: studio memuat konten yang sebagian datang
 * dari database, dan permukaan sekecil ini membuat celah penyalahgunaan
 * menjadi sempit dan jelas.
 *
 * Nama `fotoBoothDesktop` dan bentuk fungsinya **mengikuti kontrak yang sudah
 * dideklarasikan studio** di `apps/studio/src/lib/print/printerRuntime.ts`
 * (`interface DesktopBridge`). Jangan diubah sepihak di sini — kalau berubah,
 * ubah keduanya, karena tidak ada tipe bersama yang mengikat berkas `.cjs` ini
 * ke TypeScript studio.
 *
 * Permukaan ini **opsional di studio**: kalau `window.fotoBoothDesktop` tidak
 * ada, studio berjalan sebagai web biasa (jalur `printBrowser.ts`). Jadi
 * menambah shell desktop tidak memaksa perangkat lain ikut berubah.
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fotoBoothDesktop", {
  /** Daftar printer sistem: `{ name, displayName, isDefault, status }[]`. */
  getPrinters: () => ipcRenderer.invoke("foto-booth:printers"),

  /**
   * Cetak HTML ke printer tertentu.
   *
   * Dipanggil studio hanya kalau printer yang dipilih berasal dari transport
   * `electron` — kalau tidak, jalur browser yang dipakai.
   */
  printHtml: (input) =>
    ipcRenderer.invoke("foto-booth:print", {
      html: input && typeof input.html === "string" ? input.html : "",
      deviceName:
        input && typeof input.deviceName === "string" && input.deviceName !== ""
          ? input.deviceName
          : "",
      silent: Boolean(input && input.silent),
    }),

  /** Simpan berkas lewat dialog sistem (laporan diagnostik #81). */
  saveFile: (input) =>
    ipcRenderer.invoke("foto-booth:save-file", {
      name: input && typeof input.name === "string" ? input.name : "berkas.txt",
      data: input && typeof input.data === "string" ? input.data : "",
    }),

  /** Versi runtime — untuk laporan diagnostik (#81). */
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
