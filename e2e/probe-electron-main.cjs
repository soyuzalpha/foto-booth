/**
 * Probe Fase 12 — membuktikan Electron benar-benar bisa menjalankan window
 * dan memuat URL di mesin ini (headless lewat xvfb-run).
 *
 * Bukan bagian aplikasi: ini alat validasi. Keluaran satu baris JSON supaya
 * mudah diperiksa oleh skrip shell.
 */
const { app, BrowserWindow } = require("electron");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 600, show: false });
  await win.loadURL("data:text/html,<h1 id='x'>halo</h1>");
  const text = await win.webContents.executeJavaScript("document.getElementById('x').textContent");
  const out = {
    ok: text === "halo",
    text,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  };
  console.log("PROBE_RESULT " + JSON.stringify(out));
  app.exit(out.ok ? 0 : 1);
});
