# Matriks Fitur & Definisi MVP

Sumber paritas: 217 key i18n bundle produksi SLR Booth Studio (lihat `RESEARCH.md` §4).
Legenda kolom **Status**: **MVP** = wajib ada sebelum rilis pertama · **Post** = setelah MVP · **Skip** = sengaja tidak dibuat.

---

## A. Tabel MVP (yang WAJIB ada di rilis pertama)

Ini daftar definitif "fitur wajib" versi MVP. Kalau semua baris ini ✅, MVP dianggap selesai.

| # | Modul | Fitur wajib MVP | Kriteria terima (acceptance) |
|---|---|---|---|
| 1 | Capture | Live preview kamera: webcam **atau** capture card HDMI/UVC (`getUserMedia`) | Preview tampil < 2 s, resolusi ≥ 1280×720; capture card 1080p terbaca |
| 2 | Capture | Countdown sebelum jepret (bisa on/off) | Hitungan 3-2-1 terlihat, durasi configurable |
| 3 | Capture | Multi-shot 1..N frame | N bisa diatur (mis. 3/4/6); tiap frame tersimpan |
| 4 | Capture | Review + retake per frame | User bisa ulangi 1 frame tanpa ulang semua |
| 5 | Capture | Mirror + aspect ratio 1:1 / 16:9 / 3:2 | Ganti rasio → preview & hasil ikut berubah |
| 6 | Capture | Pilih sumber kamera (webcam / capture card HDMI) | Dropdown dari `enumerateDevices`; capture card ditandai terpisah dari webcam |
| 7 | Template | Model template = JSON (`size`,`background`,`frames`,`textElements`,`stickers`) | JSON valid → bisa disimpan & dimuat ulang |
| 8 | Template | Editor drag-drop (Konva) | Elemen bisa digeser/resize/rotate, undo |
| 9 | Template | Teks dinamis token `{event}` `{date}` | Token ter-substitusi saat compose |
| 10 | Template | Render strip/kolase → PNG | Hasil ekspor ≥ 300 dpi, tanpa artefak |
| 11 | Template | Simpan / muat template | Tersimpan di IndexedDB, muncul di daftar |
| 12 | Print | Preset kertas 2×6 strip + 4×6 | Layout presisi, ada bleed/margin benar |
| 13 | Print | Print via browser (`window.print()` iframe) | Keluar ke dialog print, ukuran benar |
| 14 | Print | Download PNG/JPEG | File terunduh, nama file rapi |
| 15 | Kiosk | Fullscreen mode | Masuk fullscreen tanpa UI browser |
| 16 | Kiosk | Idle timeout → auto reset | Diam X detik → balik ke layar awal |
| 17 | Kiosk | PIN lock keluar | Tidak bisa keluar tanpa PIN |
| 18 | Kiosk | Tap to start + wake lock | Layar tidak tidur selama sesi |
| 19 | Galeri | Buat event + galeri | Event punya nama, tanggal, hashtag |
| 20 | Galeri | Upload foto (presigned S3, direct) | Upload tidak lewat API, ada progress + retry |
| 21 | Galeri | Halaman tamu `/a/<hash>` | Buka di HP, browse + download (HTML dari API, bukan app terpisah) |
| 22 | Galeri | QR code ke galeri | Scan QR → langsung ke album |
| 23 | Galeri | Password galeri (opsional) | Tanpa password benar → 401 |
| 24 | Galeri | TTL 30 hari + job cleanup | Foto & objek S3 terhapus otomatis |
| 25 | Offline | **App shell + seluruh studio jalan tanpa internet** | Service worker cache; mode pesawat → capture/edit/render/print/kiosk tetap jalan |
| 26 | Offline | Foto disimpan lokal dulu (IndexedDB + OPFS) | Mati internet → capture tetap jalan, nol kehilangan data |
| 27 | Offline | Queue upload + status + retry + auto-sync | Kembali online → upload jalan sendiri; badge status jelas |
| 28 | Offline | Indikator status online/offline | Badge terlihat di UI; mode offline tidak diam-diam gagal |
| 29 | Offline | Konten (template/frame/sticker/font) tersedia offline | Setelah sync pertama → tersedia tanpa jaringan |
| 30 | Offline | **Kiosk full-offline** (event jalan tanpa backend) | Satu device tanpa koneksi → sesi foto + print utuh |
| 31 | i18n | Locale **id + en** | Ganti bahasa tanpa reload |
| 32 | Infra | Auth email OTP → JWT | Kode masuk email, tukar jadi token |
| 33 | Infra | Lisensi / entitlement dasar | Status lisensi bisa divalidasi |

