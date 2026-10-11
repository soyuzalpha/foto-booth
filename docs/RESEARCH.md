# Riset: SLR Booth Studio (slrbooth.com)

Tanggal riset: 2026-10-11 · Sumber: HTML mentah (curl), bundle JS produksi, API publik.
Semua klaim di bawah **hasil observasi langsung** dari bundle/API, bukan tebakan.

---

## 1. Produknya apa

**SLR Booth Studio** — software photo booth profesional. Jualan utama:

- **$99 sekali bayar** (Shopify: SKU `STUDIO` $99.99, ada juga `PERSONAL_LICENSE` $49.99).
- **Tanpa langganan, tanpa biaya per-event, tanpa meter kredit AI.**
- **BYOK (Bring Your Own Key)** — fitur AI pakai **API key Gemini milik user sendiri**, jadi biaya AI ditanggung operator, bukan vendor.
- Satu aplikasi, jalan di Web / Windows / macOS / Linux / Android / iOS.

Posisi pasar: bukan "filter booth" — headline-nya **AI style transfer** (anime, 3D cartoon, comic, watercolor, oil painting, custom prompt) + full platform booth.

---

## 2. Peta surface (domain & perannya)

| Domain | Isi | Teknologi |
|---|---|---|
| `slrbooth.com` | Situs marketing | **Astro** (static), 19 locale, hreflang SEO |
| `studio.slrbooth.com` | **Aplikasi utama** (capture/editor/kiosk) | React + Vite SPA, bundle 3.2 MB, chunked |
| `gallery.slrbooth.com` | Galeri tamu (browse/download/share) | React + Vite SPA |
| `api.slrbooth.com` | Backend API `v1` | `/health` → `{"status":"ok","version":"0.1.0"}` |
| `content.slrbooth.com` | CDN konten (template, frame, background, sticker) | `/api/{starters,frames,backgrounds,stickers,template-backgrounds}` |
| `shop.slrbooth.com` | Checkout lisensi | **Shopify** |
| `updates.slrbooth.com` (S3) | Manifest + model AI lokal | `local-ai/v1/manifest.json` |

Desktop = **Electron**. Mobile = **Capacitor** (Android/iOS). Web = build yang sama.

---

## 3. Stack teknis aplikasi (dibaca dari bundle produksi)

**Core:** React + Vite + react-router + **i18next** (16–19 bahasa) + **zustand-style store**.

**Kamera — abstraction "transport"** (inti arsitekturnya):
- `webcam` → `getUserMedia`
- `usb` → DSLR via **WebUSB** (`navigator.usb`), protokol **PTP** (`usb:${vendorId}:${productId}`)
- `network` → **PTP/IP** (`ptpip:${host}`) via `platformTcpConnector`
- `electron-native-transport` (USB native di desktop)
- `capacitor-android-transport` / `capacitor-ios-transport`

**AI (dua jalur):**
- **Lokal (ONNX Runtime Web)** — wasm SIMD-threaded + WebGPU bundle:
  - `birefnet_lite_matting_fp16.onnx` (1024²) → matting / green-screen
  - `gfpgan_v1.4_static.onnx` + `parsenet_labels.onnx` (512²) → face enhance
  - `rife49.onnx` → frame interpolation (slow-motion)
  - MediaPipe tasks-vision: `selfie_segmenter.tflite`, `face_landmarker.task`
- **Cloud (BYOK Gemini)** — key disimpan di prefs (`geminiApiKey`), request **diproxy lewat `api.slrbooth.com`** (ada token + timeout 30 s).

**Editor template:** **Konva + react-konva** (canvas drag-drop).

**Video:** **WebCodecs** (`VideoEncoder`) — av1 / vp9 / aac / flac / vorbis.

**Lain-lain:** IndexedDB + `storagePath` (offline-first, ada banner offline), service worker/PWA, **Sentry** (error tracking), `qrserver.com` (QR), JSZip (bundle download), exifr (EXIF), pako.

**Printing (3 jalur):** iframe browser print · Electron silent print · native USB printer plugin. Ada `paperSizes` + preset `na_2x6-strip_*` (strip 2×6).

---

## 4. Inventaris fitur (dari 217 key i18n — ini daftar definitifnya)

> Mana yang MVP vs Post-MVP vs Skip, plus kriteria terima & checklist QA: lihat **`FEATURE-MATRIX.md`**.

### Capture
countdown / tanpa countdown · mirror · allow retake · durasi review (detik) · aspect ratio **1:1 / 16:9 / 3:2** · image quality · rotasi **0/90/180/270** · shutter offset · auto-connect camera · pilih kamera (device id).

