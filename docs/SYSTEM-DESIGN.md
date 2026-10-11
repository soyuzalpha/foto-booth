# System Design: Photo Booth Web App (clone arsitektur SLR Booth)

Stack: **TypeScript** end-to-end · Scope sekarang: **web app dulu** (desktop/mobile menyusul).
Prinsip: **client-first** (capture, edit, render, AI lokal semua di browser) + backend tipis untuk lisensi, galeri, konten.

---

## 1. Arsitektur tinggi

```
                        ┌──────────────────────────────────────────┐
   Operator (kiosk)     │  STUDIO APP  (Vite + React + TS, SPA)    │
   ────────────────►    │  capture · editor · kiosk · print · AI   │
                        └───────┬──────────────┬───────────────────┘
                                │              │
   Tamu (HP)  ──────────►  GALLERY (halaman HTML dari API)
                                │              │
                        ┌───────▼──────────────▼───────────────────┐
                        │  API  (Fastify + TS + Zod + Drizzle)     │
                        │  entitlements · galleries · leads · orders│
                        └───┬────────┬─────────┬──────────┬─────────┘
                            │        │         │          │
                      ┌─────▼──┐ ┌───▼───┐ ┌───▼────┐ ┌───▼─────┐
                      │Postgres│ │ Redis │ │  S3    │ │ Queue   │
                      │(data)  │ │(cache)│ │(media) │ │(BullMQ) │
                      └────────┘ └───────┘ └────────┘ └─────────┘
                                              │
                                        ┌─────▼──────┐
                                        │ CDN (konten│
                                        │ + foto)    │
                                        └────────────┘
```

**Keputusan kunci:** studio app = **SPA client-heavy** (bukan Next SSR) karena butuh akses device (kamera, WebUSB, WebCodecs, fullscreen) dan harus tetap jalan offline. Marketing + gallery **bukan app terpisah**: gallery = halaman server-rendered dari API (butuh OG image, tapi itu cuma meta tag); marketing ditunda sampai mau jualan.

---

## 2. Struktur repo (monorepo ramping — pnpm workspace, tanpa Turborepo)

**Hari-1: 3 unit. Bukan 4 app + 8 package.**

```
foto-booth/
├─ apps/
│  ├─ studio/        # APLIKASI UTAMA — Vite + React 19 + TS (SPA, offline-first)
│  └─ api/           # Fastify + TS (backend tipis)
└─ packages/
   └─ shared/        # Zod schema + tipe + konstanta (satu sumber FE↔BE)
```

- **pnpm workspace** (`pnpm-workspace.yaml`) → wajib. Ini satu-satunya alasan kuat monorepo: `shared` di-import studio **dan** api, jadi tipe FE↔BE tidak drift.
- **Turborepo: belum.** `pnpm -r build` sudah build urut topologis (shared → studio/api). Turbo cuma menambah *caching*; untuk 3 unit nggak ada yang di-cache berarti. Tambah nanti, bukan sekarang.
- Aturan: `packages/*` **tidak boleh** import dari `apps/*`. `shared` = satu-satunya sumber tipe untuk FE↔BE.

### Kenapa cuma begini

Yang **beneran memaksa** struktur pisah cuma dua:
1. Studio app harus **SPA + offline** → tidak bisa jadi route Next.js, jadi target build wajib terpisah dari API.
2. **Zod schema + tipe dipakai bareng** studio ↔ API → tanpa workspace, gampang drift.

Sisanya aspirasional. Jangan disiapkan sebelum ada kebutuhan.

### Kapan dipecah lagi (kriteria, bukan tanggal)

| Tambah | Saat |
|---|---|
| `packages/core` | Logika capture/template/print dipakai **>1 app** (mis. studio + shell Electron) |
| `apps/gallery` | Butuh SSR + OG image yang SEO-nya kritis (sebelum itu: halaman server-rendered dari API cukup) |
| `apps/web` (marketing) | Saat mau jualan |
| `packages/{transports,ai,print,ui,i18n,db}` | Saat kode di dalam studio udah besar & jelas batasnya |
| **Turborepo** | Build/CI mulai lambat, atau app >3 |
| Nx / Bazel | Hampir nggak pernah, untuk proyek sebesar ini |

