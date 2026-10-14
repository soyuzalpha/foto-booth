/**
 * Halaman share publik ber-branding + meta OG.
 *
 * Halaman galeri tamu sudah bisa dibuka langsung, tapi tautannya jarang dikirim
 * apa adanya: yang orang lepas ke grup keluarga adalah *kartu* — judul acara,
 * satu kalimat, dan tombol kirim. Halaman ini yang jadi kartu itu.
 *
 * Tiga hal yang menentukan halaman ini berguna atau tidak:
 *
 *   · **Meta OG harus benar.** WhatsApp/Telegram/Facebook membaca
 *     `og:title`/`og:description`/`og:image` sebelum manusia melihat apa pun.
 *     Judul generik "Galeri foto" membuat tautannya terlihat seperti spam.
 *   · **Judul & deskripsi datang dari fungsi yang sama dengan halaman galeri.**
 *     Dirakit ulang di sini akan membuat kartu share dan halamannya berbeda
 *     diam-diam begitu operator mengubah branding.
 *   · **Nilai operator di-escape di teks DAN di atribut.** `heading` masuk
 *     `<title>` dan `content=`; satu kutip yang lolos memutus atribut dan
 *     membuka jalan menyuntik markup.
 *
 * Logo dipakai sebagai `og:image` **hanya kalau ada**. `og:image` berisi nilai
 * kosong lebih buruk daripada tidak ada sama sekali: crawler menampilkan kotak
 * rusak, bukan kartu tanpa gambar.
 *
 * Dua path didaftarkan ke handler yang sama:
 *
 *   · `/s/<hash>` — bentuk pendek. Ini yang dipakai di teks pesan share: satu
 *     karakter lebih pendek per tautan, dan URL-nya tidak ikut berubah kalau
 *     prefiks galeri nanti digeser.
 *   · `/a/<hash>/share` — sebaris dengan halaman publik galeri yang sudah ada
 *     (`/a/<hash>`, `/a/<hash>/zip`), dan bentuk ini yang sudah tertulis di
 *     docstring `packages/shared/src/sharing.ts`.
 *
 * Keduanya dipertahankan supaya tautan yang sudah beredar di grup WhatsApp
 * tidak mati hanya karena kita memilih satu bentuk. Ongkosnya satu entri router
 * per path — jauh lebih murah daripada tautan 404 di tangan tamu.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  DEFAULT_BRANDING,
  GALLERY_BASE_PATH,
  SHARE_CHANNELS,
  resolvedHeading,
  resolvedSubheading,
  shareLink,
  sharePageTitle,
  type Branding,
  type ShareChannel,
  type ShareTarget,
} from "@foto-booth/shared";

import type { ServerContext } from "../context.ts";
import { errorPage, escapeHtml, shell } from "../pages.ts";
import { getBranding, getEvent, getGalleryByHash } from "../store.ts";

/** Bentuk hash galeri yang diterima. Sama persis dengan halaman galeri tamu. */
const HASH_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** Label tombol per kanal. Urutannya mengikuti `SHARE_CHANNELS`. */
const CHANNEL_LABELS: Record<ShareChannel, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  sms: "SMS",
  native: "Bagikan…",
  copy: "Salin tautan",
};

const NOT_FOUND_HTML = errorPage(
  404,
  "Galeri tidak ditemukan",
  "Tautannya salah, atau galeri sudah kedaluwarsa. Minta ulang tautannya ke operator acara.",
);

/**
 * Skrip tombol native & copy.
 *
 * Ditulis statis — tidak ada nilai operator yang disisipkan ke dalam JS. Data
 * tombol dibaca dari atribut `data-*` yang sudah di-escape di HTML; menyisipkan
 * string apa pun langsung ke `<script>` akan menjadikan branding sebagai jalur
 * eksekusi kode di browser tamu.
 */
const SHARE_SCRIPT = `<script>
  document.querySelectorAll("button[data-share]").forEach(function (button) {
    button.addEventListener("click", async function () {
      const url = button.dataset.url;
      const title = button.dataset.title;
      if (button.dataset.share === "native" && navigator.share) {
        try {
          await navigator.share({ title: title, url: url });
          return;
        } catch (error) {
          // Tamu menutup dialog share — tidak ada yang perlu dilakukan.
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        button.textContent = "Tautan disalin";
      } catch (error) {
        // Clipboard diblokir (mis. halaman non-HTTPS): tampilkan tautannya
        // supaya tamu masih bisa menyalin manual.
        window.prompt("Salin tautan ini", url);
      }
    });
  });
</script>`;

/** Branding tersimpan atau default — halaman publik selalu butuh nilai. */
function brandingOf(ctx: ServerContext): Branding {
  return getBranding(ctx.db) ?? { ...DEFAULT_BRANDING };
}

function absolute(request: FastifyRequest, path: string): string {
  return `${request.protocol}://${request.host}${path}`;
}