### Video
mode **snapshot / slow-mo** · resolusi · frame rate · max duration · slow-mo factor (½, ¼) · output FPS **24/30/60** · interpolation quality · output quality **480/720/1080/2160** · rekam audio · video guestbook · **animasi**: none / slideshow / boomerang + frame duration.

### Green screen & efek
`chromaKey {enabled, color, similarity, smoothness, spill}` · `virtualBackground {enabled, mode: blur|ai, blurStrength}` · `adjustments {brightness, contrast, saturation}` · `faceEnhance {enabled, strength}` · `effect`.

### AI
`aiStyle` (anime, 3D cartoon, comic, watercolor, oil, custom prompt) · `aiEnhance` · **AI remix** (boomerang remix + timeout) · AI backdrop · AI upscale · AI template elements · AI slow-motion.

### Template editor
`size` · `background {color|image, hasVignette}` · `frames[{x,y,w,h,borderThickness,borderColor,hasShadow,aspectRatio}]` · `textElements[{x,y,w,h,text,fontSize,fontFamily,fill,stroke,strokeWidth,rotation,align}]` dengan token **`{event}` / `{date}`** · `stickers[{x,y,w,h,src,rotation}]` · starters (template siap pakai).

### Kiosk
fullscreen · idle timeout (auto reset) · **PIN lock** · tap to start · tampil/sembunyikan tombol gallery/print/share · warning keluar.

### Sharing & galeri
**SMS · email · QR code · sosial media** · branded share page · print QR · **online gallery** (upload otomatis, nama event, password galeri, **TTL 30 hari**) · `gallery.slrbooth.com/album/<hash>` · branding (logo, heading, subheading) · white-label.

### Leads (lead capture)
Field custom: **text / email / phone / select / checkbox** · required · consent text · tombol skip · preview · **export CSV** · disclaimer.

### Printing
enable printing · auto print · copies · paper size · pilih printer · **deteksi USB printer** · badge dye-sub/standard.

### Analytics & diagnosa
view analytics · debug mode · cek USB printer · cek storage (writable) · **kirim laporan diagnosa via email** · pilih lokasi storage + prompt copy.

---

## 5. Library konten bawaan (diukur dari API)

| Endpoint | Kategori | Item |
|---|---|---|
| `/api/starters` | 10 | **17** template siap pakai |
| `/api/frames` | 6 | **26** frame (dengan meta 9-slice border) |
| `/api/backgrounds` | 15 | **82** virtual background |
| `/api/stickers` | 33 | **2.052** sticker |
| `/api/template-backgrounds` | 5 | **25** background template |

Skema starter = JSON lengkap (size + background + frames + textElements + stickers) → **template itu data, bukan gambar**. Ini yang bikin clone-nya realistis.

---

## 6. Model bisnis & lisensi

- **Sekali bayar $99**, update termasuk selamanya. Tidak ada langganan/per-event/credit.
- **Lisensi via email OTP:** `POST /v1/entitlements/verify` (kirim kode) → `/confirm` (tukar jadi token) → `/me` (validasi) + `/validate/appstore` (IAP).
- Token disimpan di prefs lokal (`license`). IAP untuk App Store.
- **Biaya AI = biaya user** (BYOK Gemini) → margin vendor bersih.

---

## 7. Yang bisa & tidak bisa di-clone

**Bisa (semua client-side, jalan di browser):** capture webcam, template editor, photo strip, print, kiosk, QR/share, galeri, green screen, face enhance, slow-mo (ONNX/MediaPipe/WebCodecs).

**Butuh kerja keras / hardware:** kontrol DSLR via USB (**WebUSB + implementasi protokol PTP dari nol**) — ini bagian paling berat; alternatif realistis = fokus webcam + HDMI capture card dulu.

**Legal:** nama, logo, brand, dan 2.000+ aset konten mereka **tidak boleh** dipakai. Clone = arsitektur + fitur; aset & brand harus milik sendiri.

---

## 8. Kesimpulan riset

Clone ini **layak dan realistis** karena:
1. Semua fitur inti jalan di browser (tidak ada rahasia server-side).
2. Template = JSON, jadi editor bisa dibangun dengan Konva.
3. AI-nya **BYOK** → kita tidak perlu bayar inference; cukup integrasi key user.
4. Model model AI-nya publik (BiRefNet, GFPGAN, RIFE) — bisa di-host sendiri.
5. Yang berat hanya PTP/DSLR — bisa ditunda ke fase akhir.