Untuk MVP, `apps/studio/src/lib` sudah cukup menampung capture/template/print. Diangkat jadi package **kalau** ada consumer kedua — bukan sebelum.

---

## 3. Modul inti (hari-1: `apps/studio/src/lib`)

### 3.1 Capture engine
State machine eksplisit — ini jantung aplikasi:

```
idle → armed → countdown → capturing → review → processing → composed
  ↑                                                              │
  └──────────────── reset / retake ◄──── print · share · upload ─┘
```

- `CaptureSession`: multi-shot (1..N frame), countdown per frame, delay antar shot.
- Setiap capture → `Frame { id, blob, exif, ts, shotIndex }`.
- Event bus (`on('frame:captured')`) supaya UI, uploader, dan printer bisa reaktif.

### 3.2 Transport abstraction (mengikuti pola SLR Booth)
```ts
interface CameraTransport {
  readonly kind: 'webcam' | 'usb' | 'network' | 'hdmi';
  list(): Promise<CameraDevice[]>;
  connect(dev: CameraDevice): Promise<void>;
  liveView(): ReadableStream<VideoFrame>;   // preview stream
  capture(opts: CaptureOptions): Promise<Frame>;
  disconnect(): Promise<void>;
}
```
Implementasi awal: `WebcamTransport` (getUserMedia) + `FakeTransport` (test/CI).
Fase lanjut: `HdmiTransport` (capture card via getUserMedia), `WebUsbPtpTransport` (DSLR — paling berat), `PtpIpTransport`.

### 3.3 Filter pipeline
Urutan tetap, tiap stage opsional:
```
raw → [greenScreen] → [adjustments] → [faceEnhance] → [aiStyle] → [vignette] → composed
```
Semua stage menerima/melepas `ImageBitmap`/`OffscreenCanvas`, dijalankan di **Worker** biar UI tidak nge-freeze. WebGL/WebGPU untuk yang realtime (chroma key), ONNX untuk yang berat (matting, face).

### 3.4 Template engine
Template = **JSON murni** (bukan gambar) — persis pola `meta.template` SLR Booth:
```ts
type Template = {
  size: { width: number; height: number; name: string };
  background: { type: 'color'|'image'; value: string; hasVignette: boolean };
  frames: { x,y,width,height,borderThickness,borderColor,hasShadow,aspectRatio }[];
  textElements: { x,y,width,height,text,fontSize,fontFamily,fill,stroke,strokeWidth,rotation,align }[];
  stickers: { x,y,width,height,src,rotation }[];
};
```
Render pakai **Konva** (sama seperti mereka) → editor drag-drop + export PNG/JPEG.
Token teks: `{event}`, `{date}`, `{time}`, `{custom}` — diganti saat compose.

### 3.5 Layout & print
- Preset kertas: `2x6 strip`, `4x6`, `5x7`, `6x8`, `A4`.
- `renderPrintLayout(template, frames) → HTMLCanvasElement` → DPI-aware (300 dpi).
- Print: `window.print()` via iframe (web) → nanti bridge native untuk silent print.

---

## 4. AI layer (`apps/studio/src/lib/ai`)

**Dua jalur, sengaja** — lokal default (gratis, offline, privat) + cloud opsional (kualitas tinggi, BYOK).

| Tugas | Lokal (default) | Cloud (BYOK) |
|---|---|---|
| Hapus background / green screen | MediaPipe selfie segmenter | — |
| Matting presisi | **BiRefNet-lite** ONNX | — |
| Face enhance | **GFPGAN v1.4** ONNX | — |
| Slow-motion | **RIFE** ONNX (interpolasi frame) | — |
| Style transfer / backdrop / upscale | — | **Gemini** (key user) |