**Batas MVP:** baris 1–33. Di luar ini = Post-MVP.

---

## B. Tabel lengkap: MVP vs Post vs Skip

| # | Modul | Fitur | Status | Fase |
|---|---|---|---|---|
| 1 | **Capture** | countdown / tanpa countdown | **MVP** | 1 |
| 2 | Capture | mirror | **MVP** | 1 |
| 3 | Capture | allow retake | **MVP** | 1 |
| 4 | Capture | durasi review | **MVP** | 1 |
| 5 | Capture | aspect 1:1 / 16:9 / 3:2 | **MVP** | 1 |
| 6 | Capture | pilih kamera (device id) | **MVP** | 1 |
| 7 | Capture | still resolusi penuh via `ImageCapture.takePhoto()` (fallback canvas) | **MVP** | 1 |
| 8 | Capture | mirror default **mati** untuk sumber capture card | **MVP** | 1 |
| 9 | Capture | rotasi 0/90/180/270 | Post | 6 |
| 10 | Capture | image quality (preset) | Post | 6 |
| 11 | Capture | shutter offset | Post | 6 |
| 12 | Capture | auto-connect camera | Post | 6 |
| 13 | **Video** | snapshot / slow-mo | Post | 7 |
| 14 | Video | resolusi + frame rate + max duration | Post | 7 |
| 15 | Video | slow-mo factor ½ / ¼ | Post | 7 |
| 16 | Video | output FPS 24/30/60 | Post | 7 |
| 17 | Video | output quality 480/720/1080/2160 | Post | 7 |
| 18 | Video | rekam audio | Post | 7 |
| 19 | Video | video guestbook | Post | 9 |
| 20 | Video | animasi slideshow / boomerang | Post | 7 |
| 21 | **Green screen** | chromaKey (color/similarity/smoothness/spill) | Post | 6 |
| 22 | Green screen | virtualBackground blur / ai | Post | 6 |
| 23 | Green screen | adjustments (brightness/contrast/saturation) | Post | 6 |
| 24 | Green screen | faceEnhance (GFPGAN) | Post | 6 |
| 25 | **AI** | aiStyle (anime/3D/comic/watercolor/oil/custom) | Post | 8 |
| 26 | AI | aiEnhance | Post | 8 |
| 27 | AI | AI remix (boomerang remix) | Post | 8 |
| 28 | AI | AI backdrop | Post | 8 |
| 29 | AI | AI upscale | Post | 8 |
| 30 | AI | AI template elements | Post | 8 |
| 31 | AI | AI slow-motion (RIFE) | Post | 7 |
| 32 | **Template** | model JSON (size/bg/frames/text/stickers) | **MVP** | 2 |
| 33 | Template | editor drag-drop Konva | **MVP** | 2 |
| 34 | Template | token {event}/{date} | **MVP** | 2 |
| 35 | Template | render + export PNG | **MVP** | 2 |
| 36 | Template | simpan / muat template | **MVP** | 2 |
| 37 | Template | vignette background | Post | 3 |
| 38 | Template | shadow elemen | Post | 3 |
| 39 | Template | starter template bawaan | Post | 3 |
| 40 | Template | **template marketplace** | Post | 13 |
| 41 | **Print** | preset 2×6 strip + 4×6 | **MVP** | 3 |
| 42 | Print | print browser (iframe) | **MVP** | 3 |
| 43 | Print | download PNG/JPEG | **MVP** | 3 |
| 44 | Print | auto print + copies | Post | 9 |
| 45 | Print | pilih printer + deteksi USB printer | Post | 12 |
| 46 | Print | print queue + retry + reprint | Post | 9 |
| 47 | **Kiosk** | fullscreen | **MVP** | 4 |
| 48 | Kiosk | idle timeout auto reset | **MVP** | 4 |
| 49 | Kiosk | PIN lock | **MVP** | 4 |
| 50 | Kiosk | tap to start + wake lock | **MVP** | 4 |
| 51 | Kiosk | toggle tombol gallery/print/share | Post | 9 |
| 52 | Kiosk | warning keluar | Post | 9 |
| 53 | **Sharing** | QR code | **MVP** | 5 |
| 54 | Sharing | online gallery + password | **MVP** | 5 |
| 55 | Sharing | TTL 30 hari | **MVP** | 5 |
| 56 | Sharing | email share | Post | 9 |
| 57 | Sharing | SMS share | Post | 9 |
| 58 | Sharing | sosial media share | Post | 9 |
| 59 | Sharing | **share WhatsApp (deep link)** | Post | 9 |
| 60 | Sharing | branded share page + OG image | Post | 9 |
| 61 | Sharing | branding (logo/heading/subheading) | Post | 9 |
| 62 | Sharing | white-label | Post | 13 |
| 63 | **Offline** | **service worker: app shell + studio offline** | **MVP** | 0 |
| 64 | Offline | indikator status online/offline | **MVP** | 1 |
| 65 | Offline | foto disimpan lokal dulu (IndexedDB + OPFS) | **MVP** | 5 |
| 66 | Offline | queue upload + status + retry | **MVP** | 5 |
| 67 | Offline | auto-sync saat online kembali | **MVP** | 5 |
| 68 | Offline | cache konten (template/frame/sticker/font) | **MVP** | 3 |
| 69 | Offline | **kiosk full-offline (event tanpa backend)** | **MVP** | 4 |
| 70 | Offline | PWA installable | **MVP** | 1 |
| 71 | Offline | storage location picker (File System Access) | Post | 6 |
| 72 | Offline | sinkron multi-device (event sama, 2 device) | Post | 13 |
| 73 | **Leads** | field custom (text/email/phone/select/checkbox) | Post | 9 |
| 74 | Leads | required + consent text + skip | Post | 9 |
| 75 | Leads | export CSV | Post | 9 |
| 76 | Leads | consent UU PDP | Post | 9 |
| 77 | **Analytics** | view analytics | Post | 9 |
| 78 | Analytics | analytics dashboard per event | Post | 9 |
| 79 | Analytics | debug mode + cek storage | Post | 6 |
| 80 | Analytics | cek USB printer | Post | 12 |
| 81 | Analytics | kirim laporan diagnosa via email | Post | 12 |
| 82 | Analytics | remote monitoring realtime (WebSocket) | Post | 13 |
| 83 | **Infra** | auth email OTP → JWT | **MVP** | 5 |
| 84 | Infra | lisensi / entitlement (katalog SKU, kode aktivasi, batas plan) | **MVP** | 5 & 10 |
| 85 | Infra | payment QRIS (Midtrans/Xendit) | Post | 10 |
| 86 | Infra | i18n id + en | **MVP** | 1 |
| 87 | Infra | Sentry error tracking | Post | 6 |
| 88 | Infra | desktop Electron | Post | 12 |
| 89 | Infra | mobile Capacitor (Android/iOS) | Post | 12 |
| 90 | **Transport** | webcam (getUserMedia) | **MVP** | 1 |
| 91 | Transport | fake transport (test/CI) | **MVP** | 1 |
| 92 | Transport | **capture card HDMI (UVC)** — DSLR/mirrorless live view | **MVP** | 1 |
| 93 | Transport | deteksi sinyal hilang (HDMI lepas / kamera tidur) | **MVP** | 1 |
| 94 | Transport | resolusi & framerate dari `getCapabilities()` + `applyConstraints` | **MVP** | 1 |
| 95 | Transport | klasifikasi device: webcam vs capture card | **MVP** | 1 |
| 96 | Transport | phone-as-camera (WebRTC) | Post | 13 |
| 97 | Transport | DSLR WebUSB + PTP | Post | 13 |
| 98 | Transport | DSLR PTP/IP (network) | Post | 13 |
| 99 | **Booking** | halaman booking publik + form | Post | 11 |
| 100 | Booking | paket layanan + harga + deposit | Post | 11 |
| 101 | Booking | kalender ketersediaan + slot waktu | Post | 11 |
| 102 | Booking | jam operasional + buffer antar-booking | Post | 11 |
| 103 | Booking | blokir tanggal / tanggal tutup | Post | 11 |
| 104 | Booking | permintaan booking (request) | Post | 11 |
| 105 | Booking | approve / tolak oleh operator | Post | 11 |
| 106 | Booking | konfirmasi email + WhatsApp | Post | 11 |
| 107 | Booking | deposit QRIS | Post | 11 |
| 108 | Booking | halaman status booking (link unik, tanpa login) | Post | 11 |
| 109 | Booking | reschedule oleh klien | Post | 11 |
| 110 | Booking | cancel oleh klien + kebijakan batas waktu | Post | 11 |
| 111 | Booking | reminder H-1 otomatis | Post | 11 |
| 112 | Booking | dashboard booking + kalender operator | Post | 11 |
| 113 | Booking | invoice + kwitansi + lacak pelunasan | Post | 11 |
| 114 | Booking | booking -> event (data nyambung ke app) | Post | 11 |
| 115 | Booking | laporan okupansi + pendapatan | Post | 11 |
| 116 | Booking | export kalender (.ics) | Post | 11 |
| 117 | **Skip** | langganan bulanan | **Skip** | — |
| 118 | Skip | kredit AI bermeter | **Skip** | — |
| 119 | Skip | watermark paksa di hasil | **Skip** | — |
| 120 | Skip | pakai nama/logo/aset SLR Booth | **Skip** | — |

