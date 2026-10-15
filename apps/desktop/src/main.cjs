/**
 * Proses utama shell desktop (Fase 12, FEATURE-MATRIX #88).
 *
 * Peran berkas ini sempit dengan sengaja: **membungkus studio yang sudah ada**
 * di dalam jendela yang tidak bisa keluar sendiri. Tidak ada UI baru di sini —
 * semua layar tetap milik studio di `apps/studio`.
 *
 * Tiga hal yang membuat desktop **berbeda** dari membuka studio di browser, dan
 * itulah alasan berkas ini ada:
 *
 *   1. **Daftar printer.** `webContents.getPrintersAsync()` memberi nama dan
 *      status printer; browser biasa tidak bisa. Ini yang membuat #45 mungkin.
 *   2. **Cetak tanpa dialog.** Kiosk tidak boleh menampilkan dialog cetak ke
 *      tamu. `--kiosk` + `silent` mencetak langsung ke printer yang dipilih.
 *   3. **Kunci navigasi.** Di kiosk, mengikuti tautan keluar berarti tamu bisa
 *      keluar dari aplikasi. Tautan luar dibuka di browser sistem, navigasi
 *      dalam jendela dibatasi ke origin yang sama.
 *
 * Konteks berjalan `nodeIntegration: false` + `contextIsolation: true`; semua
 * kemampuan melewati preload sebagai API sempit. Renderer tidak pernah melihat
 * `require` atau `ipcRenderer`.
 */

"use strict";

const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");

const {
  buildPrintableHtml,
  isAllowedNavigation,
  isExternal,
  resolveOptions,
} = require("./lib/config.cjs");

const options = resolveOptions(process.argv, process.env);

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: options.width,
    height: options.height,
    show: false,
    backgroundColor: "#fffdf5",
    autoHideMenuBar: options.kiosk,
    fullscreen: options.kiosk,
    kiosk: options.kiosk,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      // Renderer tidak boleh punya akses Node — semua lewat preload.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Menu disembunyikan total di kiosk; di mode setup dibiarkan supaya operator
  // bisa membuka DevTools.
  if (options.kiosk) Menu.setApplicationMenu(null);

  // Tampilkan baru setelah halaman siap — mencegah kedipan putih di depan tamu.
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    if (options.devTools) mainWindow?.webContents.openDevTools({ mode: "detach" });
  });

  lockNavigation(mainWindow);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(options.url);

  return mainWindow;
}

/**
 * Batasi ke mana jendela boleh pergi.
 *
 * Dua hal yang dijaga:
 *   · navigasi di dalam jendela hanya ke origin yang sama;
 *   · jendela baru (`window.open`, `target=_blank`) tidak pernah dibuka sebagai
 *     jendela Electron — tautan luar diserahkan ke browser sistem.
 */
function lockNavigation(win) {
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, options.url)) {
      event.preventDefault();
      if (isExternal(url, options.url)) void shell.openExternal(url);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url, options.url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Di kiosk, pintasan keyboard yang bisa keluar dari aplikasi dimatikan.
  if (options.kiosk) {
    win.webContents.on("before-input-event", (event, input) => {
      const key = (input.key || "").toLowerCase();
      const combo = input.control || input.meta;
      const blocked =
        (combo && ["w", "n", "q", "r"].includes(key)) ||
        (combo && input.shift && ["i", "j", "c"].includes(key)) ||
        key === "f11" ||
        (input.alt && key === "f4") ||
        key === "escape";

      if (blocked) event.preventDefault();
    });
  }
}

/* ================================================================== *
 * IPC — semua kemampuan yang butuh proses utama
 * ================================================================== */

/**
 * Daftar printer dari sistem.
 *
 * Bentuk mentah dari Electron diteruskan apa adanya; normalisasinya ada di
 * `apps/studio/src/lib/print/printerRuntime.ts` supaya studio dan Electron
 * tidak punya dua versi aturan yang berbeda.
 */
ipcMain.handle("foto-booth:printers", async () => {
  if (mainWindow === null) return [];
  return mainWindow.webContents.getPrintersAsync();
});

/**
 * Cetak HTML ke printer tertentu.
 *
 * Dijalankan di jendela tersembunyi supaya isi halaman kiosk tidak ikut
 * tercetak. Jendela itu **selalu** ditutup, termasuk saat mencetak gagal —
 * kalau tidak, tiap kali operator mencetak satu jendela tersembunyi tertinggal.
 */
ipcMain.handle("foto-booth:print", async (_event, payload) => {
  const input = payload && typeof payload === "object" ? payload : {};
  const { html, deviceName, silent } = input;

  if (typeof html !== "string" || html === "") {
    return { ok: false, reason: "html kosong" };
  }

  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });

  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const result = await new Promise((resolve) => {
      printWindow.webContents.print(
        {
          silent: silent === true,
          deviceName: typeof deviceName === "string" && deviceName !== "" ? deviceName : undefined,
          printBackground: true,
        },
        (success, failureReason) => {
          resolve({ ok: success, reason: failureReason || undefined });
        },
      );
    });
    return result;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
});

/**
 * Simpan berkas lewat dialog sistem.
 *
 * Dipakai laporan diagnostik (#81): teknisi minta berkasnya, operator menekan
 * simpan, dan berkasnya mendarat di tempat yang bisa dikirim. Tanpa ini, kiosk
 * tidak punya jalan mengeluarkan berkas sama sekali.
 */
ipcMain.handle("foto-booth:save-file", async (_event, payload) => {
  const input = payload && typeof payload === "object" ? payload : {};
  const name = typeof input.name === "string" ? path.basename(input.name) : "berkas.txt";
  const data = typeof input.data === "string" ? input.data : "";

  try {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: name,
    });
    if (canceled || filePath === undefined) return { ok: false, reason: "dibatalkan" };

    await fs.writeFile(filePath, data, "utf8");
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
});

/* ================================================================== *
 * Daur hidup
 * ================================================================== */

// Dua instance kiosk yang jalan bersamaan akan berebut printer yang sama.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // Kiosk tidak punya alur "tutup jendela lalu buka lagi" — keluar penuh.
    app.quit();
  });
}

module.exports = { buildPrintableHtml };
