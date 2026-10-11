#!/usr/bin/env node
// Membaca docs/PHASES.md dan melaporkan status tiap fase.
//
// Gunanya: aturan "mau pindah fase, cek gate fase sebelumnya dulu" jadi
// mekanis — kalau ada fase yang dicentang padahal fase sebelumnya belum,
// script keluar dengan exit 1.
//
//   node docs/phases-status.mjs          # laporan + cek urutan
//   node docs/phases-status.mjs --quiet  # hanya keluar 0/1
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const quiet = process.argv.includes('--quiet');
const md = readFileSync(join(here, 'PHASES.md'), 'utf8');

// Baris tabel peta fase: | **0** | isi | L | `[x]` ... |
const rows = [];
for (const line of md.split('\n')) {
  const m = line.match(/^\|\s*\*{0,2}(\d{1,2})\*{0,2}\s*\|([^|]*)\|([^|]*)\|\s*(`\[[ x~!]\]`)/);
  if (!m) continue;
  rows.push({
    n: Number(m[1]),
    isi: m[2].trim().replace(/\*+/g, ''),
    size: m[3].trim(),
    // 'x' | ' ' | '~' | '!' — jangan di-trim: `[ ]` yang di-trim jadi '' dan
    // hilang jejaknya, padahal ' ' artinya "belum".
    state: m[4].replace(/[`[\]]/g, '')[0] || ' ',
  });
}

if (rows.length === 0) {
  console.error('Tidak ada baris fase yang terbaca di docs/PHASES.md');
  process.exit(2);
}

const label = { x: 'selesai', ' ': 'belum', '~': 'belum lulus validasi', '!': 'blocked' };
const done = (s) => s === 'x';

let firstOpen = null;
const problems = [];

for (const r of rows) {
  if (firstOpen === null && !done(r.state)) firstOpen = r.n;
  // fase yang dicentang padahal masih ada fase sebelumnya yang belum
  if (done(r.state) && firstOpen !== null && r.n > firstOpen) {
    problems.push(`Fase ${r.n} dicentang, tapi Fase ${firstOpen} belum selesai`);
  }
  if (!quiet) {
    const mark = done(r.state) ? 'x' : ' ';
    console.log(`  [${mark}] Fase ${String(r.n).padStart(2)}  ${label[r.state].padEnd(22)} ${r.isi}`);
  }
}

if (!quiet) {
  const total = rows.length;
  const selesai = rows.filter((r) => done(r.state)).length;
  console.log('');
  console.log(`  ${selesai}/${total} fase selesai${firstOpen !== null ? ` · fase berikutnya: ${firstOpen}` : ''}`);
}

for (const p of problems) console.error(`\n  ✗ ${p}`);

if (problems.length) {
  console.error('\n  Urutan fase tidak valid — selesaikan & validasi fase sebelumnya dulu.');
  process.exit(1);
}

if (!quiet) console.log('\n  Urutan fase valid.');