**Hitung:** **40 fitur MVP** · **76 fitur Post** · **4 Skip** = **120 baris** (217 key i18n dikelompokkan jadi 97 fitur).
Tabel A di atas memecah MVP jadi **33 baris kriteria terima**.
**8 dari 34 fitur MVP adalah Offline** (plus 2 Post) — offline bukan fitur tambahan, ini properti inti aplikasi.

---

## C. Definisi MVP (scope rilis pertama)

**MVP = Fase 0–5.** Satu kalimat: *"Satu laptop + webcam (atau kamera DSLR/mirrorless lewat capture card HDMI), orang bisa foto, pilih template, hasilnya jadi strip, bisa diprint, dan tamu bisa ambil fotonya lewat QR — **semua jalan walau internet mati**."*

### Mode operasi (wajib)

| Mode | Butuh internet? | Yang jalan |
|---|---|---|
| **Online** | Ya | Semua fitur + galeri & upload realtime |
| **Offline penuh** | **Tidak** | Capture · template · render · print · kiosk · QR lokal — 100% jalan |
| **Hybrid (default)** | Opsional | Kerja offline, auto-sync begitu online kembali |

**Prinsip: jaringan itu opsional, bukan syarat.** Backend cuma dipakai untuk galeri, lisensi, konten, dan payment. Kalau backend mati atau venue nggak ada wifi → event tetap jalan, foto nggak hilang, upload nyusul.

