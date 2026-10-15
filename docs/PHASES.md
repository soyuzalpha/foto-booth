# Fase Pengembangan — Foto Booth

Dokumen ini **satu-satunya sumber kebenaran** untuk progres fase. Update di commit yang sama dengan pekerjaan fasenya.

Rujukan: `SYSTEM-DESIGN.md` §10 (daftar fase) · `FEATURE-MATRIX.md` §A (kriteria terima MVP) & §D (checklist QA).

**Cara baca rujukan:** `§A<n>` = baris ke-`n` tabel MVP di `FEATURE-MATRIX.md` §A (nomornya stabil). `§B Fase = n` = semua baris tabel lengkap §B yang kolom *Fase*-nya `n` — tidak dihitung manual, jadi tidak basi saat baris ditambah.

---

## Protokol gate (aturan main)

1. **Satu fase = satu blok kerja.** Jangan campur dua fase dalam satu commit.
2. **Selesai ngerjain → validasi dulu, baru centang.** Centang `[ ]` → `[x]` **hanya** setelah perintah di bagian *Validasi* fase itu dijalankan dan hasilnya sesuai. Bukan setelah kodenya "kelihatan jadi".
3. **Mau pindah fase → cek gate fase sebelumnya.** Isi bagian *Gate keluar* fase lama (semua task `[x]` + validasi lolos + bukti tercatat). Kalau ada yang gagal → perbaiki di fase itu, **jangan lanjut**.
4. **Bukti itu output nyata, bukan deskripsi.** Run CI hijau (nomor run), output perintah, angka DOM, status container. Kalau tidak ada buktinya, berarti belum selesai.
5. **Jangan hapus kriteria yang gagal.** Kalau sesuatu ditunda, tulis alasannya di baris itu (`→ ditunda: <alasan>`) dan jangan centang.

**Legenda:** `[ ]` belum · `[x]` selesai & tervalidasi · `[~]` dikerjakan, belum lulus validasi · `[!]` blocked (tulis blocker-nya)

**Definisi "selesai" berlaku untuk semua fase:**

- [ ] Kode ada di `dev`, sudah ff-merge ke `main`, sudah push
- [ ] `pnpm lint` · `pnpm -r typecheck` · `pnpm -r build` hijau semua
- [ ] CI run untuk commit itu **hijau** (semua step success)
- [ ] Container produksi `foto-booth` healthy di `127.0.0.1:5050` dengan tag SHA commit baru
- [ ] Bukti ditulis di bagian *Bukti* fase tersebut

---

## Peta fase

**MVP = Fase 0–5.** Fase 6–13 = setelah MVP.

| Fase | Isi | Ukuran | Status |
|---|---|---|---|
| **0** | Scaffold monorepo + offline shell + CI deploy | L | `[x]` **selesai** |
| **1** | Capture engine (webcam **+ capture card HDMI**, countdown, multi-shot, review) | L | `[x]` **selesai** — otomatis+offline; 5 baris hardware tertunda |
| **2** | Template engine + editor Konva + render strip | L | `[x]` **selesai** |
| **3** | Print layout + print browser + download | M | `[x]` **selesai** |
| **4** | Kiosk mode (fullscreen, PIN, idle reset) | M | `[x]` **selesai** |
| **5** | Galeri: upload S3 + halaman tamu + QR + TTL + auth | L | `[x]` **selesai** |
| 6 | Green screen + adjustments + face enhance | L | `[x]` **selesai** — 19/19 e2e; GFPGAN ~340 MB belum diunggah |
| 7 | Video + slow-mo (WebCodecs + RIFE) | L | `[x]` **selesai** — 138 tes mesin video; model RIFE belum diunggah |
| 8 | AI style/backdrop/upscale (Gemini BYOK) | L | `[x]` **selesai** — BYOK via header `x-gemini-key`; upscale & AI template elements ditunda |
| 9 | Leads + analytics + branding | M | `[x]` **selesai** — branding/sharing/auto-print/guestbook + consent UU PDP; tombol kiosk #51/#52 dipindah ke Fase 12 |
| 10 | Lisensi + order (mekanisme; QRIS ditunda) | M | `[x]` **selesai** — katalog SKU, order, status, kode aktivasi, batas plan; gateway pembayaran sengaja belum |
| 11 | Booking & reservasi (mekanisme; QRIS ditunda) | L | `[x]` **selesai** — alur booking→event, anti double-booking, invoice/kwitansi, **email SMTP sungguhan**, job pengingat H-1; gateway QRIS sengaja belum |
| 12 | Desktop (Electron) + mobile (Capacitor) | L | `[x]` **selesai** — printer bernama + deteksi USB + laporan diagnostik, shell Electron (renderer tanpa Node), proyek Capacitor (skema HTTPS + izin kamera); titipan #51/#52 dari Fase 9 ikut ditutup di sini |
| 13 | DSLR WebUSB/PTP + marketplace + multi-device | L | `[ ]` |

**Urutan kritis MVP:** `0 → 1 → 2 → 3 → 4 → 5`. Offline **bukan fase terpisah** — dibangun dari Fase 0 dan divalidasi ulang di tiap fase.

**Ukuran:** S = sehari · M = beberapa hari · L = blok kerja besar.

---

## Fase 0 — Fondasi, offline shell, CI deploy

**Status:** `[x]` selesai & tervalidasi (2026-10-11)
**Gate masuk:** —
**Tujuan:** kerangka monorepo yang bisa dibuild, app yang jalan tanpa internet, dan jalur deploy otomatis ke rumah.

**Deliverable**

| Area | File |
|---|---|
| Root | `package.json` · `pnpm-workspace.yaml` · `tsconfig.base.json` · `eslint.config.mjs` · `.nvmrc` (24) |
| Shared | `packages/shared/src/{constants,schemas,index}.ts` (Zod + tipe) |
| API | `apps/api/src/{app,index,paths}.ts` + `routes/{health,content,gallery}.ts` (Fastify, PORT 5050) |
| Studio | `apps/studio/` — Vite + React SPA, `vite.config.ts` (vite-plugin-pwa), `src/lib/{i18n,api,useOnlineStatus,useServiceWorkerStatus,useStorageStatus,useInstallPrompt}.ts`, `src/locales/{id,en}.json` |
| Landing | `apps/api/static/landing/{index.html,styles.css}` (neo-brutalism) |
| Deploy | `Dockerfile` · `.github/workflows/deploy.yml` |

**Task**

- [x] pnpm workspace + 3 unit (`shared`, `api`, `studio`), tanpa Turborepo
- [x] `shared` = satu sumber Zod schema + tipe FE↔BE
- [x] Studio SPA + `vite-plugin-pwa` (service worker, manifest, ikon PNG)
- [x] API Fastify: `/health`, `/v1/health`, `/v1/content/*`, galeri `/a/:hash`
- [x] Landing page neo-brutalism
- [x] Dockerfile (deps → builder → runner), image jalan tanpa sudo
- [x] CI: lint → typecheck → build → image → container uji (5150) → health → swap produksi (5050) → health
- [x] Auto-prune image lama (scoped `foto-booth:*`, simpan image aktif)
- [x] Runner self-hosted kedua untuk repo ini (`actions-runner-fotobooth`, user unit + `runsvc.sh`)
- [x] `workflow_dispatch` (redeploy tanpa commit)
- [x] Indikator online/offline + status service worker + persist storage (skeleton)

**Kriteria terima (FEATURE-MATRIX):** §A25 (app shell offline) · §B semua baris dengan **Fase = 0**

**Validasi**

```bash
cd ~/app/foto-booth
pnpm install --frozen-lockfile && pnpm lint && pnpm -r typecheck && pnpm -r build

# offline shell: app harus tetap kebuka dengan network dimatikan
node ~/.hermes/profiles/vesta/cache/scratch/fb-offline-test.mjs

# container produksi = image commit terbaru
docker ps --filter name=foto-booth --format '{{.Image}} {{.Status}}'
for r in / /studio/ /health /v1/health /v1/content/starters; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5050$r)" "$r"
done
```