/**
 * Satu tombol share.
 *
 * Kanal yang punya URL (`whatsapp`/`email`/`sms`) jadi `<a>` biasa yang jalan
 * tanpa JavaScript; `native`/`copy` butuh API browser, jadi jadi `<button>`
 * yang datanya dibaca skrip di atas. `shareLink` mengembalikan `null` untuk
 * keduanya — itu sinyal "bukan tautan", bukan kesalahan.
 */
function shareButton(channel: ShareChannel, target: ShareTarget): string {
  const label = escapeHtml(CHANNEL_LABELS[channel]);
  const href = shareLink(channel, target);
  if (href !== null) return `<a class="btn" href="${escapeHtml(href)}">${label}</a>`;

  return (
    `<button class="btn" type="button" data-share="${channel}" ` +
    `data-url="${escapeHtml(target.url)}" data-title="${escapeHtml(target.title)}">${label}</button>`
  );
}

type ShareRequest = FastifyRequest<{ Params: { hash: string } }>;

/**
 * Satu handler untuk kedua path.
 *
 * Ditulis sebagai fungsi yang menerima `ctx`, bukan sebagai closure yang
 * disalin dua kali: kalau `app.get` didaftarkan dua kali dengan dua salinan
 * handler, perbaikan di salah satunya akan lolos dari tes yang cuma menguji
 * satu path.
 */
async function renderShare(
  request: ShareRequest,
  reply: FastifyReply,
  ctx: ServerContext,
): Promise<FastifyReply> {
  const { hash } = request.params;
  // Bentuk hash diperiksa sebelum menyentuh DB — sama persis dengan halaman
  // galeri tamu, supaya jalur 404 kedua halaman tidak bisa berbeda.
  const gallery = HASH_RE.test(hash) ? getGalleryByHash(ctx.db, hash) : null;
  if (gallery === null) {
    return reply.status(404).type("text/html; charset=utf-8").send(NOT_FOUND_HTML);
  }

  const event = getEvent(ctx.db, gallery.eventId);
  const branding = brandingOf(ctx);

  // Judul/deskripsi memakai fungsi yang sama dengan halaman galeri, jadi kartu
  // share tidak bisa berbeda dari halaman yang dibuka tamu.
  const heading = resolvedHeading(branding, event?.name ?? null);
  const subheading = resolvedSubheading(
    branding,
    event === null ? null : { name: event.name, date: event.date, hashtag: event.hashtag ?? null },
  );
  // Deskripsi kosong bikin crawler menampilkan kartu tanpa keterangan; satu
  // kalimat ajakan lebih baik daripada `content=""`.
  const description = subheading === "" ? "Ambil & bagikan fotonya." : subheading;

  const galleryUrl = absolute(request, `${GALLERY_BASE_PATH}${gallery.hash}`);
  const target: ShareTarget = { url: galleryUrl, title: sharePageTitle(heading, event?.name ?? null) };

  const buttons = SHARE_CHANNELS.map((channel) => shareButton(channel, target)).join("\n          ");

  const head = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(heading)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(galleryUrl)}">`,
    // Tanpa logo tidak ada `og:image` sama sekali: URL kosong membuat crawler
    // menampilkan kotak rusak, dan itu lebih buruk daripada kartu tanpa gambar.
    ...(branding.logoUrl === null
      ? []
      : [`<meta property="og:image" content="${escapeHtml(branding.logoUrl)}">`]),
    `<meta name="twitter:card" content="summary">`,
  ].join("\n");

  const body = `
        <span class="badge">Bagikan album</span>
        ${branding.logoUrl === null ? "" : `<img class="logo" src="${escapeHtml(branding.logoUrl)}" alt="">`}
        <h1>${escapeHtml(heading)}</h1>
        ${subheading === "" ? "" : `<p>${escapeHtml(subheading)}</p>`}
        <div class="row">
          <a class="btn" href="${escapeHtml(galleryUrl)}">Buka galeri</a>
        </div>
        <div class="row">
          ${buttons}
        </div>
        ${branding.footer === "" ? "" : `<p class="note">${escapeHtml(branding.footer)}</p>`}`;

  return reply.type("text/html; charset=utf-8").send(shell(heading, body, head, SHARE_SCRIPT));
}

export async function shareRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  // Kedua path menunjuk handler yang sama; pembungkus panah dipakai karena
  // Fastify memanggil handler dengan (request, reply) saja.
  const handler = (request: ShareRequest, reply: FastifyReply) => renderShare(request, reply, ctx);

  // Bentuk pendek: ini yang dipakai di teks pesan share.
  app.get<{ Params: { hash: string } }>("/s/:hash", handler);
  // Bentuk konsisten dengan halaman publik galeri yang sudah ada (`/a/<hash>`).
  app.get<{ Params: { hash: string } }>(`${GALLERY_BASE_PATH}:hash/share`, handler);
}