### Masuk MVP
- **Offline penuh** — app shell + studio jalan tanpa internet (service worker)
- **Offline** — foto lokal dulu (IndexedDB + OPFS) · queue upload + auto-sync · indikator status · konten ter-cache · kiosk full-offline
- Capture: **webcam + capture card HDMI/UVC** (DSLR/mirrorless live view) + countdown + multi-shot + retake
- Template JSON + editor Konva + render strip
- Print 2×6 / 4×6 + download
- Kiosk fullscreen + PIN + idle reset
- Galeri online + QR + password + TTL 30 hari
- Auth OTP + lisensi dasar
- i18n id/en
- PWA installable

**Tidak masuk MVP (sengaja):** video/slow-mo, green screen, semua AI, leads, analytics, payment, booking/reservasi, Electron/Capacitor, **kontrol DSLR via USB (WebUSB/PTP)**, marketplace, white-label.

> **Catatan penting:** "DSLR" yang **tidak** masuk MVP itu = kontrol kamera lewat **USB/WebUSB (PTP)** — butuh implementasi protokol dari nol, Chrome-only.
> DSLR/mirrorless **via HDMI capture card** **MASUK MVP (Fase 1)**, karena capture card itu device **UVC** biasa: browser lihatnya sebagai webcam, jadi cukup `getUserMedia`.

**Kenapa batas ini:** Fase 0–5 sudah = produk yang bisa dijual & dipakai di event nyata. Fase 6–8 (efek + AI) itu yang bikin "wah" tapi bukan syarat bisa jalan; Fase 9–12 itu sisi bisnis & platform.

**Urutan kerja MVP (kritis-path):**
```
Fase 0 scaffold + offline shell → Fase 1 capture → Fase 2 template → Fase 3 print → Fase 4 kiosk → Fase 5 galeri
```
Offline **bukan fase terpisah** — service worker + IndexedDB dibangun dari Fase 0, karena nempel di semua modul. Kalau ditunda, harus bongkar ulang nanti.

**Estimasi:** Fase 0–2 = inti berat (mesin capture + editor). Fase 3–5 lebih mekanis. Kalau Fase 1–2 solid, sisanya cepat.

---

## D. Checklist QA MVP (dipakai nanti saat verifikasi)

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
