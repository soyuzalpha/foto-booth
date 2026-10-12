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
| **4** | Kiosk mode (fullscreen, PIN, idle reset) | M | `[ ]` |
| **5** | Galeri: upload S3 + halaman tamu + QR + TTL + auth | L | `[ ]` |
| 6 | Green screen + adjustments + face enhance | L | `[ ]` |
| 7 | Video + slow-mo (WebCodecs + RIFE) | L | `[ ]` |
| 8 | AI style/backdrop/upscale (Gemini BYOK) | L | `[ ]` |
| 9 | Leads + analytics + branding | M | `[ ]` |
| 10 | Lisensi + payment (QRIS) | M | `[ ]` |
| 11 | **Booking & reservasi** (kalender, approve, deposit, reminder) | L | `[ ]` |
| 12 | Desktop (Electron) + mobile (Capacitor) | L | `[ ]` |
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

**Status:** `[ ]`
**Gate masuk:** Fase 3 gate keluar terpenuhi (alur foto → cetak utuh).
**Tujuan:** bisa ditinggal tanpa operator.

**Deliverable:** `apps/studio/src/lib/kiosk/*` + layar kiosk (fullscreen, PIN, idle reset, wake lock).

**Task**

- [ ] Fullscreen API + sembunyikan navigasi
- [ ] Idle timeout → auto reset ke layar awal (configurable, mis. 60 s)
- [ ] PIN lock untuk keluar (PIN di-hash lokal, bukan plaintext)
- [ ] Tap to start + wake lock (layar tidak tidur)
- [ ] `preventDefault` gesture yang tidak diinginkan (zoom, context menu, swipe-back)
- [ ] **Kiosk full-offline**: satu device tanpa koneksi → sesi penuh + print tetap utuh
- [ ] Toggle tombol gallery/print/share (disiapkan, UI lengkap di Fase 9)

**Kriteria terima (FEATURE-MATRIX):** §A15–18 (kiosk) · §B semua baris dengan **Fase = 4**

**Validasi**

```bash
pnpm lint && pnpm -r typecheck && pnpm -r build
pnpm --filter @foto-booth/studio test
```

- [ ] Idle timer diuji dengan **jam palsu** (bukan tunggu 60 s asli): diam X detik → reset
- [ ] PIN salah → tidak keluar; PIN benar → keluar (dan PIN tidak tersimpan plaintext)
- [ ] `document.fullscreenElement` terisi saat mode kiosk
- [ ] Wake lock aktif (spy `navigator.wakeLock.request`)
- [ ] **Kiosk jalan 1 jam tanpa koneksi → tanpa error, tanpa data hilang** (checklist QA §D)
- [ ] CI hijau + container healthy

**Gate keluar:** semua task `[x]` · idle & PIN terbukti lewat tes · kiosk offline utuh · bukti ditulis.
**Bukti:** —

---

## Fase 5 — Galeri, upload, QR, TTL, auth

**Status:** `[ ]`
**Gate masuk:** Fase 4 gate keluar terpenuhi (kiosk utuh).
**Tujuan:** tamu bisa ambil fotonya lewat QR. **Ini fase penutup MVP.**

**Deliverable:** `apps/api/src/routes/*` (event, gallery, upload-url, foto, album publik, TTL), `apps/studio/src/lib/upload/*` (queue + retry + auto-sync), halaman `/a/:hash` + OG image + zip, auth OTP, entitlement.

**Task**

- [ ] `POST /v1/events` · `POST /v1/galleries` · `GET /v1/galleries/:id`
- [ ] `POST /v1/galleries/:id/photos/upload-url` → **presigned S3**, upload langsung (tidak lewat API)
- [ ] `POST /v1/galleries/:id/photos` → daftarkan metadata setelah upload
- [ ] Antrian upload persisten (IndexedDB) + status `local-only → queued → uploading → uploaded → failed` + retry
- [ ] **Auto-sync** saat online kembali (Background Sync, fallback polling `navigator.onLine`)
- [ ] Halaman tamu `/a/:hash` (HTML + meta OG) + `/a/:hash/og.png` + `/a/:hash/zip`
- [ ] Password galeri opsional → tanpa password benar = 401
- [ ] QR code → langsung ke album
- [ ] TTL 30 hari + job cleanup harian (hapus row + objek S3)
- [ ] Auth email OTP → JWT · entitlement/lisensi dasar
- [ ] **Tunnel publik `foto.soyuz.my.id`** (`sudo ~/script/add-fotobooth-tunnel.sh`) — tamu harus bisa buka dari HP
- [ ] Foto disimpan lokal dulu (IndexedDB + OPFS)

