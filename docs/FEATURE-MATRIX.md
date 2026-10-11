# Matriks Fitur & Definisi MVP

Sumber paritas: 217 key i18n bundle produksi SLR Booth Studio (lihat `RESEARCH.md` §4).
Legenda kolom **Status**: **MVP** = wajib ada sebelum rilis pertama · **Post** = setelah MVP · **Skip** = sengaja tidak dibuat.

---

## A. Tabel MVP (yang WAJIB ada di rilis pertama)

Ini daftar definitif "fitur wajib" versi MVP. Kalau semua baris ini ✅, MVP dianggap selesai.

| # | Modul | Fitur wajib MVP | Kriteria terima (acceptance) |
|---|---|---|---|
| 1 | Capture | Live preview webcam (`getUserMedia`) | Preview tampil < 2 s, resolusi ≥ 1280×720 |
| 2 | Capture | Countdown sebelum jepret (bisa on/off) | Hitungan 3-2-1 terlihat, durasi configurable |
| 3 | Capture | Multi-shot 1..N frame | N bisa diatur (mis. 3/4/6); tiap frame tersimpan |
| 4 | Capture | Review + retake per frame | User bisa ulangi 1 frame tanpa ulang semua |
| 5 | Capture | Mirror + aspect ratio 1:1 / 16:9 / 3:2 | Ganti rasio → preview & hasil ikut berubah |
| 6 | Capture | Pilih kamera (device id) | Dropdown daftar kamera dari `enumerateDevices` |
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