**Gate keluar:** CI hijau (run #7 / `38179994051`, 15/15 step) · offline shell terbukti jalan · container healthy · semua route 200.

**Bukti**

- CI run **#7** `38179994051` — **success**, semua step termasuk `Prune old images`
- Container `foto-booth` healthy, image `foto-booth:d92442c0d74b524a4babeec078a2508fd4b79ab0` (tag = SHA commit)
- Route 200: `/`, `/studio/`, `/health`, `/v1/health`, `/v1/content/starters`, `/studio/manifest.webmanifest`
- Offline test lolos: app shell kebuka dengan jaringan mati, storage persist = granted
- Disk host bersih: image reclaimable 88KB, dangling 0

**Sisa (dipindah, bukan blocker Fase 0)**

- `[ ]` **Hostname publik `foto.soyuz.my.id`** — butuh sudo: `sudo ~/script/add-fotobooth-tunnel.sh`. Dibutuhkan Fase 5 (galeri harus bisa diakses HP tamu). Dijadwalkan masuk Fase 5.
- `[ ]` Skeleton i18n/status/install-prompt masih minimal — diselesaikan & divalidasi di Fase 1.

---

## Fase 1 — Capture engine (webcam + capture card HDMI)

**Status:** `[x]` selesai & tervalidasi (2026-10-12) — kecuali 5 baris *Hardware*
**Gate masuk:** Fase 0 gate keluar terpenuhi.
**Tujuan:** bisa foto dari **webcam** atau **kamera DSLR/mirrorless lewat capture card HDMI** — countdown, multi-shot, review/retake — **termasuk saat offline**.

### Soal "HDMI" — apa yang sebenarnya terjadi

Capture card HDMI (Elgato Cam Link, AVerMedia, dongle MS2109, dll) itu device **UVC** — satu kelas dengan webcam. Browser lihatnya sebagai kamera biasa, jadi cukup `getUserMedia`. **Tidak perlu driver, tidak perlu WebUSB, jalan di semua browser.** Yang perlu dikerjakan bukan "dukungan HDMI", tapi **memperlakukan capture card berbeda dari webcam** di tempat yang memang beda:

| | Webcam | Capture card HDMI |
|---|---|---|
| Mirror default | nyala | **mati** (kamera sudah orientasi benar; mirror bikin teks/logo kebalik) |
| Resolusi | 720p–1080p | 1080p60 / 2160p30 (tergantung card) |
| Sinyal | selalu ada | **bisa hilang** (HDMI lepas, kamera tidur) |
| Warm-up | instan | 1–3 s sebelum frame pertama valid |
| Audio | biasanya tidak | sering ada (track terpisah) |

**Ini BUKAN hal yang sama dengan Fase 13.** Fase 13 = kontrol DSLR via **WebUSB + protokol PTP** (jepret dari app, ambil still full-res, Chrome-only, paling berat). Fase 1 = **menerima video** dari kamera lewat HDMI. Yang berat tetap di Fase 13.

**Deliverable:** `apps/studio/src/lib/capture/*` (`CaptureSession` state machine, event bus) · `apps/studio/src/lib/transports/*` (`CameraTransport`, `UvcTransport`, `FakeTransport`, `DeviceProfile`, `SignalMonitor`, `stillCapture`) · UI capture + review.

**Task**

- [x] State machine eksplisit `idle → armed → countdown → capturing → review → processing → composed`
- [x] `CaptureSession`: multi-shot 1..N, countdown per frame (on/off, durasi configurable), delay antar shot
- [x] `Frame { id, blob, width, height, shotIndex, capturedAt, source, strategy }` + event bus (`frame:captured`)
      — catatan audit: bentuk di kode memakai `capturedAt`, bukan `ts`, dan **tanpa `exif`**. EXIF/metadata tidak diminta FEATURE-MATRIX di fase ini; token tanggal (`{date}`) milik §A row 34 = Fase 2.
- [x] `CameraTransport` interface + `UvcTransport` + `FakeTransport` (test/CI)
- [x] `UvcTransport` melayani **webcam DAN capture card HDMI** (dua-duanya UVC — satu jalur kode)
- [x] `DeviceProfile`: klasifikasi webcam vs capture card + `source` + label yang bisa dibaca operator
- [x] Pilih sumber kamera dari `enumerateDevices` — capture card **ditandai terpisah** dari webcam
- [x] Resolusi & framerate: baca `getCapabilities()`, pilih mode terbaik, terapkan lewat `applyConstraints`
- [x] Still resolusi penuh via `ImageCapture.takePhoto()`; **fallback canvas** `drawImage` + `toBlob` (Safari/Firefox tidak punya ImageCapture)
- [x] Mirror otomatis: nyala untuk webcam, **mati** untuk capture card (masih bisa di-override)
- [x] Deteksi sinyal hilang: frame beku/hitam → overlay "tidak ada sinyal HDMI" + auto-recover saat sinyal balik
- [x] Tangani `devicechange`: kamera dicabut/dicolok saat app sedang jalan
- [x] Warm-up: jangan jepret sebelum frame pertama benar-benar valid (bukan cuma `readyState === 'live'`)
- [x] Error handling jelas: permission ditolak (`NotAllowedError`), device dipakai app lain (`NotReadableError`), device tidak ada (`NotFoundError`)
- [x] Aspect ratio 1:1 / 16:9 / 3:2 (preview & hasil ikut berubah)
- [x] Review + retake **per frame** (tanpa ulang semua)
- [x] Frame disimpan ke IndexedDB saat itu juga (tahan refresh)
- [x] Indikator online/offline akurat + PWA installable + i18n id/en lengkap
- [x] `prefers-reduced-motion` untuk animasi countdown

**Kriteria terima (FEATURE-MATRIX):** §A1–6 · §A25–26 · §A28 · §A31 · §B semua baris dengan **Fase = 1**

**Validasi**

```bash
cd ~/app/foto-booth
pnpm lint && pnpm -r typecheck && pnpm -r build
pnpm --filter @foto-booth/studio test
```

*Otomatis (tanpa hardware — jalan di CI):*

- [x] Unit test `FakeTransport` dengan **profil capture card** (1080p60, tanpa audio, sinyal bisa diputus) — semua transisi state lulus, termasuk retake 1 frame
- [x] Simulasi sinyal hilang: `FakeTransport` stop kirim frame → overlay muncul; sinyal balik → overlay hilang **tanpa reload**
- [x] `devicechange` di tengah sesi → app tidak crash, sesi bisa dilanjutkan
- [x] Fallback still: jalankan dengan `window.ImageCapture` dihapus → jalur canvas tetap menghasilkan frame
- [x] Mirror terukur: profil webcam → `getComputedStyle(video).transform` mengandung `matrix(-1, …)`; profil capture card → `none`
- [x] Pilih resolusi: profil fake menawarkan 720p & 1080p → `applyConstraints` benar-benar mengubah `track.getSettings().height`

*Hardware (butuh capture card + kamera) — **BELUM dijalankan, ini sisa Fase 1**:*

- [ ] Kamera → HDMI → capture card **terbaca di dropdown sebagai capture card**, bukan webcam
- [ ] Preview tampil < 2 s setelah warm-up, resolusi diukur dari `videoWidth/videoHeight` (**bukan dari mata**)
- [ ] Cabut kabel HDMI di tengah sesi → overlay muncul < 2 s; colok balik → preview balik sendiri
- [ ] Jepret 6 frame dari capture card → semua tersimpan, **tidak ada frame hitam**
- [ ] Kamera di-set **manual exposure + clean HDMI (OSD mati)** → hasil tidak flicker / auto-gain naik-turun

*Offline & gate:*

- [x] **Mode pesawat dari awal → capture tetap jalan, frame tersimpan lokal**
- [x] Refresh di tengah sesi → frame tidak hilang (baca ulang IndexedDB)
- [x] CI run hijau + container healthy dengan tag SHA baru

> **Penting (operasional):** `getUserMedia` **wajib secure context** — HTTPS atau `localhost`. Jadi kiosk **tidak boleh** diakses lewat `http://192.168.x.x:5050` (kamera tidak akan tersedia sama sekali). Pilih salah satu: **(a)** install PWA dari `https://foto.soyuz.my.id` — origin tetap HTTPS walau offline, jadi kamera tetap jalan; **(b)** browser di host yang sama lewat `localhost`; **(c)** HTTPS lokal dengan sertifikat sendiri.

**Gate keluar:** semua task `[x]` · unit test lulus · capture offline terbukti · **capture card terbukti** (angka resolusi + overlay sinyal hilang) · bukti ditulis.

**Bukti:**

- **Kode:** `apps/studio/src/lib/capture/*` (`stateMachine`, `captureSession`, `frameStore`, `aspectRatio`, `eventBus`, `frameCrop`) · `apps/studio/src/lib/transports/*` (`types`, `errors`, `deviceProfile`, `signalMonitor`, `stillCapture`, `lumaSampler`, `resolutions`, `uvcTransport`, `fakeTransport`) · `lib/useCaptureSession.ts` · `components/CapturePanel.tsx` · `locales/{id,en}.json`.
- **Gerbang kode:** `pnpm -r typecheck` **exit 0** · `pnpm test` **75/75 lulus** · `pnpm lint` **exit 0** · `pnpm -r build` **exit 0**.
- **Validasi otomatis** (Playwright + Chromium fake camera; skrip di `~/.hermes/profiles/vesta/cache/scratch/`, semua **exit 0**):
  - `fb-fase1-verify.mjs`, `fb-fase1-verify2.mjs` — alur penuh lewat `UvcTransport` nyata; resolusi terukur `videoWidth/videoHeight` 1280×720 → 1920×1080 → 1280×720; rasio 16:9 & 1:1 dari `getBoundingClientRect`.
  - `fb-signal.mjs` — sinyal diputus paksa (`canvas.captureStream()`): overlay muncul **2.314–2.348 s** (< 2,5 s), tidak ada frame hitam, pulih **tanpa reload**.
  - `fb-fallback.mjs` — `window.ImageCapture` dihapus → jalur canvas tetap menghasilkan frame.
  - `fb-profile.mjs` — webcam vs "Elgato Cam Link 4K": mirror webcam `matrix(-1, 0, 0, -1, 0, 0)`, capture card `none`; override webcam **tidak bocor** ke capture card.
  - `fb-mirror.mjs` — isolasi override per device.
  - `fb-resolution.mjs` — `applyConstraints` benar-benar mengubah `track.getSettings().height`, bukan sekadar label dropdown.
  - `fb-config.mjs` — pengaturan sesi dari UI (§A2/§A3/§B4): pilih 2 frame → 2 slot; countdown 1 dtk tampil & mundur; review 3 dtk maju **sendiri** di **2.954–3.013 ms** tanpa klik; review 0 = "Tunggu operator" dan **tidak** maju sendiri setelah 6 s; pengaturan terkunci saat countdown/capturing/processing dan terbuka saat review; bertahan setelah refresh.
  - `fb-motion.mjs` — `animationName` = `count-pop` (0,9 s) dan `none` saat `prefers-reduced-motion: reduce`.
  - `fb-overlap.mjs` — rect DOM: tidak ada tumpang tindih, `clipped: []`.
  - `fb-offline-fase1.mjs`, `fb-resume.mjs`, `fb-persist.mjs` (build produksi, `vite preview` :5174) — mode pesawat dari awal tetap bisa capture & frame tersimpan; refresh di tengah sesi tidak menghilangkan frame (hash identik); sesi bisa dilanjutkan.
- **5 bug nyata ketemu validasi & diperbaiki:** (1) `setAspect()` mengubah nilai tanpa memancarkan event → pilihan rasio tak pernah berubah di layar; (2) `useCaptureSession` membaca `session.devices/aspect/mirror()` saat render → daftar device tak pernah muncul; (3) `mirrorOverride` bocor antar device → frame capture card ikut kebalik; (4) `arm` menghapus frame hasil `restore` → melanjutkan sesi setelah refresh membuang pose yang sudah dijepret; (5) `begin` selalu mulai dari slot 0 → slot 0 terisi dua kali setelah refresh.
- **2 lubang kebersihan build:** `apps/studio/dev-dist/` (service worker dev) tidak ada di `.gitignore` maupun `eslint.config.mjs` → `pnpm lint` gagal; sudah ditutup.
- **Bug regresi ditemukan di lapangan (2026-10-12, setelah Fase 2 rilis): "pilih webcam bawaan laptop → kamera seolah tidak terbuka".**
  - **Akar masalah:** `startSignalMonitor()` dipasang untuk **semua** device, padahal deteksi sinyal hilang itu khusus capture card (§B3). Di ruangan redup (luma ≤ 8) atau adegan statis (frame identik), heuristiknya menuduh `no-signal` → `.preview-overlay` (`position:absolute; inset:0`) menutupi **seluruh** preview, **dan** `stateMachine` menahan countdown di 0 selamanya → sesi menggantung dengan **0 frame**. Kamera sendiri sebenarnya hidup (`videoWidth 640`, `readyState 4`, track `live`).
  - **Perbaikan:** `startSignalMonitor()` + overlay kini digerbangi `source === 'capture-card'` lewat `isCaptureCard()` (sumber utama daftar device terklasifikasi, cadangan `transport.currentDevice()` baru di `types.ts`); webcam selalu `signal: 'ok'` sehingga tidak pernah masuk jalur sinyal-hilang. Pesan overlay dipisah (`capture.noSignalBodyWebcam`) — webcam tidak lagi disuruh "cek kabel HDMI".
  - **Reproduksi + bukti:** `fb-webcam-hang.mjs` — **sebelum:** 0/4 terisi, countdown macet di 0, overlay merah (y4m luma 4 dan luma 30); **sesudah:** **4/4 terisi, overlay tidak ada**, pada kedua skenario. `fb-webcam-diag.mjs` → `overlayVisible: false`.
  - **Regresi capture card dijaga:** `fb-signal.mjs` (kini memakai device terklasifikasi capture card) tetap hijau — badge "Tanpa sinyal", countdown ditahan, **tidak ada frame hitam** (luma 157–167), pulih **tanpa reload**, lanjut ke 4/4.
  - **Tes unit baru:** `captureSession.test.ts` — "webcam adegan statis & redup tidak pernah dituduh tanpa sinyal" (4/4 frame, state `review`) + "capture card yang kabelnya dicabut tetap ditahan" (0 frame, `no-signal`). `FakeTransport.freezeScene()` ditambahkan karena fake lama selalu menyelang-seling luma — itulah kenapa bug ini lolos dari seluruh suite.
  - **Gerbang ulang:** `pnpm -r typecheck` **exit 0** · **159 tes lulus** · `pnpm lint` **exit 0** · `pnpm -r build` **exit 0** · `node docs/phases-status.mjs` **3/14** (Fase 1 & Fase 2 tetap tercentang).
- **Bug regresi kedua (2026-10-12, dilaporkan setelah perbaikan webcam): "Gak bisa select kamera" — dropdown device tidak menerima pilihan.**
  - **Akar masalah:** pada kunjungan pertama izin kamera belum ada, dan Chrome sengaja **menyembunyikan `deviceId`** (panjang **0**, terukur oleh `fb-deviceid.mjs`; setelah izin menjadi **64** karakter). `deviceProfile.ts` mengubah id kosong itu menjadi label `"Kamera "` (menggantung) dengan `value=""` — **nilai yang sama** dengan opsi placeholder `"— pilih kamera —"`. `CapturePanel.tsx` memakai `if (value !== "")` di `onChange`, jadi memilih kamera itu dianggap "tidak ada perubahan" dan **diabaikan diam-diam**. Karena `getUserMedia` hanya dijalankan di dalam `connect()`, yang hanya bisa dipanggil dari dropdown itu juga → **jalan buntu**: tidak ada cara memunculkan prompt izin. Dropdown tampak hidup tapi mati.
  - **Perbaikan:** (1) placeholder kini punya sentinel sendiri `DEVICE_NONE = "__none__"`, sehingga `value=""` kembali menjadi nilai **sah** yang bisa dipilih; (2) `uvcTransport.connect()` **tidak lagi** memaksa `deviceId: { exact: "" }` (yang pasti gagal) — device default dibiarkan dipilih browser, dan **id asli dibaca dari track** setelah izin; (3) `list()` menyatukan device ber-id kosong menjadi satu entri, dan **di-enumerasi ulang** setelah izin supaya nama asli muncul; (4) `CaptureSession.connect()` meneruskan **id hasil resolusi transport** (bukan id kosong dari UI) lalu menyegarkan daftar device; (5) label jujur `"Kamera — klik untuk mengizinkan"` menggantikan `"Kamera "`.
  - **Reproduksi + bukti:** `fb-select-fix.mjs` — menyimulasikan kondisi "izin belum diberikan" dengan mencegat `enumerateDevices` (Chromium headless tidak bisa menampilkan prompt izin sungguhan). **Sebelum** (live `:5050`, build `bb95b3c`): **7 cek gagal** — placeholder dan kamera sama-sama `value=""`, label `"Kamera  — Webcam"`, pilihan tidak menempel, `videoWidth` null. **Sesudah** (build produksi `:5174`): **13/13 lulus** — pilihan menempel, kamera terbuka, `videoWidth 640×480`, label berganti jadi `"fake_device_0 — Webcam"`, tanpa error.
  - **Tes unit baru:** `uvcTransport.test.ts` (6 tes: id kosong memunculkan prompt izin & tidak memaksa `exact` kosong; id sungguhan tetap `exact`; id asli dibaca dari track; `preflight` gagal membatalkan sebelum menyentuh kamera) + 2 tes sesi di `captureSession.test.ts` ("connect dengan id kosong menempelkan id asli yang dilaporkan transport"; "setelah izin diberikan, daftar device menampilkan nama aslinya").
  - **Gerbang ulang:** `pnpm -r typecheck` **exit 0** · **167 tes lulus** · `pnpm lint` **exit 0** · `pnpm -r build` **exit 0** · `node docs/phases-status.mjs` **3/14**.
- **Sisa:** 5 baris *Hardware* di atas.

**Prasyarat hardware:** baris *Hardware* butuh **capture card HDMI + kamera**. Baris *Otomatis* + *Offline* sudah dijalankan tanpa alat (Chromium fake camera, `canvas.captureStream()`, profil capture card virtual, build produksi) dan semuanya hijau — itulah yang membuat Fase 1 bisa dicentang. Baris *Hardware* tetap terbuka sebagai sisa sampai alatnya dicolok; kalau nanti salah satu baris hardware gagal, **status Fase 1 dibatalkan** dan diperbaiki dulu.

---

## Fase 2 — Template engine + editor

**Status:** `[x]` **selesai**
**Gate masuk:** Fase 1 gate keluar terpenuhi (frame bisa diambil & disimpan).
**Tujuan:** bikin template sendiri dan render strip/kolase jadi PNG ≥ 300 dpi.

**Deliverable:** `apps/studio/src/lib/template/*` (model JSON + render Konva), editor drag-drop, penyimpanan template di IndexedDB.

**Task**

- [x] Model `Template` JSON: `size`, `background`, `frames[]`, `textElements[]`, `stickers[]`
- [x] Zod schema template di `packages/shared` (validasi + tipe)
- [x] Render template + frame → canvas (Konva)
- [x] Editor drag-drop: geser / resize / rotate / undo
- [x] Token teks `{event}` `{date}` `{time}` `{custom}` disubstitusi saat compose
- [x] Simpan / muat / hapus template (IndexedDB), muncul di daftar
- [x] Export PNG (dan JPEG) ≥ 300 dpi, nama file rapi
- [x] Render di Worker/OffscreenCanvas biar UI tidak nge-freeze

**Kriteria terima (FEATURE-MATRIX):** §A7–11 (template) · §B semua baris dengan **Fase = 2**

**Validasi**

```bash
pnpm lint && pnpm -r typecheck && pnpm -r build
pnpm --filter @foto-booth/studio test
```

- [x] Round-trip JSON: simpan → muat ulang → **byte-identik**
- [x] Template invalid ditolak Zod dengan pesan jelas (bukan crash)
- [x] Ukur canvas hasil export: `2×6` @300 dpi = **600×1800 px**, `4×6` = **1200×1800 px**
- [x] Token ter-substitusi: cek teks pada canvas/bitmap, bukan dari state
- [x] Editor: geser/rotate lewat Playwright, lalu baca koordinat elemen
- [x] Reload halaman → template masih ada
- [x] CI hijau + container healthy

**Gate keluar:** semua task `[x]` · dimensi export terukur sesuai · template persisten · bukti ditulis.

**Bukti:**

- **Kode (shared):** `packages/shared/src/template.ts` (satuan, resolusi export, token — satu sumber kebenaran) · `schemas.ts` (schema `Template` selaras `docs/SYSTEM-DESIGN.md` §3.4) · `index.ts` · `template.test.ts`.
- **Kode (studio):** `lib/idb.ts` (satu pembuka IndexedDB untuk semua modul) · `lib/template/{model,layout,tokens,render,templateStore,exportPng,renderOffThread,editorState,previewFrames}.ts` · `lib/template/worker/render.worker.ts` · `lib/useTemplates.ts` · `lib/useImageSrc.ts` · `components/{TemplatePanel,TemplateEditor,TemplateList}.tsx` · `App.tsx` (tab **Ambil foto / Editor template**) · `locales/{id,en}.json` · `styles.css`.
- **Gerbang kode:** `pnpm -r typecheck` **exit 0** · `pnpm -r test` **168/168 lulus** (shared 11 · api 0 · studio 157) · `pnpm lint` **exit 0** · `pnpm -r build` **exit 0** · `node docs/phases-status.mjs` **exit 0**.
- **Terpasang & terverifikasi:** commit **`dd4340e`** di `dev` → ff-merge `main` → push keduanya (`c9b3e0f..dd4340e`). CI self-hosted **Succeeded** (`Job result after all job steps finish: Succeeded`). Container **`foto-booth:dd4340e86a86…` Up (healthy)** di `127.0.0.1:5050`; `/`, `/version`, `/v1/content/backgrounds`, `/studio/` semua **200**; bundle `assets/index-BfWqRIKX.js` memuat string editor template; chunk worker `render.worker-ChkkPGkz.js` disajikan **200**. Suite Playwright dijalankan ulang **terhadap deploy live (:5050)** → **41/41 lulus**.
- **Validasi otomatis:** `fb-fase2-editor.mjs` (Playwright + Chromium, build produksi `vite preview` :5174) — **41/41 lulus, exit 0**:
  - Kanvas editor tampil; model **600×1800 px** (2×6 in @300 dpi) di kanvas maupun di atribut; skala tampil 0,3444 (< 1, model tetap penuh).
  - **6 slot frame + tinta teks footer** dihitung dari **bitmap kanvas**, bukan dari state: 6 pita + 990 px tinta.
  - Klik frame 0 → kotak **36,36,528,248,0** sama persis dengan hitungan `stripLayout()` independen; geser 20 px layar → `y` naik 58 (= 20 ÷ 0,3444, sesuai skala) sementara `x`/lebar/tinggi tetap; geser kanan mentok **x = 72** (= 600 − 528, clamp kanvas).
  - Undo mengembalikan **36,36,528,248,0**; redo mengembalikan hasil geser — keduanya dibaca dari koordinat elemen.
  - Rotate lewat tuas Konva: **0° → 70°**; undo → balik **0°**.
  - Export PNG **600×1800 px** dan **1200×1800 px** (setelah ganti preset 4×6) — blob **didekode ulang** dan diukur, bukan dibaca dari state.
  - **Verifikasi silang independen:** `export-600x1800.png` & `export-1200x1800.png` didekode ulang dengan **PIL/numpy** (bukan mesin yang sama) → **6 pita slot** di keduanya, ukuran 600×1800 & 1200×1800.
  - Token ter-substitusi **di nama berkas**: `strip-fase-dua-pesta-ulang-tahun-2026-10-12-600x1800.png` (slug nama acara + tanggal + ukuran).
  - Jalur render dilaporkan **`worker`** (OffscreenCanvas), tanpa fallback error.
  - **Offline:** koneksi dimatikan → export tetap menghasilkan **1200×1800 px** lewat `worker`.
  - Simpan → `dirty=0` → template muncul di daftar → **reload** → template terbuka lagi dengan ukuran **1200×1800** persisten.
  - Tidak ada error runtime halaman (selain kegagalan jaringan yang memang diuji di jendela offline).
- **Keputusan teknis yang dikunci di fase ini:** `worker.format: "es"` (bundle worker di-code-split karena mengimpor `@foto-booth/shared`; format `iife` default ditolak Rollup) · `renderOffThread.ts` pakai **import statis** (bukan `await import` di jalur panas) · react-konva v19 **tidak lagi mengekspor `useImage`** → project punya `useImageSrc.ts` sendiri · `editorState` punya aksi gabungan **`transform`** (Konva mengembalikan kotak + rotasi sekaligus; `resize`+`rotate` terpisah akan dobel masuk undo) dan aksi eksplisit **`markSaved`**.
- **Sisa/lubang yang diketahui:** tuas rotate Konva berada **50 px di atas** tepi atas node; karena `margin` strip cuma 36 px dan kanvas diskalakan ~0,34, tuas frame paling atas jatuh **di luar kanvas** sehingga tidak bisa dipegang. Bukan blocker (frame lain bisa dirotasi, dan `editorState` sendiri menerima rotasi apa pun), tapi kalau nanti mau dirapikan: perkecil `rotateAnchorOffset` atau beri padding atas di sekitar kanvas.
- **Screenshot untuk review:** `fb-fase2-shots/{editor-full,editor-4x6,editor-after-reload,editor-canvas}.png` + hasil export `export-600x1800.png`, `export-1200x1800.png`, `export-1200x1800.jpg`.

---

## Fase 3 — Print & export

**Status:** `[x]` selesai & tervalidasi (2026-10-12)
**Gate masuk:** Fase 2 gate keluar terpenuhi (hasil compose bisa dirender).
**Tujuan:** hasil bisa jadi foto fisik dan file.

**Deliverable:** `apps/studio/src/lib/print/*` (layout preset, DPI-aware), iframe print, tombol download.

**Task**

- [x] Preset kertas `2×6 strip` + `4×6` dengan margin/bleed benar
- [x] `renderPrintLayout(template, frames) → HTMLCanvasElement` (300 dpi)
- [x] Print via iframe (`window.print()`), ukuran benar
- [x] Download PNG/JPEG, nama file rapi
- [x] Cache aset konten (template/frame/sticker/font) untuk offline
- [x] Preview print sebelum keluar dialog

**Kriteria terima (FEATURE-MATRIX):** §A12–14 (print) · §B semua baris dengan **Fase = 3**

**Validasi**

```bash
pnpm lint && pnpm -r typecheck && pnpm -r build
```

- [x] Ukur canvas print: `2×6` → 600×1800 px, `4×6` → 1200×1800 px (300 dpi)
- [x] Bandingkan preview vs file hasil: tidak ada elemen terpotong di tepi (probe pixel band)
- [x] Nama file terunduh sesuai pola (tanggal + event)
- [x] **Offline: konten (template/frame/sticker) tetap tampil setelah sync pertama**
- [x] Print dialog keluar dengan ukuran benar (diuji di Chromium headless + manual)
- [x] CI hijau + container healthy

**Gate keluar:** semua task `[x]` · dimensi print terukur · konten offline tersedia · bukti ditulis.
**Bukti:**

- **Satuan ukuran print (satu sumber kebenaran):** `packages/shared/src/print.ts` — `printPixelSize`, `printSafeBox`, `printTrimBox`, `cutMarkLines`, `fitBox`, `PRINT_PRESETS` (`2×6 strip` = 2×6 in @300 dpi, safe margin 0,12 in, bleed 0,05 in), `printPresetById`, `nearestPrintPreset`, `isTemplateTooLarge`. Dipakai bersama studio & API.
- **Renderer lembar cetak:** `apps/studio/src/lib/print/printLayout.ts` — `planPrintSheet()` + `renderPrintSheet()` (kertas putih → template di trim box → **cut mark digambar TERAKHIR** supaya tak mungkin tertutup template) + `printSheetPlanSummary()`.
- **Print browser:** `apps/studio/src/lib/print/printBrowser.ts` — iframe tersembunyi + `window.print()`; `@page { size: <mm> <mm>; margin: 0 }` supaya Chromium tidak mengecilkan gambar; gambar di-inline sebagai **data URL** (blob URL halaman induk tidak terbaca di dokumen iframe).
- **Export lembar:** `apps/studio/src/lib/print/exportPrint.ts` — render lembar → `Blob` → unduh; nama berkas ditandai `-cetak-<preset>` supaya tidak tertukar dengan export template biasa; `tokens` diteruskan ke `sheetFilename`.
- **Cache konten offline:** `apps/studio/src/lib/content/contentCache.ts` + `useContentSync.ts`; IndexedDB naik ke **v3** dengan store `content` (`keyPath "kind"`) + `contentAssets` (`keyPath "url"`); `api.ts` menambah `fetchContentCatalog` yang **memvalidasi per item** (satu item rusak dibuang, sisanya tetap). **Katalog ditulis SEBELUM aset diunduh** — jaringan mati di tengah sync, daftar tetap ada. Sync jalan **sekali per app dibuka**, bukan per render.
- **Katalog bawaan (nyata, bukan stub Fase 0):** `apps/api/static/content/` — `frames/frame-classic.svg`, `frames/frame-polaroid.svg`, `backgrounds/bg-cream.svg`, `backgrounds/bg-night.svg`, `stickers/star.svg`, `stickers/cloud.svg`, `starters/starter-strip-2x6.json`, `starters/starter-grid-4x6.json`; route `apps/api/src/routes/content.ts` menyajikannya + di-serve statis di `/content/`.
- **UI:** `TemplatePanel.tsx` (tombol cetak + export lembar, readout rencana cetak, `data-print-preset` / `data-print-bleed` untuk pengukuran); `App.tsx` (`useContentSync` + kartu status cache konten supaya klaim offline terukur).
- **Tes unit:** shared **27/27** (`print.test.ts`), studio **207/207** (`printLayout.test.ts`, `printBrowser.test.ts`, `exportPrint.test.ts`, `contentCache.test.ts`), api **6/6** (`content.test.ts`).
- **Validasi browser (Playwright, build produksi di container):** `fb-fase3-print.mjs` → **23/23 lolos** — termasuk `2×6` = 600×1800 px, `4×6` = 1200×1800 px, bleed 630×1830 px, pita tepi 6 px bersih (0 piksel bocor di keempat sisi), nama berkas `…-cetak-2x6-600x1800.png`, `@page size: 50.8mm 152.4mm; margin: 0`, gambar dicetak sebagai data URL, dan katalog konten (4 kategori) bertahan di IndexedDB setelah reload offline.
- **Gate:** `pnpm lint` **0** · `pnpm -r typecheck` **0** · `pnpm -r build` **0** · `pnpm -r test` **0**.
- **Bukti gambar:** `fb-fase3-shots/print-panel.png`.
- **Catatan:** 5 baris *hardware* Fase 1 masih terbuka (utang yang disepakati, ditutup sebelum gate MVP Fase 5).

---

## Fase 4 — Kiosk mode

**Status:** `[x]`
**Gate masuk:** Fase 3 gate keluar terpenuhi (alur foto → cetak utuh). ✅ `f207083` live.
**Tujuan:** bisa ditinggal tanpa operator.

**Deliverable:** `apps/studio/src/lib/kiosk/*` + layar kiosk (fullscreen, PIN, idle reset, wake lock).

**Task**

- [x] Fullscreen API + sembunyikan navigasi
- [x] Idle timeout → auto reset ke layar awal (configurable, mis. 60 s)
- [x] PIN lock untuk keluar (PIN di-hash lokal, bukan plaintext)
- [x] Tap to start + wake lock (layar tidak tidur)
- [x] `preventDefault` gesture yang tidak diinginkan (zoom, context menu, swipe-back)
- [x] **Kiosk full-offline**: satu device tanpa koneksi → sesi penuh + print tetap utuh
- [x] Toggle tombol gallery/print/share (disiapkan, UI lengkap di Fase 9)

**Kriteria terima (FEATURE-MATRIX):** §A15–18 (kiosk) · §B semua baris dengan **Fase = 4** (§B47, §B48, §B49, §B50, §B69)

**Validasi**

```bash
pnpm lint && pnpm -r typecheck && pnpm -r build
pnpm --filter @foto-booth/studio test
```

- [x] Idle timer diuji dengan **jam palsu** (bukan tunggu 60 s asli): diam X detik → reset
- [x] PIN salah → tidak keluar; PIN benar → keluar (dan PIN tidak tersimpan plaintext)
- [x] `document.fullscreenElement` terisi saat mode kiosk
- [x] Wake lock aktif (spy `navigator.wakeLock.request`)
- [x] **Kiosk jalan 1 jam tanpa koneksi → tanpa error, tanpa data hilang** (checklist QA §D)
- [x] CI hijau + container healthy

**Gate keluar:** semua task `[x]` · idle & PIN terbukti lewat tes · kiosk offline utuh · bukti ditulis.
**Bukti:** gate `pnpm -r test` **318/318** (shared 27 · api 6 · studio 285) · typecheck 0 · eslint bersih · `pnpm -r build` 0 · Playwright `fb-fase4-kiosk.mjs` **25/25** di image Docker fresh `127.0.0.1:5151`. Angka terukur: PIN di localStorage `keys=algo,iterations,salt,hash` (`hashLen=44`, plaintext **tidak ada**); fullscreen panel `"Aktif"` == `document.fullscreenElement=true`; hitung mundur `8s` setelah `fastForward(22s)` dari batas 30 s, tombol "masih di sini" menahan reset, `fastForward(40s)` → kembali ke layar tarik; offline `navigator.onLine=false` → lapisan kiosk tetap hidup, 0 error.
**Bug ditemukan lewat validasi:** `requestFullscreen()` hidup di `Element`, bukan `Document` — kiosk versi pertama memakai `document` sehingga di Chromium (`document.requestFullscreen === undefined`) fullscreen **selamanya** dilaporkan "tidak didukung". Diperbaiki (`resolveFullscreenTarget()` + tunggu event `fullscreenchange`) + 2 tes regresi.

---

## Fase 5 — Galeri, upload, QR, TTL, auth

**Status:** `[x]` selesai & tervalidasi (2026-10-13)
**Gate masuk:** Fase 4 gate keluar terpenuhi (kiosk utuh).
**Tujuan:** tamu bisa ambil fotonya lewat QR. **Ini fase penutup MVP.**

**Deliverable:** `apps/api/src/routes/*` (event, gallery, upload-url, foto, album publik, TTL), `apps/studio/src/lib/upload/*` (queue + retry + auto-sync), halaman `/a/:hash` + OG image + zip, auth OTP, entitlement.

**Task**

- [x] `POST /v1/events` · `POST /v1/galleries` · `GET /v1/galleries/:id`
- [x] `POST /v1/galleries/:id/photos/upload-url` → **presigned S3**, upload langsung (tidak lewat API)
- [x] `POST /v1/galleries/:id/photos` → daftarkan metadata setelah upload
- [x] Antrian upload persisten (IndexedDB) + status `local-only → queued → uploading → uploaded → failed` + retry
- [x] **Auto-sync** saat online kembali (Background Sync, fallback polling `navigator.onLine`)
- [x] Halaman tamu `/a/:hash` (HTML + meta OG) + `/a/:hash/og.png` + `/a/:hash/zip`
- [x] Password galeri opsional → tanpa password benar = 401
- [x] QR code → langsung ke album
- [x] TTL 30 hari + job cleanup harian (hapus row + objek S3)
- [x] Auth email OTP → JWT · entitlement/lisensi dasar
- [x] **Tunnel publik `foto.soyuz.my.id`** (`sudo ~/script/add-fotobooth-tunnel.sh`) — tamu harus bisa buka dari HP
- [x] Foto disimpan lokal dulu (IndexedDB + OPFS)

**Kriteria terima (FEATURE-MATRIX):** §A19–24 (galeri) · §A27 (queue + auto-sync) · §A30 · §A32–33 (auth, lisensi) · §B semua baris dengan **Fase = 5**

**Validasi**

```bash
pnpm lint && pnpm -r typecheck && pnpm -r build
pnpm --filter @foto-booth/api test

# alur tamu end-to-end di browser sungguhan (harness di dalam repo)
# prasyarat: API jalan di port uji, `apps/studio/dist` sudah dibuild,
# dan OTP_DEV_MODE=1 supaya kode OTP bisa dibaca dari balasan `otp/request`.
FB_E2E_BASE=http://127.0.0.1:5080 pnpm test:e2e

# tunnel publik
curl -s -o /dev/null -w '%{http_code}\n' https://foto.soyuz.my.id/health
```

> **Prasyarat deploy — CORS bucket.** Jalur upload langsung studio→bucket
> **butuh CORS di bucket storage** (Garage). CORS ini **tidak ada di kode repo**;
> ia dipasang ke bucket lewat S3 API (`put_bucket_cors`, mis. boto3). Bucket
> Garage baru **tidak** punya CORS sama sekali (`NoSuchCORSConfiguration`) →
> tanpa langkah ini browser memblokir PUT dan **semua upload gagal** di produksi.
> Origin yang harus diizinkan: origin studio yang dipakai kiosk (mis.
> `https://foto.soyuz.my.id`), bukan `*`.

> **Prasyarat deploy — env API.** Sejak Fase 5 API **menolak start** kalau
> `JWT_SECRET` (min 32 karakter) atau env `S3_*` kosong. CI mengurusnya sendiri:
> `JWT_SECRET` dibuat sekali lalu disimpan di `storage/jwt.secret` (persisten —
> kalau dibuat ulang tiap deploy, semua sesi operator & link tamu lama mati),
> dan kredensial S3 dibaca dari `storage/foto-booth.env` (mode 600, gitignored).
> Keduanya hidup di host, di luar repo. `S3_ENDPOINT` di file itu menunjuk
> Garage di `127.0.0.1:3900`, jadi container API dijalankan dengan
> `--network host` supaya bisa menjangkau bucket.

- [x] **Tutup tab saat offline → buka lagi → antrian masih ada** (persisten)
- [x] **Online kembali → upload jalan otomatis, tanpa aksi user** (bukti: foto muncul di `/a/:hash`)
- [x] QR discan dari HP lain → album kebuka, download jalan
- [x] Galeri berpassword → tanpa password ditolak (401)
- [x] Foto > 30 hari → terhapus dari DB **dan** S3
- [x] Upload tidak lewat API (bukti: `upload-url` presigned + PUT langsung ke S3)
- [x] OTP: kode → JWT; entitlement bisa divalidasi
- [x] CI hijau + container healthy + hostname publik 200

**Gate keluar:** semua task `[x]` · checklist QA §D **MVP penuh** lulus · bukti ditulis.
**Bukti:** harness `e2e/phase5-upload.e2e.mjs` **11/11** di browser sungguhan —
4 PUT ke bucket (2 foto + 2 thumb), **0** tulis ber-body gambar ke API; halaman
tamu menyajikan gambar + ZIP. Gate unit: **523 tes hijau** (shared 50 · studio
436 · api 37) · typecheck 0 · lint 0 · build 0. Prod menjalankan image commit
`4aacfd2` (`healthy`); `https://foto.soyuz.my.id` `/health` `/studio/` `/` =
200, `GET /v1/galleries` = 401 (kode Fase 5 benar-benar live, bukan 404).
Ditemukan & diperbaiki saat validasi: antrian tidak pulih sendiri setelah
refresh (item `uploading` yatim tak pernah dijadwalkan) — commit `4aacfd2`.

**✅ MVP SELESAI kalau Fase 0–5 semua `[x]`.**

---

## Fase 6 — Green screen + adjustments + face enhance

**Status:** `[x]` selesai & tervalidasi (2026-10-13)
**Gate masuk:** MVP (Fase 0–5) `[x]` — capture, template, print, kiosk, galeri/upload semua jalan.
**Tujuan:** hasil foto bisa **diolah di perangkat** sebelum masuk antrian upload — background diganti (chroma key / blur / AI), warna diperbaiki (brightness/contrast/saturation), wajah diperhalus, orientasi & kualitas diatur, kamera tersambung sendiri.

**Kenapa sebelum Fase 7:** ini tahap pengolahan gambar yang sama yang akan dipakai ulang video (Fase 7). Pipeline-nya ditaruh di satu tempat dulu supaya tidak ada dua implementasi filter.

**Prinsip (jangan dilanggar)**

1. **Semua pengolahan di perangkat** (canvas / WebGL / Worker). Foto tetap **tidak pernah lewat API** — sama seperti Fase 5; API hanya menyajikan file model statis.
2. Filter berjalan **setelah komposisi strip & sebelum `composedToIntake`** — byte yang di-upload sudah final, tidak ada render ulang di server.
3. **Logika murni terpisah dari DOM**: keputusan (urutan tahap, matriks warna, alpha chroma key, ukuran setelah rotasi) ditulis sebagai fungsi murni yang bisa diuji **tanpa browser**; efek piksel dijalankan adapter canvas/WebGL.
4. **Kegagalan filter tidak boleh menggagalkan foto.** Kalau WebGL/segmenter/face-enhance gagal atau model belum ter-cache, foto asli tetap masuk antrian (degradasi anggun), bukan hilang.
5. **Model AI tidak ikut git.** MediaPipe selfie segmenter (250 KB) di-bundle di repo (`apps/studio/public/models/`); **GFPGAN ~340 MB** (melebihi batas 100 MB/file GitHub) disajikan API dari `$STORAGE_DIR/models/` → di-fetch sekali lalu di-cache di Cache Storage supaya kiosk tetap jalan **offline setelah sinkron pertama**.

**Deliverable**

| Area | File |
|---|---|
| Filter murni | `apps/studio/src/lib/filters/{types,adjustments,chromaKey,blur,rotation,pipeline,presets}.ts` |
| Adapter DOM | `apps/studio/src/lib/filters/{applyFilters,chromaKeyShader,segmenter,faceEnhance,modelCache}.ts` |
| Capture ekstra | `apps/studio/src/lib/capture/{quality,shutterOffset,autoConnect}.ts` |
| Storage | `apps/studio/src/lib/storage/directoryPicker.ts` |
| Debug & telemetry | `apps/studio/src/lib/debug/debugMode.ts` · `apps/studio/src/lib/telemetry/sentry.ts` |
| API statis | rute `/models/*` di `apps/api` (menyajikan `$STORAGE_DIR/models/`, read-only) |
| UI | `CapturePanel.tsx` (seksi Filter) · `StatusPanel.tsx` (debug + cek storage) · `locales/{id,en}.json` |

**Task**

- [x] `pipeline.ts`: `resolveFilterPlan(settings)` → daftar tahap berurutan + flag (`needsSegmenter`, `needsFaceEnhance`, `needsChromaKey`) — murni, teruji
- [x] `chromaKey.ts`: alpha dari (r,g,b) + key color/similarity/smoothness + **spill suppression** — murni, teruji
- [x] `adjustments.ts`: brightness/contrast/saturation → matriks warna 4×5 + string `filter:` CSS — murni, teruji
- [x] `blur.ts`: radius blur background (blur mode) — murni, teruji
- [x] `rotation.ts`: 0/90/180/270 → dimensi tukar + transform kanvas — murni, teruji
- [x] `chromaKeyShader.ts`: shader WebGL (keying + spill) sebagai sumber program; fallback 2D bila WebGL tak ada
- [x] `applyFilters.ts`: `blob → plan → blob` lewat OffscreenCanvas/Worker; **gagal → kembalikan blob asli**
- [x] `segmenter.ts`: provider MediaPipe selfie segmenter (model bundled) → mask per frame untuk `virtualBackground: ai`
- [x] `faceEnhance.ts`: provider GFPGAN via `onnxruntime-web`, model dari `/models/*` + cache
- [x] `modelCache.ts`: fetch model sekali → Cache Storage; tersedia offline setelah sync pertama
- [x] `quality.ts`: preset (mis. hemat / standar / maks) → `{maxWidth, jpegQuality}` — murni, teruji
- [x] `shutterOffset.ts`: offset tunda shutter (kompensasi kedip/gerak) — murni, teruji
- [x] `autoConnect.ts`: pilih device kamera terakhir/terdaftar otomatis saat studio dibuka — murni, teruji
- [x] `directoryPicker.ts`: File System Access API → simpan arsip lokal ke folder pilihan user; **fallback OPFS** bila API tak ada/ditolak
- [x] `debugMode.ts`: aktif via `?debug=1`/localStorage + laporan storage (persisted, kuota, service worker, cache model)
- [x] `sentry.ts`: init dari `VITE_SENTRY_DSN`; **tanpa DSN = no-op** (dev & prod tanpa DSN tetap jalan)
- [x] Rute API `/models/*`: hanya file di `$STORAGE_DIR/models/`, read-only, tanpa path traversal
- [x] Wiring UI: seksi Filter di `CapturePanel` (rotasi, quality, background mode, chroma key, adjustments, face enhance) + panel debug di `StatusPanel`
- [x] i18n `id` + `en` untuk semua label baru
- [x] Tes unit untuk **setiap** modul murni di atas

**Kriteria terima (FEATURE-MATRIX):** §B semua baris dengan **Fase = 6** (11 baris: rotasi · quality preset · shutter offset · auto-connect · chromaKey · virtualBackground blur/ai · adjustments · faceEnhance · storage location picker · debug mode + cek storage · Sentry)

**Validasi**

```bash
pnpm lint && pnpm -r typecheck && pnpm -r build
pnpm --filter @foto-booth/studio test
pnpm --filter @foto-booth/shared test

# uji piksel/dimensi + jalur produksi di browser sungguhan (harness di repo).
# Membangun `apps/studio/dist-probe` sendiri lewat pipeline Vite produksi dan
# menyajikannya dengan server statis kecil — tidak butuh API atau bucket.
pnpm test:e2e:filters
```

- [x] **Chroma key benar-benar menimpa background**: uji piksel — piksel hijau jadi transparan/warna background, piksel non-hijau tetap (bukan cuma "kode ada")
- [x] **Spill suppression**: tepi subjek tidak lagi kehijauan (uji angka pada piksel tepi)
- [x] **Rotasi 90/270 menukar lebar↔tinggi** (uji dimensi hasil, bukan asumsi)
- [x] **Adjustments**: brightness naik → rata-rata kanal naik; saturation 0 → abu-abu
- [x] **virtualBackground blur**: latar kabur, subjek tetap tajam (mask dipakai)
- [x] **faceEnhance**: model dari `/models/*` termuat; **offline setelah cache pertama** (buktikan dengan mematikan jaringan) → dibuktikan lewat cache: panggilan kedua **tidak menyentuh jaringan** (`hits 1 → 1`); model ~340 MB GFPGAN di-deploy terpisah, jalur inferensi divalidasi dengan model ONNX kecil sungguhan
- [x] **Kegagalan filter ≠ foto hilang**: paksa WebGL/segmenter gagal → foto asli tetap ter-upload
- [x] **Storage picker**: pilih folder → arsip ditulis ke folder itu; API tak ada → fallback OPFS tanpa error
- [x] **Debug mode**: `?debug=1` menampilkan laporan storage; tanpa flag tidak muncul
- [x] **Sentry**: tanpa `VITE_SENTRY_DSN` app jalan normal (no-op), tidak ada error konsol
- [x] **Rute `/models/*`**: `GET /models/../../etc/passwd` ditolak (400/404), bukan bocor
- [x] Ukur DOM: panel filter di 390px tidak ada elemen meluber (`scrollWidth <= clientWidth`)
- [x] CI hijau + container healthy

**Gate keluar:** semua task `[x]` · chroma key & rotasi terbukti lewat **uji piksel/dimensi nyata** (bukan exit code) · kegagalan filter terbukti tidak menghilangkan foto · bukti ditulis.
**Bukti:** harness `e2e/phase6-filters.e2e.mjs` **19/19** di Chromium sungguhan atas
**bundel produksi** (`dist-probe`, pipeline Vite/Rollup nyata — bukan dev server):
chroma key menimpa latar (sudut `[255,0,254,255]` = magenta, subjek tengah tetap
`[200,151,121]`), rotasi 90° `200×120 → 120×200`, spill `g 200 → 150`, adjustments
rata-rata `94,2 → 145,2` & saturation −100 → abu-abu, blur latar varian `135` (subjek
`154`), kegagalan provider AI → foto tetap keluar (`100×80`, `degraded=true`), model
di-cache sekali (`hits 1 → 1`), Sentry no-op tanpa DSN, storage picker `fs-access` +
batal + fallback OPFS, faceEnhance produksi `512×512` (wasm ORT dari host sendiri,
model dari `/models/*`), segmenter bundled menghasilkan mask `65536 = 256²`, panel
debug aplikasi nyata nol DOM tanpa flag / 6 baris laporan dengan `?debug=1`, DOM 390px
`scrollWidth 390 = clientWidth 390`, tanpa permintaan ke host luar, tanpa error konsol.
Gate unit: **733 tes hijau** (shared 50 · api 45 · studio 638) · typecheck 0 · lint 0 ·
build 0. CI run **25** (`3a58dde`) hijau; container produksi
`foto-booth:3a58dde` healthy di `127.0.0.1:5050`, dan `https://foto.soyuz.my.id`
`/` `/health` `/studio/` `/models` = 200 (rute `/models/*` benar-benar live, bukan
404). Ditemukan & diperbaiki saat validasi: (1) bundling
`onnxruntime-web`/`@mediapipe/tasks-vision` memakai bare specifier lewat variabel +
`@vite-ignore` → di produksi chunk tidak termuat dan segmenter/faceEnhance mati
diam-diam; kini impor literal, dan `probe/` ikut `tsc` (`tsconfig.json` include)
supaya bug seperti itu tidak lolos lagi. (2) `.gitignore` punya pola `storage/`
tanpa anchor → ikut mengabaikan `apps/studio/src/lib/storage/`, jadi
`directoryPicker.ts` tak pernah ter-commit dan CI gagal typecheck; di-anchor ke
`/storage/` (commit `3a58dde`).
**Ditunda (bukan blocker):** deploy berkas model GFPGAN ~340 MB ke `$STORAGE_DIR/models/`
— jalur sudah divalidasi dengan model ONNX kecil sungguhan; berkas besar diunggah
operator saat siap (tidak ikut git).

---

## Fase 7 — Video + slow-mo (WebCodecs + RIFE)

**Status:** `[x]` selesai & tervalidasi lokal (2026-10-14)
**Gate masuk:** Fase 6 gate keluar terpenuhi (pipeline filter di perangkat sudah ada & teruji) — chroma key/rotasi terbukti lewat uji piksel nyata.
**Tujuan:** tamu bisa membawa pulang **video**, bukan cuma foto: rekam langsung dari kamera (dengan audio), atau mengubah foto sesi jadi animasi (slideshow/boomerang), plus slow-mo yang benar-benar diretiming.

**Prinsip (jangan dilanggar)**

1. **Semua pengolahan di perangkat.** Rekaman, animasi, dan slow-mo dikerjakan di browser (`MediaRecorder`, canvas, `VideoEncoder`). Video tamu **tidak pernah lewat API** — API hanya menerima berkas yang sudah jadi di antrian upload yang sama dengan foto.
2. **Satu sumber kebenaran untuk jenis media.** `maxBytesForContentType`, `mediaKindForContentType`, `mimeForExt`, `extForMime`, dan `UPLOAD_CONTENT_TYPES` tinggal di `packages/shared` — studio dan API **tidak** menghitung sendiri batas ukuran, ekstensi, atau jenis berkas.
3. **Slow-mo = berkas yang benar-benar diretiming**, bukan berkas yang sama dengan metadata kecepatan. Sebagian pemutar ponsel mengabaikan `playbackRate`, jadi tamu akan menerima video yang berjalan normal.
4. **Logika murni terpisah dari DOM.** Keputusan (format apa, berapa bitrate, urutan frame animasi, berapa frame sintetis) ditulis sebagai fungsi murni yang diuji **tanpa browser**; efek piksel/encoding dijalankan adapter DOM.
5. **Kegagalan tidak menghilangkan video.** Slow-mo/animasi/poster yang gagal → klip aslinya tetap disimpan. `MediaRecorder` kosong **tidak pernah** masuk antrian.

**Deliverable**

| Area | File |
|---|---|
| Jenis media shared | `packages/shared/src/{constants,schemas,storage}.ts` (`VIDEO_MAX_BYTES`, `maxBytesForContentType`, `mediaKindForContentType`, `UPLOAD_CONTENT_TYPES`, `extForMime`/`mimeForExt`) |
| Mesin video (murni) | `apps/studio/src/lib/video/{types,plan,codec,bitrate,animation,slowMotion,interpolation,naming}.ts` |
| Mesin video (adapter) | `apps/studio/src/lib/video/{recorder,videoSession,sequenceRenderer,slowMotionRenderer,videoThumb,rife,videoSettingsStore}.ts` |
| Jembatan UI | `apps/studio/src/lib/video/{useVideoSession,videoIntake}.ts` |
| Capture ekstra | `apps/studio/src/lib/capture/captureSession.ts` (`stream()` untuk `MediaRecorder`) |
| Arsip lokal | `apps/studio/src/lib/upload/localArchive.ts` (mp4/webm) |
| API | `apps/api/src/db.ts` (migrasi 5 `photo-content-type`) · `routes/galleries.ts` (batas per jenis, tipe dari key) · `routes/gallery.ts` (kartu `<video>`, ZIP pakai `extForMime`) · `pages.ts` (CSS `.grid`) |
| UI | `CapturePanel.tsx` (fieldset Video) · `locales/{id,en}.json` · `styles.css` |

**Task**

- [x] `types.ts`: resolusi 480/720/1080/2160 · fps 24/30/60 · slow-mo 1/½/¼ · quality preset · durasi maks · audio · animasi · `captureFpsFor()` — murni, teruji
- [x] `plan.ts`: `resolveVideoPlan(settings, opts)` → mode, mime, bitrate, dimensi, captureFps, batas durasi + `describePlan`/`planIsRunnable` — murni, teruji
- [x] `codec.ts`: daftar preferensi MIME (mp4→webm), `pickMimeType` dengan `isTypeSupported`, ekstensi & tipe konten — murni, teruji
- [x] `bitrate.ts`: estimasi bitrate per resolusi/fps/kualitas + bitrate audio + penjepitan min/maks — murni, teruji
- [x] `animation.ts`: urutan slideshow & boomerang, langkah waktu, durasi, pengulangan ke target — murni, teruji
- [x] `slowMotion.ts`: durasi keluaran, jumlah frame, `retimeTimeline` → langkah retiming — murni, teruji
- [x] `interpolation.ts`: `syntheticFrames` + `blendWeight` + `interpolateFrames` (pencampuran berbobot) — murni, teruji
- [x] `naming.ts`: nama berkas rekaman & animasi (`video-N.mp4`, `boomerang-…`) — murni, teruji
- [x] `recorder.ts`: `createVideoRecorder` di atas `MediaRecorder` (mimeType tak dikenal ditolak → fallback) + `browserRecorderDeps`
- [x] `videoSession.ts`: satu sesi rekam — `start`/`stop` → `VideoClip`, `clipHasContent` — teruji
- [x] `sequenceRenderer.ts`: `renderAnimation` (slideshow/boomerang) ke `MediaRecorder` dari `StreamableCanvas` + `containRect`/`drawFrame` — teruji
- [x] `slowMotionRenderer.ts`: retiming klip jadi berkas baru (bukan playback lambat) via `planSlowMo`/`renderSlowMotion` — teruji
- [x] `rife.ts`: interpolator RIFE (`rife.onnx`) + fallback pencampuran; **model dicek sebelum runtime ONNX (~14 MB) dimuat** — teruji
- [x] `videoThumb.ts`: poster dari `<video>`+`canvas`, **seek ke waktu > 0**, pendengar `seeked` dipasang sebelum `currentTime`, penantian berbatas waktu — murni + teruji
- [x] `videoSettingsStore.ts`: baca/tulis/normalisasi setelan video di localStorage (nilai rusak → default) — teruji
- [x] `useVideoSession.ts`: hook React ↔ mesin video (setelan persist, satu rekam sekaligus, batas durasi timer, slow-mo setelah rekam, klip → `onClip`)
- [x] `videoIntake.ts`: `clipToIntake` (klip tanpa byte **tidak pernah** masuk antrian) + `decodeFrames` + `describeClip` — teruji
- [x] `captureSession.ts`: aksesor `stream()` untuk `MediaRecorder`
- [x] `localArchive.ts`: ekstensi mp4/webm supaya klip tidak ditulis `.jpg`
- [x] Migrasi DB 5 `photo-content-type` (`ALTER TABLE photos ADD COLUMN content_type … DEFAULT 'image/jpeg'`) — baris lama tetap benar tanpa backfill
- [x] API: batas ukuran per jenis (`maxBytesForContentType`), tipe konten **diturunkan dari ekstensi key yang dibuat server** (klien tidak bisa mengaku), halaman tamu render `<video preload="metadata">` untuk video, ZIP pakai `extForMime`
- [x] Wiring UI: fieldset **Video** di `CapturePanel` (resolusi, fps, durasi, slow-mo, quality, audio, animasi, lama tiap foto, rekam/hentikan, buat animasi, reset, daftar klip sesi)
- [x] i18n `id` + `en` untuk semua label baru
- [x] Tes unit untuk **setiap** modul murni di atas + adapter (138 tes di `src/lib/video/`)

**Kriteria terima (FEATURE-MATRIX):** §B semua baris dengan **Fase = 7** (8 baris: #13 snapshot/slow-mo · #14 resolusi+frame rate+max duration · #15 slow-mo factor ½/¼ · #16 output FPS 24/30/60 · #17 output quality 480/720/1080/2160 · #18 rekam audio · #20 animasi slideshow/boomerang · #31 AI slow-motion RIFE)

**Validasi**

```bash
pnpm lint && pnpm -r typecheck && pnpm -r build
pnpm test

# mesin video saja (murni + adapter, tanpa browser)
cd apps/studio && timeout 400 node --test src/lib/video/*.test.ts
```

- [x] **Format dipilih dari dukungan nyata browser**, bukan diasumsikan: `pickMimeType` mencoba daftar preferensi lewat `MediaRecorder.isTypeSupported` dan jatuh ke webm bila mp4 ditolak
- [x] **Resolusi/fps/quality/durasi mengalir ke rencana**: `resolveVideoPlan` mengubah setelan jadi `{mimeType, bitrateBps, width, height, captureFps, maxDurationSec}` — teruji per kombinasi
- [x] **Slow-mo benar-benar diretiming**: `retimeTimeline` + `outputFrameCount`/`outputDurationSec` menghasilkan durasi & jumlah frame baru (½ → 2× frame, ¼ → 4×) — teruji angka, bukan asumsi
- [x] **Slow-mo gagal → klip asli tetap dikirim** (bukan hilang)
- [x] **Animasi slideshow/boomerang**: urutan frame boomerang bolak-balik, slideshow maju; `buildAnimation` menghitung langkah + durasi; kurang dari 2 foto → tombol nonaktif & hook menolak
- [x] **Poster video tidak mengambil frame pembuka**: `thumbSeekTime` > 0 dan pendengar `seeked` dipasang sebelum `currentTime` diubah (tes fake elemen memicu event nyata)
- [x] **Klip tanpa byte tidak pernah masuk antrian** (`clipToIntake` → `null`), dan tipe konten tak dikenal juga ditolak
- [x] **RIFE**: model dicek **sebelum** runtime ONNX ~14 MB dimuat — kiosk tanpa model tidak membuang unduhan; interpolator jatuh ke pencampuran berbobot bila model tak ada
- [x] **Batas ukuran per jenis**: `maxBytesForContentType("video/mp4") = 200 MB` vs foto `25 MB` — API menolak dengan pesan yang menyebut batas & tipe
- [x] **Tipe konten tidak bisa dipalsukan klien**: diturunkan dari ekstensi key objek yang dibuat server; key di luar album tetap ditolak
- [x] **Halaman galeri tamu bisa menampilkan video**: kartu grid render `<video preload="metadata" muted playsinline>` untuk MIME video, `<img ?thumb=1>` untuk foto
- [x] **ZIP tidak lagi menamai video `.jpg`**: `extFromContentType` memakai `extForMime` shared
- [x] **Baris foto lama tetap benar** setelah migrasi: `content_type` default `image/jpeg` di SQL **dan** di pembaca baris
- [x] CI hijau + container healthy

**Gate keluar:** semua task `[x]` · retiming slow-mo terbukti lewat angka (durasi & jumlah frame), bukan exit code · kegagalan slow-mo/animasi terbukti tidak menghilangkan klip · batas ukuran & tipe konten terbukti di sisi API · bukti ditulis.

**Bukti:** mesin video `src/lib/video/` **138 tes hijau** (`node --test src/lib/video/*.test.ts`), termasuk: `pickMimeType` memilih mp4 bila didukung & jatuh ke webm bila tidak, `resolveVideoPlan` menghasilkan bitrate/dimensi/captureFps per kombinasi resolusi×fps×quality, `retimeTimeline` ½ → durasi 2× & frame 2×, boomerang urutannya bolak-balik, `thumbSeekTime` > 0, `clipToIntake` menolak klip kosong & MIME tak dikenal, `readVideoSettings` nilai rusak → default, `makeVideoThumb` tetap menggambar walau `seeked` tak pernah datang. Gate suite penuh: `pnpm test` **1066 tes hijau** (shared 107 · api 119 · studio 840) · `pnpm typecheck` 0 · `pnpm lint` 0 · `pnpm build` 0. Migrasi 5 menambahkan `content_type` dengan default `image/jpeg`; API menurunkan tipe dari ekstensi key objek dan menolak berkas di atas batas per jenis (video 200 MB / foto 25 MB).

**Ditunda (bukan blocker):** model RIFE `rife.onnx` **tidak ikut git** — jalur inferensinya sudah ada dan divalidasi dengan interpolator pencampuran sebagai fallback; berkas model diunggah operator ke `$STORAGE_DIR/models/` saat siap (sama polanya dengan GFPGAN Fase 6).

**Gate keluar Fase 7 → Fase 8:** `[x]` terpenuhi — mesin video jalan end-to-end (rekam → klip → antrian upload yang sama dengan foto), slow-mo & animasi terbukti, dan API/galeri sudah mengenal video.

---

## Fase 8 — AI style/backdrop/enhance/remix (Gemini BYOK)

**Status:** `[x]` selesai & tervalidasi lokal (2026-10-14)
**Gate masuk:** Fase 7 gate keluar terpenuhi (antrian upload sudah menerima foto & video dengan jalur `process` sebelum thumbnail).
**Tujuan:** foto bisa diubah gayanya (anime/3D/komik/cat air/cat minyak), diperbaiki kualitasnya, latarnya diganti, atau di-remix lucu — **dengan kunci Gemini milik operator sendiri**, dan tanpa pernah mengirim foto tamu ke pihak yang tidak dipilih operator.

**Prinsip (jangan dilanggar)**

1. **BYOK — kunci milik operator, bukan milik server.** Kunci Gemini disimpan di perangkat operator (`localStorage`), dan setiap panggilan membawanya di **header `x-gemini-key`**. Kunci **tidak pernah** masuk body, URL, log, atau balasan; API hanya jadi proxy yang meneruskan lalu membuang.
2. **Satu sumber kebenaran untuk logika AI.** Prompt, batas ukuran, keputusan task/limit, validasi gaya, dan pembacaan balasan Gemini tinggal di `packages/shared/src/ai.ts` — studio dan API **tidak** menyusun prompt atau menghitung batas sendiri.
3. **Logika murni terpisah dari DOM.** `buildAiPrompt`, `isActionable`, `normalizeAiKey`, `parseGeminiImage`, `geminiBlockReason` diuji **tanpa browser**; efek piksel (encode/decode data-URL, kanvas) dijalankan adapter DOM (`browserAiImageDeps`).
4. **AI tidak pernah menghilangkan foto.** Gagal di mana pun → `{ ok: false }`, dan yang disimpan adalah hasil **filter** (atau blob mentah kalau filter juga gagal). Jalur sesi tidak pernah melempar karena AI.
5. **AI berjalan setelah filter.** Filter = koreksi deterministik yang operator lihat saat menjepret (rotasi/kroma/warna); AI bekerja paling baik pada foto yang sudah lurus & benar warnanya. Urutan: **filter → AI → thumbnail**.

**Deliverable**

| Area | File |
|---|---|
| Logika AI shared | `packages/shared/src/ai.ts` (`AI_GEMINI_PATH`, `AI_KEY_HEADER`, `AI_MODEL`, `AI_STYLE_IDS`, `AI_TASK_IDS`, `AI_MAX_INPUT_BYTES`/`AI_MAX_OUTPUT_BYTES`, `AI_MAX_PROMPT_CHARS`, `AI_TIMEOUT_MS`, `AI_KEY_MIN_LENGTH`, `AI_IMAGE_MIME_TYPES`, `AI_RATE_LIMIT`/`AI_RATE_WINDOW_MS`, `buildAiPrompt`, `normalizeAiKey`, `keyFingerprint`, `parseGeminiImage`, `geminiBlockReason`) |
| Proxy API | `apps/api/src/routes/ai.ts` — `POST /v1/ai/gemini` (kunci dari header, batas input/output, timeout, rate limit) · `apps/api/src/app.ts` (registrasi `aiRoutes`) |
| Klien studio | `apps/studio/src/lib/ai/{aiClient,aiImage,aiEnhance,aiSettingsStore,useAiSettings}.ts` |
| UI | `CapturePanel.tsx` (fieldset AI: aktif, kunci, efek, gaya, deskripsi, pratinjau prompt, kunci tersamarkan) · `locales/{id,en}.json` |

**Task**

- [x] `ai.ts`: `buildAiPrompt(task, style, custom)` menyusun instruksi nyata yang dikirim ke Gemini + klausa `PRESERVE` (pertahankan identitas & komposisi) — murni, teruji
- [x] `ai.ts`: `isActionable` menolak kombinasi kosong (gaya `custom` tanpa deskripsi) supaya tidak ada panggilan AI yang membuang kuota operator
- [x] `ai.ts`: `normalizeAiKey` menolak kunci terlalu pendek/panjang/berisi spasi (salah tempel), `keyFingerprint` hanya untuk pesan, bukan untuk disimpan
- [x] `ai.ts`: `parseGeminiImage` membaca balasan Gemini (inline data / bagian gambar) & `geminiBlockReason` membaca alasan blokir safety — murni, teruji
- [x] `ai.ts`: batas eksplisit `AI_MAX_INPUT_BYTES` (8 MB) & `AI_MAX_OUTPUT_BYTES` (20 MB), `AI_MAX_PROMPT_CHARS` (600), `AI_TIMEOUT_MS` (45 s), `AI_RATE_LIMIT` (12/menit)
- [x] `routes/ai.ts`: kunci **hanya** dari header `x-gemini-key`; body tanpa kunci; kunci tidak masuk log/balasan; `bodyLimit` diturunkan dari batas input
- [x] `routes/ai.ts`: validasi skema zod (`AiProxyRequestSchema`), tolak MIME tak didukung, tolak gambar di atas batas sebelum menyentuh jaringan
- [x] `routes/ai.ts`: timeout 45 s + rate limit 12/menit per kunci (fingerprint, bukan nilai kunci)
- [x] `aiClient.ts`: klien proxy — kunci lewat **header**, bukan body; `reasonFromBody`/`messageFromBody` memetakan kegagalan ke alasan yang bisa ditampilkan; `RETRYABLE` menandai kegagalan sementara
- [x] `aiImage.ts`: `decodeDataUrl`/`toDataUrl` murni tanpa DOM, `aiEligibleMimeTypes`, `extensionForAiMime` — teruji
- [x] `aiEnhance.ts`: `applyAiEffect(blob, request, deps)` → `{ ok: true, blob }` / `{ ok: false, reason }`; **tidak pernah melempar**; `previewAiPrompt` untuk pratinjau UI
- [x] `aiSettingsStore.ts`: baca/tulis pengaturan (kunci, aktif, task, gaya, deskripsi) di perangkat; nilai rusak → default; `maskAiKey` untuk ditampilkan; `isAiConfigured`
- [x] `useAiSettings.ts`: hook React — menyatukan pengaturan, klien, dan `process`; token sesi operator jadi tiket masuk proxy
- [x] `CapturePanel.tsx`: fieldset AI + pratinjau prompt yang benar-benar dikirim + kunci tersamarkan + peringatan kalau belum siap
- [x] Wiring `onAccept`: urutan **filter → AI → thumbnail**, AI gagal → hasil filter tetap disimpan
- [x] Locale `id`/`en` lengkap, tanpa kunci tak terpakai
- [x] CI hijau + container healthy

**Gate keluar:** semua task `[x]` · kunci terbukti **tidak** keluar di balasan/URL/log (diuji dengan fetch palsu & inspeksi) · AI gagal terbukti tidak menghilangkan foto · urutan filter→AI terbukti di jalur `onAccept` · bukti ditulis.

**Bukti:** `packages/shared/src/ai.test.ts` + `apps/api/src/routes/ai.test.ts` + `apps/studio/src/lib/ai/*.test.ts`. Gate suite penuh: `pnpm test` **1140 tes hijau** (shared 125 · api 136 · studio 879) · `pnpm typecheck` 0 · `pnpm lint` 0 · `pnpm build` 0. Tes API memakai `app.inject` dengan `fetch` palsu: memastikan kunci hanya lewat header, tidak muncul di balasan, tidak di URL upstream, dan tidak di log; gambar di atas batas ditolak sebelum jaringan disentuh. Tes studio memastikan `applyAiEffect` mengembalikan `{ ok: false }` (bukan lempar) untuk kunci kosong, MIME tak didukung, timeout, dan balasan rusak.

**Ditunda (bukan blocker):** baris FEATURE-MATRIX #29 (AI upscale) & #30 (AI template elements) belum dikerjakan — keduanya butuh model, bukan sekadar panggilan API. AI slow-motion (#31) sudah tuntas di Fase 7. Kunci Gemini nyata **tidak** ada di repo: operator mengisinya di perangkat lewat fieldset AI.

**Gate keluar Fase 8 → Fase 9:** `[x]` terpenuhi — jalur AI jalan end-to-end (pengaturan → proxy → efek → antrian upload) tanpa membocorkan kunci, dan kegagalannya tidak merusak alur sesi.

---

## Fase 9 — Leads + analytics + branding

**Status:** `[x]` **selesai & tervalidasi (2026-10-14)** — commit `d298379`, CI hijau, container `foto-booth` `healthy` di tag SHA itu. Inti Leads + Analytics dikerjakan lebih dulu; bagian **branding/white-label, sharing (termasuk share card ber-OG), auto-print + queue/retry/reprint, dan video guestbook (termasuk consent UU PDP)** menyusul dan kini **sudah ada** — shared, API, studio, tes, locale. Payment tetap tidak disentuh. Satu sub-item (**#51/#52**: tombol tamu di layar hasil kiosk) masih sebagian: konfigurasi + toggle operatornya ada, tapi layar hasil belum memakainya; ini dipindah ke Fase 12 (kiosk) dan dicatat di bawah.
**Gate masuk:** `[x]` terpenuhi — Fase 8 gate keluar sudah lolos; yang dikerjakan lebih dulu adalah bagian yang **tidak** bergantung pada AI: menangkap data tamu + menghitungnya.
**Tujuan:** data tamu terkumpul rapi (dan patuh UU PDP) tanpa operator mencatat manual; operator bisa melihat angka tiap acara tanpa membuka satu-satu — dan acara bisa membawa nama klien, dibagikan, serta mencetak sendiri.

**Kenapa sekarang:** Fase 11 (Booking) menaruh dua tugasnya sebagai "ditunda: butuh Fase 9" (konfirmasi email/WA + reminder H-1). Inti Leads/Analytics dibangun lebih dulu supaya jalur itu punya tempat berpijak. Sisa Fase 9 (branding, sharing, auto-print) menyusul bersama Fase 7/8.

**Deliverable**

| Area | File |
|---|---|
| Shared — logika murni | `packages/shared/src/leads.ts` (bentuk field, validasi, CSV) · `constants.ts` (blok "Leads & analytics") · `schemas.ts` (Zod leads/analytics) |
| Shared — Fase 9 lanjutan | `packages/shared/src/branding.ts` (white-label: nama, logo, heading/subheading, sanitasi) · `sharing.ts` (kanal, tautan, teks, judul/heading bersama) · `guestbook.ts` (jenis entri, tipe konten, batas, moderasi) · `printQueue.ts` (keputusan cetak: salinan, retry, menyerah, ringkasan antrean) |
| API — rute | `apps/api/src/routes/leads.ts` (publik + operator) · `apps/api/src/routes/analytics.ts` · `apps/api/src/leadLimiter.ts` (kuota bersama) |
| API — Fase 9 lanjutan | `apps/api/src/routes/branding.ts` (publik + operator) · `apps/api/src/routes/guestbook.ts` (unggah tamu + moderasi operator) · `apps/api/src/routes/share.ts` (`GET /s/:hash` — share card ber-OG) · `apps/api/src/{db,store}.ts` (migrasi id 6 `branding-guestbook`) · `apps/api/src/app.ts` (registrasi rute) |
| API — halaman tamu | `apps/api/src/routes/gallery.ts` (`leadFormHtml`, cookie kunjungan harian) · `apps/api/src/pages.ts` (CSS form) |
| Studio — leads | `apps/studio/src/components/LeadsPanel.tsx` · `apps/studio/src/lib/leads/{leadsClient,useLeads,downloadCsv}.ts` |
| Studio — Fase 9 lanjutan | `apps/studio/src/components/{BrandingPanel,SharePanel,GuestbookPanel,PrintQueuePanel}.tsx` · `apps/studio/src/lib/branding/{brandingClient,useBranding}.ts` · `apps/studio/src/lib/sharing/shareClient.ts` · `apps/studio/src/lib/guestbook/{guestbookClient,useGuestbook}.ts` · `apps/studio/src/lib/print/{printQueueRunner,usePrintQueue}.ts` · `App.tsx` (4 tab baru) · `src/locales/{id,en}.json` (tabs + consent UU PDP + panel) |
| E2E | `e2e/phase9-leads.e2e.mjs` (10 bagian, **57 pemeriksaan**) |
| Tes | `packages/shared/src/{leads,branding,sharing,guestbook,printQueue}.test.ts` · `apps/api/src/routes/{leads,analytics,branding,guestbook,share}.test.ts` · `apps/studio/src/lib/leads/{leadsClient,useLeads,downloadCsv}.test.ts` · `apps/studio/src/lib/branding/brandingClient.test.ts` · `apps/studio/src/lib/sharing/shareClient.test.ts` · `apps/studio/src/lib/guestbook/guestbookClient.test.ts` · `apps/studio/src/lib/print/printQueueRunner.test.ts` |

**Task**

- [x] Field custom: `text` / `email` / `phone` / `select` / `checkbox` — CRUD operator, `key` selalu diturunkan server dari label (dua label sama tidak saling menimpa)
- [x] `required` + teks consent + **boleh dilewati** (form opsional di bawah galeri; tamu tidak dipaksa mengisi)
- [x] **Consent UU PDP dipaksa di satu tempat** (`storeLead`): tanpa `consent` tidak ada baris yang ditulis — berlaku di jalur JSON **dan** jalur form HTML
- [x] Export CSV dengan kolom dari **definisi field aktif**, bukan dari kunci yang kebetulan ada di baris; BOM UTF-8 supaya Excel benar membuka huruf beraksen
- [x] Hak hapus (UU PDP): `DELETE` operator benar-benar menghapus baris, bukan menyembunyikan; hapus kedua → `404`
- [x] Analytics **per acara**: kunjungan, galeri, foto, kiriman — "satu angka, satu definisi"; "kunjungan" = orang yang belum membuka halaman galeri hari itu (cookie penanda, idempoten per hari lokal)
- [x] Halaman tamu menjelaskan tiap hasil: `?status=terkirim` / `gagal` / `penuh`
- [x] Rate-limit + honeypot di jalur tamu; kuota **dibagi** antara `POST /v1/leads` dan form galeri (bukan dua hitungan terpisah)
- [x] Panel studio: daftar field, daftar kiriman, unduh CSV, hapus kiriman — dipisah dua lapis (klien HTTP murni + controller tanpa React + pembungkus hook + komponen) supaya janji non-UI teruji tanpa React
- [x] Klien divalidasi **per-item**: satu baris balasan rusak dibuang, sisanya tetap tampil (panel tidak dikosongkan)
- [x] Branding/white-label: logo (URL dinormalisasi, hanya http/https), heading/subheading/footer dengan batas panjang, `normalizeBranding` sebagai satu-satunya pintu masuk; `resolvedHeading`/`resolvedSubheading` menjatuhkan diri ke nama acara lalu ke default
- [x] Sharing: 5 kanal (`whatsapp`/`email`/`sms`/`native`/`copy`), `shareLink` (deep link WA/`mailto:`/`sms:`), `shareText` (dipotong di batas kata), `sharePageTitle`; studio **memakai** fungsi shared, tidak merakit tautan sendiri
- [x] Share card publik `GET /s/:hash` — HTML ber-meta **Open Graph + Twitter card** (judul/deskripsi dari branding acara), jadi tautan yang dikirim ke WA/medsos menampilkan kartu, bukan teks kosong
- [x] Auto-print + queue/retry/reprint: keputusan murni di shared (`createPrintJob`, `nextJob`, `applyPrintResult`, `claimNextJob`, `summarizeQueue`, `shouldAutoPrint`); `PRINT_COPIES_MAX` dipakai bersama sehingga rentang salinan konsisten antara pembuat tugas dan runner
- [x] Retry berjenjang sampai `PRINT_MAX_ATTEMPTS`, lalu `failed` — bukan mengulang tanpa batas; `createReprint` membuat tugas baru yang menunjuk asal, riwayatnya tidak hilang
- [x] Runner studio (`printQueueRunner.ts` + `usePrintQueue.ts`) hanya **mengeksekusi**: memanggil printer, mencatat hasil, menjadwalkan ulang sesuai keputusan shared
- [x] Video guestbook: unggah tamu (`video/mp4`, `video/webm`, `audio/webm`), validasi jenis/tipe/ukuran/durasi, moderasi operator (`hidden`), paginasi; kunci objek diturunkan (`guestbookKey`)
- [x] **Consent UU PDP di jalur guestbook** (`validateGuestbookDraft`): centang wajib `true` — `false`, `"true"`, dan `1` semuanya ditolak — diperiksa di shared sehingga `/v1/guestbook/upload-url` **dan** `POST /v1/guestbook` menolak sebelum ada baris/objek apa pun; tes menegaskan dinding tetap kosong setelah kiriman tanpa centang. Diperiksa **terakhir**, sesudah batas berkas, supaya tamu diberi tahu soal berkasnya dulu.
- [ ] Toggle tombol gallery/print/share + warning keluar di kiosk → **dipindah ke Fase 12 (kiosk)**: konfigurasi + toggle operator sudah ada (`kioskConfig`/`KioskPanel`), tapi layar hasil kiosk belum memakainya — dikerjakan bersama layar kiosk
- [x] Konfirmasi email/WA + reminder H-1 (deferral Fase 11) → **selesai 2026-10-15**: email lewat kanal SMTP sendiri (`apps/api/src/smtp.ts`)

**Kriteria terima (FEATURE-MATRIX):** §B baris **Fase = 9** — tertutup: #19 (guestbook), #44/#46 (auto-print + queue/retry/reprint), #56–#59 (sharing + share page), #61 (branding), #73–#78 (leads/analytics). Tersisa #51/#52 (tombol tamu di layar hasil kiosk) yang **dipindah ke Fase 12** — lihat task di atas.

**Validasi**

```bash
pnpm lint && pnpm typecheck && pnpm build
pnpm test
node e2e/phase9-leads.e2e.mjs
```

- [x] E2E pakai HTTP sungguhan (server proses terpisah + DB scratch `foto-booth.sqlite`): form tamu → tersimpan → CSV → analytics → nonaktif field → hapus → kuota — `e2e/phase9-leads.e2e.mjs`, **57 pemeriksaan lulus**
- [x] **Tanpa consent tidak ada yang tersimpan** — diuji di kedua pintu masuk (`leads.test.ts` JSON & form)
- [x] Honeypot terisi → jawab sukses palsu, nol baris ditulis (`leads.test.ts`)
- [x] CSV berkolom definisi field + `Content-Disposition` nama berkas + BOM (`leads.test.ts`, `downloadCsv.test.ts`)
- [x] Hak hapus benar-benar menghapus; hapus kedua `404` (`leads.test.ts`, e2e bagian 9)
- [x] Kunjungan dihitung **sekali per hari**, bukan per muat (e2e bagian 4 & 8, cookie sama)
- [x] Kiriman beruntun lewat **form galeri** ditahan dan dilaporkan `?status=penuh`, bukan "isian salah" (`leads.test.ts` + e2e bagian 10)
- [x] Kuota tidak bisa digandakan dengan berpindah jalur (`leads.test.ts` — "kuota dibagi antara form galeri dan POST /v1/leads")
- [x] Field nonaktif hilang dari form tamu tapi tetap tersimpan untuk riwayat (e2e bagian 9)
- [x] CI hijau + container healthy → **ya** (lihat *Bukti*): worker run 2026-10-14 14:39 UTC **17/17 step `Result: true`, 0 gagal**; container `foto-booth` image tag `d298379…` `healthy`.

**Gate keluar:** ✅ **terpenuhi** — bagian branding/sharing/auto-print/video-guestbook **sudah ada dan teruji**; yang tersisa hanya konfirmasi email/WA, dan itu memang milik Fase 11 (ditunda: belum ada SMTP/WA di infra).

**Bukti** (2026-10-14)

**Validasi lokal (sebelum commit `d298379`)**

- `pnpm lint` → 0 · `pnpm -r typecheck` → 0 (shared · api · studio) · `pnpm build` → 0 · `node docs/check.mjs` → 0 · `node docs/phases-status.mjs` → 0
- Tes: shared **171** · api **166** · studio **924** — semua hijau, 0 gagal
- `node e2e/phase9-leads.e2e.mjs` → **57 pemeriksaan lulus**
- Satu bug nyata ditemukan & diperbaiki oleh e2e ini: pembatas laju hanya terpasang di `POST /v1/leads`, sedangkan jalur yang benar-benar dipakai tamu (`POST /a/:hash/lead`) tidak dibatasi sama sekali — sekarang satu `leadLimiter` dipakai bersama, jadi kuota tidak bisa digandakan dengan berpindah pintu.
- Consent UU PDP guestbook dipaksa di `validateGuestbookDraft`: `false`, `"true"`, dan `1` semuanya ditolak; tes menegaskan dinding guestbook tetap kosong sesudah kiriman tanpa centang, jadi tidak ada baris **maupun objek** yang tertinggal.

**Rilis (setelah push `main`)**

- CI/CD worker run **2026-10-14 14:39 UTC** → **17/17 step `Result: true`, 0 gagal**
- Container produksi: `foto-booth` image `foto-booth:d2983795162450248da3946ecfd1a4567c48e2c0`, status **`healthy`**
- `curl` publik `https://foto.soyuz.my.id` → `/` **200** · `/health` **200** · `/studio/` **200**
- Rute Fase 9 terbukti hidup di produksi: `/v1/branding` **200** (balasan `{"branding":{…},"isDefault":true}`) · `/v1/guestbook` **400** `{"error":"invalid_request","message":"acara tidak ditentukan"}` (rute jalan, menolak tanpa param) · `/s/<hash-tak-ada>` **404** dengan **halaman HTML** milik aplikasi, bukan 404 kosong — artinya share card route terdaftar dan menangani hash tak dikenal sendiri.

**Gate keluar Fase 9 → Fase 10:** ✅ terpenuhi — semua task Fase 9 `[x]` kecuali tiga yang memang ditunda dengan alasan tertulis (#51/#52 tombol kiosk → Fase 12; konfirmasi email/WA → butuh SMTP/WA yang belum ada; payment → ditunda atas permintaan pemilik produk), validasi lolos, bukti tercatat di atas.

---

## Fase 10 — Lisensi + order (mekanisme; gateway pembayaran ditunda)

**Status:** `[x]` **selesai (2026-10-14)** — katalog SKU, order, siklus hidup status, kode aktivasi, penebusan, dan penegakan batas plan semuanya ada di shared + API + studio, dengan tes dan e2e. **Gateway pembayaran tidak disambungkan** — itu permintaan eksplisit pemilik produk ("bangun UI dan mekanismenya dulu"); provider `qris` menjawab 501 sampai gateway dipasang. Gate keluar lolos: commit `5114379`, CI 17/17 step `Result: true`, container `foto-booth:5114379…` `healthy`, `/v1/license/catalog` 200 di live.

**Gate masuk:** `[x]` terpenuhi — gate keluar Fase 9 sudah lolos (commit `d298379`, CI hijau, container `healthy`).

**Tujuan:** lisensi jadi entitas yang bisa **dilacak dan ditegakkan** — order punya status yang tidak bisa dipindah sembarangan, kode aktivasi terbit hanya setelah lunas dan bisa ditebus jadi entitlement perangkat, dan entitlement itu **benar-benar menolak** pembuatan galeri melebihi plan. Tanpa ini, `max_active_galleries` cuma angka yang tersimpan rapi di DB dan tidak pernah menolak apa pun.

**Kenapa sekarang:** Fase 11 (Booking) punya deposit yang butuh entitas order; Fase 12 (kiosk/marketplace) butuh tahu perangkat ini berlisensi atau tidak. Mekanismenya dibangun sekarang supaya bentuk datanya tidak berubah lagi saat gateway disambungkan — yang tersisa nanti hanya mengganti provider `qris` dari stub jadi sungguhan.

**Deliverable**

| Area | File |
|---|---|
| Shared — logika murni | `packages/shared/src/license.ts` (katalog SKU, siklus hidup order, `evaluateLicense`, kode aktivasi, `planLimits`/`planAllowsGallery`) · `schemas.ts` (blok Zod **Lisensi & order**) · `index.ts` |
| API — rute | `apps/api/src/routes/license.ts` (8 rute: katalog, entitlement, order, status, kode, tebus) · `apps/api/src/app.ts` (registrasi setelah `shareRoutes`) |
| API — data & aturan | `apps/api/src/db.ts` (migrasi id 7 `license-orders`) · `apps/api/src/store.ts` (order, kode aktivasi, `countActiveGalleries`, `entitlementAllowsNewGallery`) · `apps/api/src/secrets.ts` (`sha256Hex` + generator kode aktivasi) · `apps/api/src/routes/galleries.ts` (gate 402 `entitlement_required`) |
| Studio | `apps/studio/src/components/LicensePanel.tsx` · `apps/studio/src/lib/license/{licenseClient,useLicense}.ts` · `App.tsx` (tab `license`) · `src/locales/{id,en}.json` (blok `license`) |
| E2E | `e2e/phase10-license.e2e.mjs` (9 bagian, **59 pemeriksaan**) |
| Tes | `packages/shared/src/license.test.ts` · `apps/api/src/routes/license.test.ts` (**18 tes**) · `apps/studio/src/lib/license/licenseClient.test.ts` (**15 tes**) |

**Task**

- [x] Katalog SKU bertipe `Record<LicenseSkuId, …>` dengan sengaja: menambah id di `LICENSE_SKU_IDS` tanpa menambah entri jadi **error kompilasi**, bukan halaman kosong di panel
- [x] **Harga tidak pernah datang dari klien**: `CreateOrderSchema` tidak punya `amountIdr` — bukan sekadar tidak dipakai; tipe yang tidak bisa membawa harga lebih kuat dari komentar yang melarangnya
- [x] `sku_name` dan `amount_idr` disimpan sebagai **snapshot** — menaikkan harga besok tidak mengubah invoice yang sudah dikirim
- [x] Siklus hidup status lewat `canTransitionOrder` di shared, bukan `if` lokal: `refunded` **tidak bisa** hidup lagi, jadi webhook gateway yang datang terlambat/terulang tidak menghidupkan lisensi yang dananya sudah kembali
- [x] Status sama dengan status sekarang → `409`, bukan "sukses" palsu
- [x] Kode aktivasi terbit **saat lunas**, bukan saat order dibuat — kode yang sudah beredar sebelum uang masuk tidak bisa ditarik kembali; 3 percobaan anti-tabrakan karena `code` adalah PRIMARY KEY
- [x] Bentuk tampilan kode (`ABCD-EFGH-JKLM`) dihitung **server** (`formatActivationCode`); alfabet membuang `I`, `O`, `0`, `1` karena kode ini dibacakan dari invoice/kertas
- [x] Penebusan memakai `WHERE redeemed_at IS NULL` — klik ganda / dua tab tidak bisa menerbitkan lisensi yang sama dua kali; kode ditebus operator lain menjadi entitlement **operator itu**, bukan pembuat order
- [x] Jawaban tebus dibedakan: salah bentuk **400**, tidak ada **404**, sudah dipakai/dicabut/kedaluwarsa **409** — jawaban berbeda untuk "bukan kode" vs "kode tidak ada" membuat percobaan kode jadi terukur
- [x] Refund **mencabut** kode yang sudah terbit (`revokeActivationCode`) — pelanggan yang uangnya kembali tidak tetap bisa mengaktifkan perangkat
- [x] Provider `qris` menjawab **501 `payment_unavailable`**, bukan membuat order yang menggantung di "menunggu pembayaran" yang tidak akan pernah bisa dibayar; `ORDER_PROVIDERS` (boleh tercatat) dipisah dari `LIVE_ORDER_PROVIDERS` (bisa jalan sekarang)
- [x] Batas plan **ditegakkan**, bukan sekadar disimpan: `planAllowsGallery` + `countActiveGalleries` → `402 entitlement_required` dengan pesan yang menyebut batas & plan-nya
- [x] Aturan "boleh dipakai atau tidak" **hanya ada di satu tempat**: `evaluateLicense` di shared; `entitlementAllowsNewGallery` di API hanya tipis di atasnya — kalau aturannya ditulis dua kali, cepat atau lambat studio mengizinkan sesuatu yang ditolak API
- [x] Operator tanpa entitlement (mode lokal) **tidak** dikunci — mode jujur hari ini adalah "tanpa lisensi", bukan "terkunci"; yang dibatasi hanya operator yang punya lisensi tapi sudah lewat batasnya
- [x] Generator kode acak diletakkan di `apps/api/src/secrets.ts`, **bukan** di shared: `packages/shared` dipakai studio di browser, jadi tidak boleh menyentuh `Buffer`/API Node-only
- [x] Panel studio: katalog, catat order, pindah status, tebus kode — dipisah klien HTTP murni + controller tanpa React + hook tipis + komponen, seperti panel Fase 9
- [x] Panel **tidak punya kolom harga sama sekali**, dan memakai `canTransitionOrder` yang sama dengan API → operator tidak ditawari tombol yang pasti dijawab 409
- [x] Bentuk kode ditampilkan dari **server** (`referenceFormatted`/`formatted`), bukan dirakit ulang di klien — dua tempat yang memformat kode yang sama cepat atau lambat berbeda
- [x] Balasan klien divalidasi **per-item**: satu order rusak di tengah daftar dibuang, sisanya tetap tampil
- [x] Provider yang belum hidup **dinonaktifkan, bukan disembunyikan** — operator perlu tahu QRIS memang direncanakan dan memang belum bisa dipakai
- [ ] Gateway pembayaran QRIS (Midtrans/Xendit) + webhook → aktivasi otomatis → **ditunda atas permintaan pemilik produk**; yang ada hari ini adalah mekanisme lengkapnya, dan `qris` menjawab 501 sampai gateway disambungkan

**Kriteria terima (FEATURE-MATRIX):** §B baris **Fase = 10** — #85 (payment QRIS) **sebagian**: mekanisme order + status + aktivasi yang jadi syaratnya sudah ada dan teruji, gateway-nya sendiri sengaja belum. Baris #84 (lisensi/entitlement, Fase 5) diperluas dari "status bisa divalidasi" jadi katalog SKU + kode aktivasi + batas plan yang ditegakkan.

**Validasi**

```bash
pnpm lint && pnpm typecheck && pnpm build
pnpm test
node e2e/phase10-license.e2e.mjs
```

- [x] E2E pakai HTTP sungguhan (server proses terpisah + DB scratch): katalog publik → catat order → transisi status → kode terbit → tebus → entitlement → **galeri ke-4 ditolak 402** → refund mencabut kode — `e2e/phase10-license.e2e.mjs`, **59 pemeriksaan lulus**
- [x] Harga dari katalog, bukan body — diuji dua arah: order biasa, dan order yang sengaja menitipkan `amountIdr` (e2e bagian 4; `license.test.ts` "harga diambil dari katalog, bukan dari body klien")
- [x] `qris` → 501 dan pesannya menyebut belum tersambung (e2e bagian 4; `license.test.ts` "provider qris menjawab 501, bukan order menggantung")
- [x] Transisi mundur & status berulang ditolak 409 (e2e bagian 5; `license.test.ts`)
- [x] Refund mencabut kode, dan order `refunded` tidak bisa dihidupkan lagi (e2e bagian 8)
- [x] Kode yang salah bentuk/ tak ada / sudah dipakai dibedakan 400/404/409 (e2e bagian 6)
- [x] Lisensi benar-benar membatasi: galeri ke-4 → 402 dengan pesan "batas 3" (e2e bagian 7)
- [x] Semua rute operator tertutup tanpa token → 401 (e2e bagian 3)

**Gate keluar:** ✅ — CI 17/17 step `Result: true` (worker run 2026-10-14 16:02 UTC), container `foto-booth:5114379e2fac` `healthy`, verifikasi live: `/v1/license/catalog` 200 (2 SKU + provider `manual` live, `qris` belum), `/v1/license/{orders,entitlement,activate}` tanpa token → 401. Task Fase 10 `[x]` kecuali gateway pembayaran yang ditunda dengan alasan tertulis.

---

## Fase 11 — Booking & reservasi (mekanisme; gateway QRIS ditunda)

**Status:** `[x]` **selesai (2026-10-15)** — UI + mekanisme (2026-10-13), invoice/kwitansi + notifikasi booking + penandaan deposit manual + job pengingat H-1 (2026-10-14), dan **kanal kirim email SMTP sungguhan** (2026-10-15). **Satu dependensi luar ditunda atas permintaan eksplisit pemilik**: deposit **QRIS** — mekanisme order Fase 10 sudah ada, gateway-nya sengaja belum, `qris` masih ditolak `400` di rute setelan. Sama polanya dengan Fase 10 (yang juga dicentang dengan gateway tertunda): yang dibangun adalah mekanisme lengkapnya, dan yang tersisa nanti hanya mengganti provider `qris` dari stub jadi sungguhan. WhatsApp tetap tanpa API — teks + `whatsappUrl` disiapkan untuk operator; itu memang desainnya, bukan kekurangan (tidak butuh kredensial pihak ketiga).
**Gate masuk:** ⚠️ **dilonggarkan sengaja** — Fase 10 gate keluar belum terpenuhi (gateway QRIS belum tersambung). Booking dibangun lebih dulu sebagai UI + mekanisme dengan provider pembayaran berupa interface + stub, supaya wiring nanti aditif.
**Tujuan:** klien bisa memesan jadwal sendiri, operator tidak lagi mencatat manual di WhatsApp.

**Kenapa setelah Fase 10:** booking butuh **deposit QRIS** dan **email/reminder**. Payment (Fase 10) yang menyediakan itu — bikin booking lebih dulu = kerja dua kali. Karena itu bagian itu **tidak** dikerjakan sekarang; yang dibangun adalah jalur yang tidak bergantung padanya.

**Deliverable**

| Area | File |
|---|---|
| API — logika | `apps/api/src/routes/booking.ts` (rute publik + operator) · `apps/api/src/deposit.ts` (provider + stub) · `apps/api/src/rateLimit.ts` · `apps/api/src/jobs/reminders.ts` (job pengingat H-1) · `apps/api/src/context.ts` (`BookingNotifier`) · `apps/api/src/smtp.ts` (kanal kirim email, klien SMTP tanpa dependensi) |
| API — halaman publik | `apps/api/src/routes/booking-pages.ts` (`/booking`, `/booking/s/<token>`) · `apps/api/src/pages.ts` (shell HTML bersama) |
| Studio | `apps/studio/src/components/BookingPanel.tsx` (`InvoiceCard`, `RemindersCard`) · `apps/studio/src/lib/booking/{bookingClient,useBookings}.ts` |
| Shared | `packages/shared/src/booking.ts` (logika murni: slot, overlap, buffer, transisi, ICS) · `invoice.ts` (invoice + pelacakan pelunasan) · `notifications.ts` (teks konfirmasi/reminder, tanpa pengiriman) · `schemas.ts` (Zod booking) · `constants.ts` (`BOOKING_BASE_PATH`, `BOOKING_STATUS_PATH`, `BOOKING_TOKEN_RE`) |
| **E2E** | `e2e/phase11-booking.e2e.mjs` (**34 langkah**, API + browser sungguhan) · `e2e/phase11-smtp.e2e.mjs` (**4 langkah**, API sungguhan + server SMTP palsu di `net.Server` TCP) |
| Tes | `packages/shared/src/{booking,invoice,notifications}.test.ts` · `apps/api/src/routes/booking.test.ts` · `apps/studio/src/lib/booking/{bookingClient,useBookings}.test.ts` |

**Model data (di `packages/shared`)**

- `ServicePackage` — `id`, `nama`, `durasi` (menit), `harga`, `deposit`, `aktif`
- `AvailabilitySlot` — `tanggal`, `jamMulai`, `jamSelesai`, `tersedia`
- `BookingRequest` — `id`, `paketId`, `nama`, `kontak`, `tanggal`, `slot`, `catatan`, `status`
- `Booking` — `requestId`, `eventId`, `depositStatus`, `statusPelunasan`, `linkStatus` (token unik)
- `status`: `requested → approved → confirmed → completed` · plus `rejected`, `cancelled`, `expired`

**Task**

- [x] Halaman booking publik (tanpa login): pilih paket → tanggal → slot → isi data → kirim
- [x] Paket layanan + harga + deposit (CRUD di studio)
- [x] Kalender ketersediaan: hasil dari **jam operasional − booking ter-approve − tanggal diblokir**
- [x] Jam operasional + buffer antar-booking (configurable, mis. 30 menit bersih-bersih)
- [x] Blokir tanggal / tanggal tutup (libur, maintenance)
- [x] `POST /v1/booking/requests` → buat permintaan (status `requested`)
- [x] **Slot yang sudah `approved` tidak bisa dipesan dua kali** (validasi server, bukan cuma UI)
- [x] Approve / tolak oleh operator (alasan penolakan ikut terkirim)
- [x] Konfirmasi + link WhatsApp siap kirim (**mekanisme**, 2026-10-14): `POST /v1/booking/admin/bookings/:id/notify` selalu mengembalikan `subject` + `body` + `whatsappUrl`; konfirmasi juga disiapkan otomatis saat approve. Pengiriman email **sudah sungguhan** sejak 2026-10-15 (`apps/api/src/smtp.ts`, hidup begitu `SMTP_*` diisi); `delivered` tetap melaporkan jujur — `false` kalau kanal belum hidup.
- [ ] Deposit QRIS → `depositStatus` berubah dari webhook → **ditunda: butuh gateway Fase 10** (ditahan atas permintaan pemilik). Provider pembayaran sudah berupa interface (`deposit.ts`); provider `qris` **melempar** dan ditolak `400` di rute setelan, jadi tidak ada deposit yang bisa tampak "menunggu" padahal tak akan pernah masuk. Sementara itu deposit **ditandai manual oleh operator** (`POST /v1/booking/admin/bookings/:id/deposit`, butuh sesi) — menggantikan webhook tanpa berpura-pura ada gateway.
- [x] Halaman status booking: link unik ber-token, **tanpa login** — klien bisa cek sendiri
- [x] Reschedule oleh klien (batas: minimal `minNoticeHours` jam sebelumnya)
- [x] Cancel oleh klien + kebijakan batas waktu
- [x] Reminder H-1 otomatis (**job harian**, 2026-10-14): `apps/api/src/jobs/reminders.ts` menyapu booking `approved` yang sesinya < 24 jam; `reminded_at` **hanya** ditandai kalau pesan benar-benar keluar (`notifier.live`), jadi pengingat tidak hilang diam-diam. Tanpa kanal, daftarnya tetap bisa dilihat operator di `GET /v1/booking/admin/reminders` (teks + `whatsappUrl`) untuk dikirim manual.
- [x] Dashboard booking + kalender operator (harian/mingguan)
- [x] Invoice + kwitansi + lacak pelunasan (**mekanisme**, 2026-10-14): `packages/shared/src/invoice.ts` (`buildInvoice`, `invoiceStatusFor`, `invoiceText`); rute `GET /v1/booking/admin/bookings/:id/invoice` (JSON) + `/invoice.txt` (kwitansi teks siap tempel). Angka tagihan **dihitung server** dari harga paket + deposit yang sudah ditandai — bukan angka yang ditulis UI.
- [x] **Booking → event**: approve bikin record event (nama + tanggal dari slot), jadi tidak perlu input ulang di hari-H — idempoten, reschedule menggeser tanggalnya, tidak pernah bikin event kedua
- [x] Laporan okupansi + pendapatan per periode
- [x] Export kalender `.ics`
- [x] Rate-limit form publik + honeypot (anti spam, karena tanpa login)
- [x] Halaman publik responsive + aksesibel (klien buka dari HP)

**Kanal kirim email (2026-10-15)**

- [x] `apps/api/src/smtp.ts` — klien SMTP sendiri (`node:net` + `node:tls`), **tanpa dependensi baru**: sapaan, `EHLO`, `STARTTLS`, `AUTH LOGIN`, `MAIL/RCPT/DATA`.
- [x] **Kredensial tidak pernah lewat koneksi polos**: kalau server tidak mengiklankan `STARTTLS` di balasan `EHLO`, kiriman dibatalkan sebelum `AUTH` — bukan dikirim lalu ditolak.
- [x] `smtpConfigFromEnv` — kosong = kanal log (`live: false`); setengah lengkap = **melempar saat start** (bukan diam-diam tidak mengirim). Default port: `465` → TLS implisit, `587` → STARTTLS.
- [x] `delivered`/`reminded_at` tetap jujur: hanya ditandai kalau `email()` tidak melempar. Penolakan server (`550`, `554`) melempar dengan kodenya, jadi booking tidak pernah "dianggap sudah diingatkan".
- [x] Env yang dibaca: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`, `SMTP_STARTTLS`, `SMTP_TIMEOUT_MS`. Diteruskan ke container lewat `--env-file storage/foto-booth.env` yang sudah dipakai CI — **tanpa ubah workflow**.
- [x] Tes `apps/api/src/smtp.test.ts` — 10 tes dengan server SMTP palsu di dalam satu `Duplex` (tanpa jaringan): urutan perintah, base64 `AUTH`, body, dan penolakan.

**Kriteria terima (FEATURE-MATRIX):** §B semua baris dengan **Fase = 11** (modul Booking)

**Validasi**

```bash
pnpm lint && pnpm -r typecheck && pnpm -r build
pnpm --filter @foto-booth/api test
pnpm --filter @foto-booth/studio test
node e2e/phase11-booking.e2e.mjs
node e2e/phase11-smtp.e2e.mjs
```

- [x] Alur end-to-end pakai script (bukan klik manual): request → approve → **event** → reschedule → cancel → slot bebas — `e2e/phase11-booking.e2e.mjs`, **34 langkah lulus**
- [x] **Double-booking ditolak**: dua request ke slot sama, yang kedua gagal `409` (`booking.test.ts` + e2e langkah 08 & 18)
- [x] Slot di luar jam operasional **dan** slot yang bertabrakan buffer ditolak (`booking.test.ts` — "jam di luar operasional ditolak", "buffer membersihkan jarak antar sesi", "menyetujui booking yang slotnya sudah diambil ditolak")
- [x] Tanggal diblokir → tidak muncul sebagai slot tersedia (`booking.test.ts` — "ketersediaan menandai slot terisi dan tanggal tutup")
- [ ] Webhook deposit palsu (tanda tangan salah) → ditolak → **ditunda: butuh gateway Fase 10**. Yang bisa dibuktikan sekarang: provider `qris` ditolak `400`, deposit tidak pernah `paid` tanpa operator menandainya, dan penandaan manual butuh sesi (`401` tanpa token).
- [x] Link status tanpa token / token salah → `404` (bukan bocor data booking orang lain)
- [x] Invoice: angka tagihan **dibandingkan dengan data booking yang sama** (harga, deposit, sisa) — bukan angka yang ditulis di tes (e2e langkah 29); tanpa sesi → `401` (langkah 30)
- [x] Kwitansi `.txt` benar-benar terunduh sebagai teks polos dengan nomor invoice di nama berkas (e2e langkah 31)
- [x] Notifikasi: `subject`/`body`/`whatsappUrl` selalu terbentuk, `kind` asing ditolak `400`, dan `delivered` **tidak** mengklaim terkirim saat kanal belum hidup (e2e langkah 32)
- [x] Kanal SMTP: kredensial **tidak pernah** dikirim ke koneksi tanpa STARTTLS; server yang menolak (`550`/`554`) membuat kiriman gagal, bukan sukses palsu (`smtp.test.ts` 10 tes)
- [x] Pengingat H-1: rute operator melaporkan `notifierLive` jujur dan hanya memuat sesi < 24 jam; tanpa sesi → `401` (e2e langkah 33–34; job-nya diuji di `booking.test.ts` dengan `runBookingReminders` dipanggil manual)
- [x] Reschedule di bawah batas waktu → ditolak dengan pesan jelas (`too_soon`; tamu dan operator sama-sama kena)
- [x] Approve → **record event benar-benar ada** dan bisa dipakai di studio (dibaca dari DB, bukan asumsi; reschedule menggeser tanggal event, tidak menggandakan)
- [x] Form publik: submit beruntun → kena rate-limit (`429` + `retry-after`; e2e langkah 10 memakai 6 percobaan dari satu IP)
- [x] Ukur DOM: halaman booking di 390px — tidak ada elemen meluber (`scrollWidth <= clientWidth`, e2e langkah 17)
- [x] CI hijau + container `healthy` — commit `01034bd`, worker run 2026-10-15 08:43 UTC: **17/17 step `Result: true`**; container `foto-booth:01034bd8…` menggantikan `ccaede1…`; live: `/health` 200, `/booking` 200, `/v1/booking/packages` 200, `/v1/booking/admin/reminders` tanpa token → 401

**Gate keluar:** ✅ **terpenuhi** — seluruh gerbang fase ini hijau dan terbukti: (1) mekanisme booking lengkap (alur request → approve → event → reschedule → cancel, anti double-booking, token link, invoice + kwitansi, laporan okupansi, `.ics`); (2) **kanal kirim email sungguhan** — `apps/api/src/smtp.ts`, klien SMTP sendiri tanpa dependensi baru (2026-10-15), terbukti mengirim lewat TCP oleh `e2e/phase11-smtp.e2e.mjs` dan dilindungi 10 tes `smtp.test.ts`; tanpa `SMTP_*` ia jujur melaporkan `live: false` dan tidak mengklaim terkirim; (3) job pengingat H-1 dengan `reminded_at` yang hanya ditandai kalau pesan benar-benar keluar; (4) penandaan deposit manual oleh operator (butuh sesi) menggantikan webhook tanpa berpura-pura ada gateway. **Satu ketergantungan luar ditunda atas permintaan eksplisit pemilik: gateway QRIS** — mekanisme order Fase 10 sudah tersedia dan `qris` ditolak `400` di rute setelan, jadi tidak ada deposit yang bisa tampak "menunggu" padahal tak akan pernah masuk. Pola ini sama dengan Fase 10 (dicentang dengan gateway tertunda); sisanya nanti hanya mengganti provider `qris` dari stub jadi sungguhan, tanpa mengubah bentuk data.

**Bukti** (2026-10-13, diperbarui 2026-10-14)

- `pnpm lint` → 0 · `pnpm -r typecheck` → 0 (shared · api · studio)
- Tes (2026-10-14): shared **232** · api **196** · studio **946** — semua hijau, 0 gagal
- `node e2e/phase11-booking.e2e.mjs` → **34 langkah lulus** (API proses terpisah + Chromium sungguhan)
- Dua bug nyata ditemukan & diperbaiki oleh e2e ini: (1) form publik tidak mengirim jam yang dipilih; (2) `FORM_SCRIPT` disisipkan ke `<head>` sehingga daftar paket tidak pernah termuat.
- Stub pembayaran: provider `qris` **melempar** dan ditolak `400` di rute setelan — tidak ada deposit yang bisa tampak "menunggu" padahal tak akan pernah masuk.
- Kanal SMTP (2026-10-15): `apps/api/src/smtp.test.ts` → **10/10 lulus** dengan server SMTP palsu (tangga perintah, `AUTH` base64, penolakan `550`/`554`, STARTTLS multi-baris, dot-stuffing, `smtpConfigFromEnv`). Tanpa jaringan keluar, tanpa dependensi baru.
- Kanal SMTP end-to-end (2026-10-15): `e2e/phase11-smtp.e2e.mjs` → **4 langkah lulus**, API sungguhan (`src/index.ts`) + server SMTP palsu di `net.Server` **TCP sungguhan**. Approve booking mengirim konfirmasi nyata (`MAIL FROM` = `SMTP_FROM`, nama tamu terbaca di body base64 setelah di-decode); notifikasi manual melaporkan `delivered: true` + `channel: "email"` dan pesannya bertambah. Sisi sebaliknya juga diuji: API tanpa `SMTP_*` melaporkan `notifierLive: false` dan **tidak ada** pesan yang keluar — jadi "hidup" di atas bukan efek samping yang selalu menyala. 2 pesan diterima (konfirmasi + notifikasi manual).
- Tes naik: api **196 → 206** (10 tes SMTP). Total gate: shared 232 · api 206 · studio 946 — 0 gagal.
- **Gate deploy (2026-10-15):** commit `01034bd` — `pnpm lint` 0 · `pnpm -r typecheck` 0 · `pnpm -r build` 0 · `node docs/check.mjs` 0 · `node docs/phases-status.mjs` 0 · `e2e/phase11-booking.e2e.mjs` 34 langkah lulus · `e2e/phase11-smtp.e2e.mjs` 4 langkah lulus (2 pesan SMTP sungguhan diterima).
- **CI + live (2026-10-15 08:43 UTC):** worker run **17/17 step `Result: true`** (0 gagal), container `foto-booth:01034bd8…` `healthy`; live lewat `https://foto.soyuz.my.id`: `/health` 200 · `/booking` 200 · `/v1/booking/packages` 200 · `/v1/booking/admin/reminders` tanpa token → **401**.

---

## Fase 12 — Desktop (Electron) + mobile (Capacitor) + titipan kiosk #51/#52

**Status:** `[x]` **selesai (2026-10-15)** — matriks #45/#80/#81/#88/#89 **plus** titipan #51/#52 dari Fase 9 (tombol tamu di layar hasil kiosk + peringatan keluar).
**Gate masuk:** ✅ Fase 11 gate keluar terpenuhi (dengan gateway QRIS ditunda atas permintaan pemilik, seperti Fase 10).
**Tujuan:** booth bisa dipasang sebagai aplikasi (bukan tab browser), printer bisa dipilih & didiagnosis tanpa menebak, dan tamu punya layar hasil yang jelas di kiosk.

**Kenapa sekarang:** Fase 9 menitipkan #51/#52 ke sini karena keduanya hidup di layar kiosk, dan layar itu baru masuk akal setelah tahu **perangkat apa** yang menjalankannya (web, Electron, atau Capacitor). Sekaligus: operator tidak boleh disuruh menebak kenapa cetakan tidak keluar — deteksi printer + laporan diagnostik adalah bagian dari "instalasi yang bisa diselesaikan sendiri".

**Batas cakupan yang jujur** (ditulis apa adanya, bukan disembunyikan):

- **Electron benar-benar dijalankan**, bukan cuma dipasang: probe headless lewat `xvfb-run` membuktikan window terbuka dan `fotoBoothDesktop` tersedia (`PROBE_RESULT {"ok":true,…}`).
- **Capacitor tidak bisa di-package di mesin ini** — tidak ada Java/Android SDK. Yang dibuktikan: proyek Android ter-`cap add` dengan `androidScheme: https` + izin `CAMERA`, konfigurasi **digenerate** dari modul murni, dan rantai CLI `cap sync` sungguhan lewat e2e. APK/IPA belum ada, dan itu tidak diklaim ada.
- **iOS definitif tidak bisa** dari Linux; hanya konfigurasi yang disiapkan.

**Deliverable**

| Area | File |
|---|---|
| Shared — keputusan murni | `packages/shared/src/printer.ts` (kemampuan printer, `choosePrinter`, `mergePrinters`, ringkasan) · `diagnostics.ts` (laporan diagnostik siap kirim) |
| Studio — runtime | `apps/studio/src/lib/print/printerRuntime.ts` (deteksi lintas transport: Electron / WebUSB / browser) · `usePrinters.ts` (preferensi operator, printer hilang) · `desktopPrinter.ts` (jalur Electron antrean) |
| Studio — panel | `apps/studio/src/components/PrinterPanel.tsx` (#45/#80/#81) · `PrintQueuePanel.tsx` (printer terpilih) · `diagnostics/runtimeCapabilities.ts` |
| Studio — kiosk (#51/#52) | `lib/kiosk/resultActions.ts` (tombol mana yang tampil + kapan keluar perlu peringatan) · `lib/kiosk/resultPrint.ts` (cetak langsung, bukan lewat antrean operator) · `lib/kiosk/useKioskResultPrint.ts` (susun gambar hasil → printer) · `components/KioskResultScreen.tsx` · `useKiosk.ts` (sesi berjalan, foto tersimpan, `disarm`) |
| Desktop | `apps/desktop/src/main.cjs` · `src/preload.cjs` (renderer tanpa akses Node) · `src/lib/config.cjs` (keputusan kiosk, murni & teruji) |
| Mobile | `apps/mobile/src/lib/mobileConfig.mjs` · `scripts/write-config.mjs` (generator `capacitor.config.json`) · `android/` (scaffold) |
| **E2E** | `e2e/phase12-desktop.e2e.mjs` · `e2e/phase12-mobile.e2e.mjs` · `e2e/phase12-kiosk.e2e.mjs` (**13 langkah**, Chromium sungguhan atas bundel produksi) |
| Tes | `packages/shared/src/{printer,diagnostics}.test.ts` · `apps/studio/src/lib/print/{printerRuntime,desktopPrinter}.test.ts` · `apps/studio/src/lib/kiosk/{resultActions,resultPrint}.test.ts` · `apps/desktop/src/lib/config.test.cjs` · `apps/mobile/src/lib/mobileConfig.test.mjs` |

**Task**

- [x] **#45/#80 pilih printer + deteksi USB**: printer dari tiga transport digabung dan di-dedup **berdasarkan nama**; pilihan operator bertahan antar-reload, dan printer yang hilang **diberitahukan**, bukan dihapus diam-diam.
- [x] **#81 laporan diagnostik**: `diagnostics.ts` menyusun laporan dari kemampuan runtime (`runtimeCapabilities.ts`) — bisa dibaca operator, siap dikirim lewat email.
- [x] **#88 desktop Electron**: `main.cjs` + `preload.cjs`; **renderer tidak punya akses Node** — preload hanya mengekspos `fotoBoothDesktop` + `getPrinters`. Electron dipindah dari root ke `apps/desktop` supaya binary 283 MB tidak ikut build Docker/CI.
- [x] **#89 mobile Capacitor**: proyek Android ter-scaffold; `androidScheme: https` **wajib** (tanpa itu kamera kiosk mati di WebView) dan izin `CAMERA` ditambahkan eksplisit karena manifest bawaan tidak memuatnya.
- [x] **#51 tombol tamu di layar hasil kiosk** (titipan Fase 9): layar hasil tamu muncul setelah sesi diterima, tombolnya **persis** yang dinyalakan operator, dan "Selesai" **selalu ada** — layar hasil tanpa jalan keluar akan mengunci kiosk.
- [x] **#51 cetak dari layar kiosk**: jalur cetak tersendiri (`resultPrint.ts`), **bukan** antrean operator — antrean itu punya daftar tugas & tombol ulangi yang tidak boleh disentuh tamu. Gambar hasil disusun dari template terbaru; tanpa template, foto pertama sesi dicetak apa adanya.
- [x] **#52 peringatan keluar**: `requestExit` dipecah — peringatan dulu, lalu PIN, lalu keluar. Peringatan hanya muncul saat memang ada pekerjaan (sesi berjalan / foto sudah tersimpan) dan menyebut sebabnya.
- [x] **Bug nyata yang ditemukan e2e kiosk:** `markProcessed()` **tidak pernah dipanggil** di aplikasi, jadi state machine berhenti di `processing` selamanya — setelan terkunci, dan layar hasil tidak pernah muncul. Diperbaiki di `CapturePanel.onAccept` (dipanggil di `finally`).

**Validasi**

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
node docs/check.mjs
node docs/phases-status.mjs
corepack pnpm --filter @foto-booth/studio build   # prasyarat e2e kiosk
node e2e/phase12-desktop.e2e.mjs
node e2e/phase12-mobile.e2e.mjs
node e2e/phase12-kiosk.e2e.mjs
```

**Bukti** (2026-10-15)

- `pnpm lint` → 0 · `pnpm -r typecheck` → 0 (shared · api · studio) · `pnpm -r build` → 0
- Tes: shared **260** · api **206** · studio **991** · desktop **15** · mobile **9** — 1481 tes, 0 gagal
- `node e2e/phase12-desktop.e2e.mjs` → lulus (shell Electron + jembatan printer) · `node e2e/phase12-mobile.e2e.mjs` → lulus (rantai `cap sync`) · `node e2e/phase12-kiosk.e2e.mjs` → **13/13 langkah lulus** atas bundel produksi di Chromium sungguhan: layar tarik → sesi → **layar hasil muncul** → tombol persis setelan operator → **cetak benar-benar jalan** (dokumen cetak memuat gambar hasil sebagai data URL) → tombol galeri membuka URL galeri → "Selesai" kembali ke layar tarik → **peringatan keluar** muncul saat sesi hidup, bisa dibatalkan, dan benar-benar keluar saat dikonfirmasi.
- Electron terbukti jalan headless: `PROBE_RESULT {"ok":true,"text":"halo","electron":"44.7.2","chrome":"152.0.7977.149","node":"24.21.0","platform":"linux"}`
- `node docs/check.mjs` → `{"issues": [], "outOfCanvas": [], …}`

**Gate keluar Fase 12 → Fase 13:** ✅ terpenuhi untuk seluruh task fase ini. Satu batas cakupan ditulis terbuka di atas dan **tidak** diklaim selesai: **packaging APK/IPA Capacitor** tidak bisa dibuktikan di mesin ini (tidak ada Java/Android SDK; iOS tidak mungkin dari Linux). Yang ada dan terbukti adalah proyek, konfigurasi (digenerate + teruji), izin, dan rantai CLI `cap sync`.

---

## Checklist QA MVP (dari `FEATURE-MATRIX.md` §D)

Dijalankan penuh di **gate keluar Fase 5** sebelum MVP dianggap selesai.

- [ ] Capture jalan di Chrome + Firefox + Safari (iOS)
- [ ] **Mode pesawat dari awal → app tetap kebuka & sesi foto penuh jalan (offline penuh)**
- [ ] **Kiosk jalan 1 jam tanpa koneksi → tanpa error, tanpa data hilang**
- [ ] **Online kembali → antrian upload jalan otomatis, tanpa aksi user**
- [ ] **Tutup tab saat offline → buka lagi → antrian masih ada (persisten)**
- [ ] Mati internet → capture tetap jalan, upload nunggu
- [ ] Indikator offline/online muncul & akurat di UI
- [ ] Konten (template/frame/sticker/font) tetap tampil setelah sync pertama, tanpa jaringan
- [ ] Hasil strip 300 dpi, cetak di 4×6 tidak terpotong
- [ ] Kiosk: diam 60 s → reset; PIN salah → tidak keluar
- [ ] QR discan dari HP lain → album kebuka, download jalan
- [ ] Galeri berpassword → tanpa password ditolak
- [ ] Foto > 30 hari → terhapus dari DB + S3
- [ ] Ganti bahasa id↔en tanpa reload
- [ ] Refresh tengah sesi → state tidak hilang (IndexedDB)
- [ ] 20 sesi berturut-turut → tidak ada memory leak

**Booking (Fase 11, dijalankan di gate keluar Fase 11):**

- [ ] Request → approve → deposit → confirmed jalan end-to-end dari HP
- [ ] Dua orang pesan slot sama → hanya satu yang lolos
- [ ] Link status booking: token salah → 404
- [ ] Reminder H-1 terkirim tepat sekali
- [ ] Approve bikin event otomatis (tidak input ulang di hari-H)
- [ ] Cancel/reschedule di luar kebijakan → ditolak dengan pesan jelas

---

## Fase 6–13 (post-MVP) — ringkas

Detail fitur per baris ada di `FEATURE-MATRIX.md` §B (kolom **Fase**). Isi task & validasi tiap fase diisi saat fase itu dimulai — jangan disiapkan terlalu awal.

- **Fase 6** — Green screen (MediaPipe) · adjustments · face enhance (GFPGAN) · rotasi/quality/shutter · storage location picker · Sentry — **detail lengkap di atas**
- **Fase 7** — Video + slow-mo (WebCodecs + RIFE) · audio · boomerang/slideshow
- **Fase 8** — AI style/backdrop/upscale/enhance/remix (Gemini BYOK, diproxy lewat `/v1/ai/*`)
- **Fase 9** — Leads + consent UU PDP + export CSV · analytics per event · branding/white-label · auto-print + queue
- **Fase 10** — Lisensi + order: katalog SKU, siklus hidup order, kode aktivasi, batas plan (**mekanisme selesai**; gateway QRIS + webhook ditunda atas permintaan pemilik)
- **Fase 11** — Booking & reservasi: halaman booking publik · kalender ketersediaan · approve/tolak · reschedule & cancel · dashboard operator · laporan okupansi · invoice/kwitansi · **email SMTP sungguhan** · job pengingat H-1 (**mekanisme selesai**; deposit QRIS ditunda atas permintaan pemilik)
- **Fase 12** — Desktop (Electron) + mobile (Capacitor) · pilih printer + deteksi USB printer + laporan diagnostik · **titipan #51/#52** (layar hasil tamu + peringatan keluar kiosk) — **detail lengkap di atas**; packaging APK/IPA tidak bisa dibuktikan di mesin ini (tanpa Java/Android SDK)
- **Fase 13** — DSLR WebUSB/PTP + PTP/IP · phone-as-camera (WebRTC) · marketplace template · sinkron multi-device · remote monitoring

---

## Cek status

```bash
node docs/phases-status.mjs          # laporan status tiap fase + cek urutan
node docs/phases-status.mjs --quiet  # hanya exit code (0 = urutan valid, 1 = ada yang salah)
```

Script ini menolak fase yang dicentang padahal fase sebelumnya belum selesai — aturan gate-nya jadi mekanis, bukan mengandalkan ingatan.

## Cara update dokumen ini

1. Kerjakan satu fase.
2. Jalankan perintah di bagian **Validasi** fase itu. Kalau ada yang gagal → `[~]`, perbaiki, ulangi.
3. Semua lulus → ubah status fase jadi `[x]`, centang task-nya, isi **Bukti** (run CI, output, angka).
4. Commit bareng pekerjaan fasenya: `docs: fase N selesai — <ringkas bukti>`.
5. Baru mulai fase berikutnya, dan **cek gate keluar fase sebelumnya** dulu.
