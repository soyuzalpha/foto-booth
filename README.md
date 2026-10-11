# Foto Booth

Aplikasi **photo booth berbasis web** (TypeScript end-to-end). Capture dari
webcam, template editor, cetak strip, kiosk mode, galeri tamu via QR.
**Offline-first**: jaringan opsional, bukan syarat.

Repo ini berisi hasil riset + system design **dan** kerangka aplikasinya
(Fase 0).

## Struktur

```
apps/
  studio/   Vite + React SPA — app utama, offline-first (PWA)
  api/      Fastify — API + serve studio SPA + halaman galeri tamu
packages/
  shared/   Zod schema + konstanta + tipe, dipakai FE & BE
docs/       riset, system design, matriks fitur, diagram
```

Satu image, satu container: API di `127.0.0.1:5050`, studio di `/studio/`,
landing page di `/`.

## Jalankan lokal

```bash
pnpm install
pnpm build            # build studio → apps/studio/dist (di-serve API)
pnpm --filter @foto-booth/api dev     # API + landing + studio di :5050
```

Pengembangan studio dengan hot reload:

```bash
pnpm --filter @foto-booth/studio dev  # :5173, /v1 diproxy ke :5050
```

Cek mutu:

```bash
pnpm lint        # eslint (flat config di root)
pnpm typecheck   # tsc --noEmit di semua paket
pnpm build       # build semua paket
```

## Deploy

Push ke `main` → GitHub Actions (self-hosted runner) menjalankan
`.github/workflows/deploy.yml`: install → lint → typecheck → build →
`docker build` → container uji di `:5150` → health check → ganti container
produksi di `:5050`.

Skemanya sama dengan `aseppp-web`. Data runtime (template, konten, galeri)
disimpan di `$HOME/app/foto-booth/storage` di host dan di-mount ke
`/app/storage`, supaya tidak ikut mati bersama image.

## Dokumentasi

| File | Isi |
|---|---|
| `docs/RESEARCH.md` | Hasil riset: produk acuan, peta surface, stack, inventaris fitur (217 key i18n), library konten, model bisnis |
| `docs/SYSTEM-DESIGN.md` | Arsitektur, struktur repo, modul inti, offline-first, API, data model, kiosk, i18n, fase pengerjaan |
| `docs/FEATURE-MATRIX.md` | Matriks fitur: MVP vs Post vs Skip + kriteria terima + checklist QA |
| `docs/architecture.html` | Diagram arsitektur (SVG, standalone) |
| `docs/architecture.png` | Diagram arsitektur (PNG) |

## Fase

**MVP = Fase 0–5:** scaffold + offline shell → capture → template → print →
kiosk → galeri. **34 fitur MVP** (8 di antaranya offline) · 59 Post · 4 Skip.

**Status: Fase 0 selesai** — monorepo, API, studio shell offline-first (service
worker + manifest + indikator storage), landing page neo-brutalism, CI/CD.

## Regenerasi diagram

```bash
cd docs
ln -sfn /path/to/node_modules node_modules   # butuh playwright
node shot.mjs architecture.html architecture.png   # render PNG
node check.mjs                                     # cek teks overflow di diagram
```

## Lisensi

Belum ditentukan.