| Modul | Fitur | Status | Fase |
|---|---|---|---|
| **Capture** | countdown / tanpa countdown | **MVP** | 1 |
| Capture | mirror | **MVP** | 1 |
| Capture | allow retake | **MVP** | 1 |
| Capture | durasi review | **MVP** | 1 |
| Capture | aspect 1:1 / 16:9 / 3:2 | **MVP** | 1 |
| Capture | pilih kamera (device id) | **MVP** | 1 |
| Capture | rotasi 0/90/180/270 | Post | 6 |
| Capture | image quality (preset) | Post | 6 |
| Capture | shutter offset | Post | 6 |
| Capture | auto-connect camera | Post | 6 |
| **Video** | snapshot / slow-mo | Post | 7 |
| Video | resolusi + frame rate + max duration | Post | 7 |
| Video | slow-mo factor ½ / ¼ | Post | 7 |
| Video | output FPS 24/30/60 | Post | 7 |
| Video | output quality 480/720/1080/2160 | Post | 7 |
| Video | rekam audio | Post | 7 |
| Video | video guestbook | Post | 9 |
| Video | animasi slideshow / boomerang | Post | 7 |
| **Green screen** | chromaKey (color/similarity/smoothness/spill) | Post | 6 |
| Green screen | virtualBackground blur / ai | Post | 6 |
| Green screen | adjustments (brightness/contrast/saturation) | Post | 6 |
| Green screen | faceEnhance (GFPGAN) | Post | 6 |
| **AI** | aiStyle (anime/3D/comic/watercolor/oil/custom) | Post | 8 |
| AI | aiEnhance | Post | 8 |
| AI | AI remix (boomerang remix) | Post | 8 |
| AI | AI backdrop | Post | 8 |
| AI | AI upscale | Post | 8 |
| AI | AI template elements | Post | 8 |
| AI | AI slow-motion (RIFE) | Post | 7 |
| **Template** | model JSON (size/bg/frames/text/stickers) | **MVP** | 2 |
| Template | editor drag-drop Konva | **MVP** | 2 |
| Template | token {event}/{date} | **MVP** | 2 |
| Template | render + export PNG | **MVP** | 2 |
| Template | simpan / muat template | **MVP** | 2 |
| Template | vignette background | Post | 3 |
| Template | shadow elemen | Post | 3 |
| Template | starter template bawaan | Post | 3 |
| Template | **template marketplace** | Post | 12 |
| **Print** | preset 2×6 strip + 4×6 | **MVP** | 3 |
| Print | print browser (iframe) | **MVP** | 3 |
| Print | download PNG/JPEG | **MVP** | 3 |
| Print | auto print + copies | Post | 9 |
| Print | pilih printer + deteksi USB printer | Post | 11 |
| Print | print queue + retry + reprint | Post | 9 |
| **Kiosk** | fullscreen | **MVP** | 4 |
| Kiosk | idle timeout auto reset | **MVP** | 4 |
| Kiosk | PIN lock | **MVP** | 4 |
| Kiosk | tap to start + wake lock | **MVP** | 4 |
| Kiosk | toggle tombol gallery/print/share | Post | 9 |
| Kiosk | warning keluar | Post | 9 |
| **Sharing** | QR code | **MVP** | 5 |
| Sharing | online gallery + password | **MVP** | 5 |
| Sharing | TTL 30 hari | **MVP** | 5 |
| Sharing | email share | Post | 9 |
| Sharing | SMS share | Post | 9 |
| Sharing | sosial media share | Post | 9 |
| Sharing | **share WhatsApp (deep link)** | Post | 9 |
| Sharing | branded share page + OG image | Post | 9 |
| Sharing | branding (logo/heading/subheading) | Post | 9 |
| Sharing | white-label | Post | 12 |
| **Offline** | **service worker: app shell + studio offline** | **MVP** | 0 |
| Offline | indikator status online/offline | **MVP** | 1 |
| Offline | foto disimpan lokal dulu (IndexedDB + OPFS) | **MVP** | 5 |
| Offline | queue upload + status + retry | **MVP** | 5 |
| Offline | auto-sync saat online kembali | **MVP** | 5 |
| Offline | cache konten (template/frame/sticker/font) | **MVP** | 3 |
| Offline | **kiosk full-offline (event tanpa backend)** | **MVP** | 4 |
| Offline | PWA installable | **MVP** | 1 |
| Offline | storage location picker (File System Access) | Post | 6 |
| Offline | sinkron multi-device (event sama, 2 device) | Post | 12 |
| **Leads** | field custom (text/email/phone/select/checkbox) | Post | 9 |
| Leads | required + consent text + skip | Post | 9 |
| Leads | export CSV | Post | 9 |
| Leads | consent UU PDP | Post | 9 |
| **Analytics** | view analytics | Post | 9 |
| Analytics | analytics dashboard per event | Post | 9 |
| Analytics | debug mode + cek storage | Post | 6 |
| Analytics | cek USB printer | Post | 11 |
| Analytics | kirim laporan diagnosa via email | Post | 11 |
| Analytics | remote monitoring realtime (WebSocket) | Post | 12 |
| **Infra** | auth email OTP → JWT | **MVP** | 5 |
| Infra | lisensi / entitlement | **MVP** | 5 |
| Infra | payment QRIS (Midtrans/Xendit) | Post | 10 |
| Infra | i18n id + en | **MVP** | 1 |
| Infra | Sentry error tracking | Post | 6 |
| Infra | desktop Electron | Post | 11 |
| Infra | mobile Capacitor (Android/iOS) | Post | 11 |
| **Transport** | webcam (getUserMedia) | **MVP** | 1 |
| Transport | fake transport (test/CI) | **MVP** | 1 |
| Transport | HDMI capture card | Post | 6 |
| Transport | phone-as-camera (WebRTC) | Post | 12 |
| Transport | DSLR WebUSB + PTP | Post | 12 |
| Transport | DSLR PTP/IP (network) | Post | 12 |
| **Skip** | langganan bulanan | **Skip** | — |
| Skip | kredit AI bermeter | **Skip** | — |
| Skip | watermark paksa di hasil | **Skip** | — |
| Skip | pakai nama/logo/aset SLR Booth | **Skip** | — |

**Hitung:** **34 fitur MVP** · **59 fitur Post** · **4 Skip** = **97 baris** (217 key i18n dikelompokkan jadi 97 fitur).
Tabel A di atas memecah MVP jadi **33 baris kriteria terima**.
**8 dari 34 fitur MVP adalah Offline** (plus 2 Post) — offline bukan fitur tambahan, ini properti inti aplikasi.

---

## C. Definisi MVP (scope rilis pertama)

**MVP = Fase 0–5.** Satu kalimat: *"Satu laptop + webcam, orang bisa foto, pilih template, hasilnya jadi strip, bisa diprint, dan tamu bisa ambil fotonya lewat QR — **semua jalan walau internet mati**."*

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
- Webcam capture + countdown + multi-shot + retake
- Template JSON + editor Konva + render strip
- Print 2×6 / 4×6 + download
- Kiosk fullscreen + PIN + idle reset
- Galeri online + QR + password + TTL 30 hari
- Auth OTP + lisensi dasar
- i18n id/en
- PWA installable

**Tidak masuk MVP (sengaja):** video/slow-mo, green screen, semua AI, leads, analytics, payment, Electron/Capacitor, DSLR, marketplace, white-label.

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