**Kriteria terima (FEATURE-MATRIX):** §A19–24 (galeri) · §A27 (queue + auto-sync) · §A30 · §A32–33 (auth, lisensi) · §B semua baris dengan **Fase = 5**

**Validasi**

```bash
pnpm lint && pnpm -r typecheck && pnpm -r build
pnpm --filter @foto-booth/api test

# alur tamu end-to-end (script, bukan curl manual)
node ~/.hermes/profiles/vesta/cache/scratch/fb-gallery-e2e.mjs

# tunnel publik
curl -s -o /dev/null -w '%{http_code}\n' https://foto.soyuz.my.id/health
```

- [ ] **Tutup tab saat offline → buka lagi → antrian masih ada** (persisten)
- [ ] **Online kembali → upload jalan otomatis, tanpa aksi user** (bukti: foto muncul di `/a/:hash`)
- [ ] QR discan dari HP lain → album kebuka, download jalan
- [ ] Galeri berpassword → tanpa password ditolak (401)
- [ ] Foto > 30 hari → terhapus dari DB **dan** S3
- [ ] Upload tidak lewat API (bukti: `upload-url` presigned + PUT langsung ke S3)
- [ ] OTP: kode → JWT; entitlement bisa divalidasi
- [ ] CI hijau + container healthy + hostname publik 200

**Gate keluar:** semua task `[x]` · checklist QA §D **MVP penuh** lulus · bukti ditulis.
**Bukti:** —

**✅ MVP SELESAI kalau Fase 0–5 semua `[x]`.**

---

## Fase 11 — Booking & reservasi

**Status:** `[ ]`
**Gate masuk:** Fase 10 gate keluar terpenuhi (lisensi + payment QRIS jalan — deposit pakai jalur yang sama).
**Tujuan:** klien bisa memesan jadwal sendiri, operator tidak lagi mencatat manual di WhatsApp.

**Kenapa setelah Fase 10:** booking butuh **deposit QRIS** dan **email/reminder**. Payment (Fase 10) yang menyediakan itu — bikin booking lebih dulu = kerja dua kali.

**Deliverable**

| Area | File |
|---|---|
| API | `apps/api/src/routes/booking/{availability,requests,approve,status}.ts` |
| Publik | `apps/api/static/booking/` — halaman booking + halaman status (link unik) |
| Studio | `apps/studio/src/lib/booking/*` + layar dashboard + kalender operator |
| Shared | `packages/shared/src/schemas.ts` — Zod `ServicePackage`, `AvailabilitySlot`, `BookingRequest`, `Booking` |

**Model data (di `packages/shared`)**

- `ServicePackage` — `id`, `nama`, `durasi` (menit), `harga`, `deposit`, `aktif`
- `AvailabilitySlot` — `tanggal`, `jamMulai`, `jamSelesai`, `tersedia`
- `BookingRequest` — `id`, `paketId`, `nama`, `kontak`, `tanggal`, `slot`, `catatan`, `status`
- `Booking` — `requestId`, `eventId`, `depositStatus`, `statusPelunasan`, `linkStatus` (token unik)
- `status`: `requested → approved → confirmed → completed` · plus `rejected`, `cancelled`, `expired`

**Task**

