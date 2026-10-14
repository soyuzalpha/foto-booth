/**
 * Kerangka halaman HTML publik.
 *
 * Ada dua permukaan publik di aplikasi ini — halaman galeri tamu (`/a/<hash>`)
 * dan halaman booking (`/booking`). Keduanya harus terlihat seperti satu
 * aplikasi, dan keduanya butuh hal yang sama: escape yang benar dan satu kartu
 * neo-brutalism.
 *
 * Alasan file ini ada: kalau `shell()` disalin dua kali, perbaikan gaya di satu
 * tempat akan membuat dua halaman berbeda tampilannya — dan tidak ada tes yang
 * menangkap itu.
 *
 * Halaman dirender dari server (bukan SPA) supaya bisa dibuka tanpa JavaScript
 * dan bisa dibaca crawler preview link.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Kartu putih bergaris tebal dengan bayangan keras.
 *
 * `head` untuk CSS tambahan (di dalam `<head>`), `script` untuk JavaScript
 * halaman (disisipkan tepat sebelum `</body>`).
 *
 * Kenapa `script` dipisah, bukan digabung ke `head`: skrip halaman memanggil
 * `document.getElementById` saat dijalankan. Skrip di `<head>` berjalan sebelum
 * elemennya ada — `getElementById` mengembalikan `null` dan halaman mati tanpa
 * pesan apa pun. Menaruhnya di akhir `<body>` membuat urutan itu tidak mungkin
 * salah.
 */
export function shell(title: string, body: string, head = "", script = ""): string {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
${head}
<style>
  :root { --ink:#0a0a0a; --paper:#fffdf5; --accent:#ffd93d; --pink:#ff6b9d; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; }
  .card { max-width:720px; width:100%; background:#fff; border:4px solid var(--ink);
          box-shadow:12px 12px 0 var(--ink); padding:32px; }
  h1 { margin:0 0 8px; font-size:clamp(28px,7vw,44px); line-height:1; letter-spacing:-.02em; }
  p  { margin:0 0 20px; font-size:16px; line-height:1.5; }
  .badge { display:inline-block; background:var(--accent); border:3px solid var(--ink);
           padding:4px 12px; font-weight:800; font-size:13px; text-transform:uppercase;
           letter-spacing:.06em; margin-bottom:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:14px; margin:20px 0 0; }
  .grid a { display:block; }
  .grid img { width:100%; aspect-ratio:3/4; object-fit:cover; border:3px solid var(--ink); background:#eee; display:block; }
  a.btn, button.btn { display:inline-block; background:var(--pink); color:var(--ink); border:3px solid var(--ink);
          box-shadow:5px 5px 0 var(--ink); padding:12px 22px; font-weight:800; text-decoration:none;
          font-size:16px; cursor:pointer; font-family:inherit; }
  form { display:flex; gap:10px; flex-wrap:wrap; }
  input[type=password] { flex:1 1 200px; border:3px solid var(--ink); padding:12px; font-size:16px; font-family:inherit; }
  /* Form data tamu (Fase 9) memakai label blok. 'flex:1 1 100%' supaya tetap
     utuh satu baris di dalam form yang flex-nya row — tanpa ini label dan
     input saling menghimpit. */
  label { flex:1 1 100%; display:block; margin:0; font-weight:700; font-size:14px; }
  label small { display:block; font-weight:400; color:#555; margin-top:4px; }
  label.check { display:flex; gap:10px; align-items:flex-start; font-weight:400; font-size:14px; line-height:1.45; }
  label.check input { flex:0 0 auto; margin-top:3px; }
  input[type=text], input[type=email], input[type=tel], select {
           width:100%; border:3px solid var(--ink); padding:12px; font-size:16px;
           font-family:inherit; margin-top:6px; background:#fff; }
  .trap { position:absolute; left:-9999px; width:1px; height:1px; }
  section.leads { border-top:3px solid var(--ink); margin-top:28px; padding-top:12px; }
  h2 { margin:0 0 8px; font-size:20px; }
  .row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-top:24px; }
  .note { font-size:13px; color:#555; margin:16px 0 0; }
</style>
</head>
<body><main class="card">${body}</main>${script}</body>
</html>`;
}

export function errorPage(status: number, title: string, message: string): string {
  return shell(
    title,
    `<span class="badge">${status}</span>
     <h1>${escapeHtml(title)}</h1>
     <p>${message}</p>
     <a class="btn" href="/">Kembali ke beranda</a>`,
  );
}