- Runtime: `onnxruntime-web` (WASM SIMD + WebGPU), model di-cache di **IndexedDB/Cache API**.
- Model manifest JSON (versi + hash) di CDN sendiri → update model tanpa redeploy app.
- Cloud call **diproxy lewat API kita** (`/v1/ai/*`) dengan key user di header — supaya bisa rate-limit + audit + tidak expose CORS key.

**Rekomendasi (beda dari mereka):** jangan wajibkan API key. Ship model lokal default supaya app "langsung jalan", cloud jadi upgrade opsional.

---

## 5. Backend API (apps/api)

Fastify + Zod + Drizzle. Semua route di-prefix `/v1`.

```
POST   /v1/auth/otp/request        # kirim kode ke email
POST   /v1/auth/otp/verify         # tukar kode → token (JWT)
GET    /v1/entitlements/me         # status lisensi
POST   /v1/entitlements/verify     # klaim lisensi (email)
POST   /v1/entitlements/confirm
DELETE /v1/entitlements/me         # logout device

POST   /v1/events                  # buat event (nama, tanggal, hashtag)
GET    /v1/events/:id
POST   /v1/galleries               # buat galeri utk event
GET    /v1/galleries/:id
POST   /v1/galleries/:id/photos/upload-url   # presigned S3 (direct upload)
POST   /v1/galleries/:id/photos              # daftarkan foto setelah upload
DELETE /v1/galleries/:id/photos/:photoId
GET    /v1/albums/:hash            # akses publik galeri tamu (opsional password)

POST   /v1/leads                   # simpan lead dari kiosk
GET    /v1/leads/export.csv        # export CSV (auth)
POST   /v1/analytics/events        # ingest event analitik (batch)

GET    /v1/content/{starters,frames,backgrounds,stickers}   # proxy + cache CDN
POST   /v1/orders                  # buat order (Midtrans/Xendit)
POST   /v1/orders/:id/webhook      # webhook payment → aktifkan lisensi

GET    /v1/ai/gemini               # proxy BYOK (stream)
GET    /health
```

**Halaman galeri tamu (HTML, bukan app terpisah)** — di-serve oleh API yang sama:

```
GET  /a/:hash              # halaman galeri tamu (HTML + meta OG)
GET  /a/:hash/og.png       # OG image (di-generate server-side dari 1–4 foto)
GET  /a/:hash/zip          # unduh semua foto
```

**Upload flow (sama seperti mereka, dan memang paling benar):**
1. App minta `upload-url` → API kasih **presigned PUT** ke S3.
2. App upload **langsung ke S3** (tidak lewat API) → progress bar.
3. App lapor `photoId` → API simpan metadata di Postgres.

Alasan: foto bisa 5–15 MB; lewat API = boros bandwidth + timeout.

---

## 6. Data model (Postgres)

```
users            (id, email, name, created_at)
devices          (id, user_id, name, platform, last_seen)
licenses         (id, user_id, sku, status, activated_at, order_id)
orders           (id, user_id, sku, amount, currency, provider, provider_ref, status)
events           (id, user_id, name, event_date, hashtag, created_at)
templates        (id, owner_id, name, json, thumbnail_url, is_starter, created_at)
albums           (id, event_id, hash, password_hash, ttl_days, expires_at, branding_json)
photos           (id, album_id, storage_key, thumb_key, width, height, mime, size, shot_index, created_at)
sessions         (id, album_id, guest_label, started_at)          # 1 sesi tamu
leads            (id, event_id, data_json, consent, created_at)
analytics_events (id, event_id, type, payload_json, created_at)
content_categories (id, kind, name, sort)
content_items    (id, category_id, name, url, thumbnail_url, width, height, meta_json)
print_jobs       (id, event_id, photo_id, paper_size, copies, status, error, created_at)
```

Indeks penting: `albums.hash` (unik), `photos.album_id`, `analytics_events(event_id, type)`, `leads.event_id`.
Retensi: job harian hapus `photos` + S3 object yang `expires_at < now()` (TTL 30 hari).

