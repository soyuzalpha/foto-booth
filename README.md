# Foto Booth — riset & system design

Repo perencanaan untuk aplikasi **photo booth berbasis web** (TypeScript end-to-end).
Isinya hasil riset + system design, belum ada kode aplikasi.

## Isi

| File | Isi |
|---|---|
| `docs/RESEARCH.md` | Hasil riset: produk acuan, peta surface, stack, inventaris fitur (217 key i18n), library konten, model bisnis |
| `docs/SYSTEM-DESIGN.md` | Arsitektur, monorepo, modul inti, offline-first, API, data model, kiosk, i18n, fase pengerjaan, rekomendasi fitur |
| `docs/FEATURE-MATRIX.md` | Matriks fitur: MVP vs Post vs Skip + kriteria terima + checklist QA |
| `docs/architecture.html` | Diagram arsitektur (SVG, standalone — buka di browser) |
| `docs/architecture.png` | Diagram arsitektur (PNG) |

## Ringkasan

**Produk:** aplikasi photo booth yang jalan di browser — capture dari webcam, template editor, cetak strip, kiosk mode, galeri tamu via QR. **Offline-first**: jaringan opsional, bukan syarat.

**Stack:** TypeScript end-to-end — Vite + React (studio app, SPA) · Next.js (marketing + galeri) · Fastify + Zod + Drizzle (API) · Postgres + Redis + S3 · pnpm workspaces + Turborepo.

**MVP = Fase 0–5:** scaffold + offline shell → capture → template → print → kiosk → galeri.
**34 fitur MVP** (8 di antaranya offline) · 59 Post · 4 sengaja Skip.

## Status

Riset selesai. Belum masuk tahap implementasi.

## Regenerasi diagram

```bash
cd docs
ln -sfn /path/to/node_modules node_modules   # butuh playwright
node shot.mjs architecture.html architecture.png   # render PNG
node check.mjs                                     # cek teks overflow di diagram
```

## Lisensi

Belum ditentukan.