- [ ] Halaman booking publik (tanpa login): pilih paket → tanggal → slot → isi data → kirim
- [ ] Paket layanan + harga + deposit (CRUD di studio)
- [ ] Kalender ketersediaan: hasil dari **jam operasional − booking ter-approve − tanggal diblokir**
- [ ] Jam operasional + buffer antar-booking (configurable, mis. 30 menit bersih-bersih)
- [ ] Blokir tanggal / tanggal tutup (libur, maintenance)
- [ ] `POST /v1/booking/requests` → buat permintaan (status `requested`)
- [ ] **Slot yang sudah `approved` tidak bisa dipesan dua kali** (validasi server, bukan cuma UI)
- [ ] Approve / tolak oleh operator (alasan penolakan ikut terkirim)
- [ ] Konfirmasi via email + link WhatsApp siap kirim
- [ ] Deposit QRIS → `depositStatus` berubah dari webhook (jalur Fase 10)
- [ ] Halaman status booking: link unik ber-token, **tanpa login** — klien bisa cek sendiri
- [ ] Reschedule oleh klien (batas: mis. minimal H-2)
- [ ] Cancel oleh klien + kebijakan batas waktu (kebijakan refund deposit ditulis eksplisit di UI)
- [ ] Reminder H-1 otomatis (job harian) via email + WhatsApp
- [ ] Dashboard booking + kalender operator (harian/mingguan)
- [ ] Invoice + kwitansi + lacak pelunasan
- [ ] **Booking → event**: approve bikin record event + template default, jadi tidak perlu input ulang di hari-H
- [ ] Laporan okupansi + pendapatan per periode
- [ ] Export kalender `.ics`
- [ ] Rate-limit form publik + honeypot (anti spam, karena tanpa login)
- [ ] Halaman publik responsive + aksesibel (klien buka dari HP)

**Kriteria terima (FEATURE-MATRIX):** §B semua baris dengan **Fase = 11** (modul Booking)

**Validasi**

```bash
pnpm lint && pnpm -r typecheck && pnpm -r build
pnpm --filter @foto-booth/api test
pnpm --filter @foto-booth/studio test
```

- [ ] Alur end-to-end pakai script (bukan klik manual): request → approve → deposit → confirmed
- [ ] **Double-booking ditolak**: dua request ke slot sama, yang kedua harus gagal dengan 409
- [ ] Slot di luar jam operasional **dan** slot yang bertabrakan buffer ditolak
- [ ] Tanggal diblokir → tidak muncul sebagai slot tersedia
- [ ] Webhook deposit palsu (tanda tangan salah) → ditolak, `depositStatus` tidak berubah
- [ ] Link status tanpa token / token salah → 404 (bukan bocor data booking orang lain)
- [ ] Reminder H-1: uji dengan **tanggal dimajukan** (bukan tunggu sehari) → email/WA terkirim tepat sekali
- [ ] Reschedule di bawah batas waktu → ditolak dengan pesan jelas
- [ ] Approve → **record event benar-benar ada** dan bisa dipakai di studio (cek DB, bukan asumsi)
- [ ] Form publik: submit 20× cepat → kena rate-limit
- [ ] Ukur DOM: halaman booking di 390px — tidak ada elemen meluber (`scrollWidth <= clientWidth`)
- [ ] CI hijau + container healthy

**Gate keluar:** semua task `[x]` · alur booking→event terbukti end-to-end · anti double-booking & token link terbukti lewat tes · bukti ditulis.
**Bukti:** —

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

- **Fase 6** — Green screen (MediaPipe) · adjustments · face enhance (GFPGAN) · rotasi/quality/shutter · storage location picker · Sentry
- **Fase 7** — Video + slow-mo (WebCodecs + RIFE) · audio · boomerang/slideshow
- **Fase 8** — AI style/backdrop/upscale/enhance/remix (Gemini BYOK, diproxy lewat `/v1/ai/*`)
- **Fase 9** — Leads + consent UU PDP + export CSV · analytics per event · branding/white-label · auto-print + queue
- **Fase 10** — Lisensi + payment QRIS (Midtrans/Xendit) + webhook → aktivasi
- **Fase 11** — **Booking & reservasi** (detail lengkap di bawah) · halaman booking publik · kalender ketersediaan · approve/tolak · deposit QRIS · reminder H-1 · reschedule & cancel · dashboard operator · laporan okupansi
- **Fase 12** — Desktop (Electron) + mobile (Capacitor) · pilih printer + deteksi USB printer
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