---

## 7. Offline-first (properti inti, bukan fitur tambahan)

**Aturan besi: jaringan itu opsional.** Semua yang dibutuhkan untuk satu sesi foto — capture, template, render, print, kiosk — ada di device. Backend cuma dipakai untuk galeri, lisensi, konten, dan payment.

| Mode | Butuh internet | Yang jalan |
|---|---|---|
| Online | Ya | Semua + galeri/upload realtime |
| **Offline penuh** | **Tidak** | capture · template · render · print · kiosk · QR lokal |
| Hybrid (default) | Opsional | kerja offline → auto-sync saat online |

**Cara bangunnya:**
- **Service worker** — cache app shell + aset + font + model AI (Cache API) → app kebuka & jalan walau nol koneksi. Versi baru pakai pola `stale-while-revalidate` + prompt "update tersedia".
- **IndexedDB** (via `idb`) untuk foto, template, setting, dan **antrian upload**. **OPFS** (`navigator.storage.getDirectory()`) untuk blob besar (video/PNG 300 dpi) supaya nggak numpuk di memori.
- **Storage location picker** (File System Access API di Chromium) → operator bisa arahkan ke disk eksternal (fitur "storage location" mereka).
- **Status per foto:** `local-only → queued → uploading → uploaded → failed` + badge di UI + tombol retry.
- **Sync engine:** antrian persisten di IndexedDB, jalan di **Background Sync** kalau didukung, fallback polling `navigator.onLine`. Begitu online → upload otomatis tanpa aksi user.
- **Indikator status** online/offline selalu terlihat; kalau offline, UI bilang apa yang *masih* bisa dilakukan (semua), bukan error.
- **Kiosk full-offline:** satu device tanpa koneksi sama sekali tetap bisa sesi penuh + print; QR diarahkan ke galeri lokal kalau ada, atau di-queue untuk dibagikan setelah online.

Konsekuensi arsitektur: studio app **tidak boleh** bergantung pada API untuk render/capture. Endpoint `/v1/*` selalu punya jalur fallback lokal, dan app start tanpa `await` ke jaringan.

---

## 8. Kiosk mode

- **Fullscreen API** + sembunyikan semua navigasi.
- **Idle timeout** → auto reset ke layar awal (configurable, mis. 60 s).
- **PIN lock** untuk keluar (hash PIN di lokal).
- Tombol yang tampil: gallery / print / share (bisa di-toggle).
- `preventDefault` untuk gesture yang tidak diinginkan (zoom, context menu, swipe-back).
- Wake lock (`navigator.wakeLock`) biar layar tidak tidur.

---

## 9. i18n

- `i18next` + `react-i18next`, locale di `apps/studio/src/locales/*.json` (diangkat ke `packages/i18n` kalau ada app kedua).
- Mulai **id + en**; struktur siap untuk 19 bahasa seperti mereka.
- Format tanggal & angka pakai `Intl`.
- Locale marketing ditunda bersama app marketing-nya. Kalau nanti dibuat, pakai routing `/[locale]/...` + `hreflang`.

---

## 10. Fase pengerjaan (MVP → lengkap)

| Fase | Isi | Hasil |
|---|---|---|
| **0** | Scaffold monorepo ramping (pnpm workspace, `shared`), tsconfig, eslint, CI, **service worker + offline shell (PWA)** | `pnpm dev` jalan; app kebuka & jalan tanpa internet |
| **1** | Webcam capture + countdown + multi-shot + review/retake, **indikator online/offline** | Bisa foto dari webcam, termasuk saat offline |
| **2** | Template engine + editor Konva + render strip | Bisa bikin & simpan template |
| **3** | Print layout + print browser + download PNG/JPEG | Foto fisik + file |
| **4** | Kiosk mode + PIN + idle reset + fullscreen | Bisa unattended |
| **5** | Galeri: upload S3 + halaman tamu + QR + TTL | Tamu bisa ambil foto |
| **6** | Green screen (MediaPipe) + adjustments + face enhance (GFPGAN) | Kualitas pro |
| **7** | Video + slow-mo (WebCodecs + RIFE) | Video booth |
| **8** | AI style/backdrop/upscale (Gemini BYOK, diproxy) | Fitur headline |
| **9** | Leads + analytics + branding/white-label | Sisi bisnis |
| **10** | Lisensi + payment (Midtrans/Xendit) + akun | Bisa dijual |
| **11** | Desktop (Electron) + mobile (Capacitor) | Multi-platform |
| **12** | DSLR WebUSB/PTP | Paritas penuh |

**MVP yang bisa dipakai orang = Fase 0–5** (Fase 0 sudah termasuk offline shell). Fase 6–8 yang bikin "wah".

> Rincian fitur per status (MVP / Post / Skip) + kriteria terima + checklist QA ada di **`FEATURE-MATRIX.md`**. Fase di tabel bawah merujuk ke sana.
>
> **Cara kerja per fase (checklist, perintah validasi, gate keluar, bukti) ada di `PHASES.md`.** Aturannya: selesai ngerjain → validasi dulu → baru centang; mau pindah fase → cek gate fase sebelumnya.

---

## 11. Rekomendasi fitur (tambahan / pembeda)

Wajib-sama (paritas): semua di §4 RESEARCH.md.

**Tambahan yang gw sarankan:**

1. **Share WhatsApp** — mereka cuma SMS/email. Di Indonesia WhatsApp = default. Pakai deep link `wa.me` + fallback upload.
2. **QRIS via Midtrans/Xendit** — pembayaran lokal; mereka cuma Shopify (kartu).
3. **AI lokal default (tanpa API key)** — mereka wajib BYOK Gemini; kita ship model lokal biar langsung jalan, cloud jadi opsional.
4. **Green screen realtime pakai selfie segmenter** — tanpa perlu layar hijau fisik untuk kasus umum.
5. **Remote monitoring realtime** (WebSocket) — operator lihat counter foto, status printer, sisa storage dari HP.
6. **Phone-as-camera (WebRTC)** — HP jadi kamera kedua; berguna kalau DSLR belum didukung.
7. **Template marketplace** — user jual template sendiri, kita ambil rev-share. Mesin pertumbuhan.
8. **Print queue + retry + reprint** — printer macet itu kejadian nyata di lapangan.
9. **Consent + UU PDP** untuk lead capture — checkbox consent + kebijakan retensi; wajib secara legal di ID.
10. **Analytics dashboard per event** — jumlah sesi, foto, lead, conversion; nilai jual ke klien korporat.
11. **Branded share page + OG image** — biar link galeri cantik waktu di-share.
12. **PWA installable** — "install" tanpa app store.
13. **Multi-event mode** — satu device, banyak event, data terpisah.
14. **Reseller / white-label tier** — jual ke vendor booth, bukan cuma end user.
15. **Export template + starter packs** — bikin komunitas bikin konten.

**Anti-fitur (sengaja JANGAN):** langganan bulanan, kredit AI bermeter, watermark paksa di hasil, **wajib online untuk jalan** (aplikasi harus tetap jalan tanpa internet).

---

## 12. Yang perlu diputuskan sebelum ngoding

1. **Kamera dulu:** webcam + HDMI capture card, atau langsung kejar DSLR (WebUSB/PTP)? → saran: webcam dulu.
2. **Hosting AI lokal:** model (BiRefNet ~50 MB, GFPGAN ~300 MB) di-serve dari mana? CDN sendiri atau bundle?
3. **Payment:** Midtrans (QRIS + VA, lokal) vs Xendit vs Shopify (internasional)?
4. **Nama & brand** project (jangan pakai "SLR Booth").
5. **Lisensi harga:** ikut $99 sekali bayar, atau model lain (per-event / freemium)?
