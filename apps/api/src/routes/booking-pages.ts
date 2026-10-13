/**
 * Halaman booking publik — form pemesanan dan halaman status.
 *
 * Dua halaman, dua strategi, dan bedanya disengaja:
 *
 *   · **`/booking/s/<token>` dirender penuh dari server.** Halaman ini yang
 *     dibuka tamu dari tautan WhatsApp, sering di ponsel dengan sinyal buruk.
 *     Status, jadwal, dan jumlah deposit harus terbaca tanpa JavaScript. Satu-
 *     satunya yang butuh JS adalah tombol batal, dan tanpa JS tombolnya tidak
 *     muncul sama sekali — lebih baik tidak ada tombol daripada tombol mati.
 *
 *   · **`/booking` butuh JavaScript.** Bukan pilihan gaya: memilih slot berarti
 *     memuat ulang ketersediaan setiap kali tanggal berubah, dan kalau itu
 *     dikerjakan server-side, satu perubahan tanggal = satu reload halaman.
 *     Karena itu form ini bicara ke API JSON yang sama dengan studio, jadi
 *     aturan booking (slot, bentrok, jarak minimum) cuma ada di satu tempat —
 *     tidak ada dua implementasi yang bisa berbeda diam-diam.
 *
 * Yang tidak pernah dilakukan halaman ini: menghitung sendiri apakah sebuah
 * slot tersedia. Semua keputusan "bisa/tidak" datang dari server.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  BOOKING_BASE_PATH,
  BOOKING_STATUS_LABELS,
  BOOKING_STATUS_PATH,
  BOOKING_TOKEN_RE,
  DEFAULT_BOOKING_SETTINGS,
  DEPOSIT_STATUS_LABELS,
  formatDateTimeId,
  type Booking,
  type BookingSettings,
} from "@foto-booth/shared";

import type { ServerContext } from "../context.ts";
import { formatIdr } from "../deposit.ts";
import { escapeHtml, errorPage, shell } from "../pages.ts";
import { getBookingByToken, getBookingSettings } from "../store.ts";

/** CSS khusus booking — form yang lebih tinggi dari kartu galeri. */
const BOOKING_CSS = `<style>
  .card { max-width:640px; }
  .field { display:flex; flex-direction:column; gap:6px; margin:0 0 16px; }
  .field label { font-weight:800; font-size:14px; text-transform:uppercase; letter-spacing:.04em; }
  .field input, .field select, .field textarea {
    border:3px solid var(--ink); padding:12px; font-size:16px; font-family:inherit; background:#fff; width:100%; }
  .field textarea { min-height:80px; resize:vertical; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media (max-width:520px) { .two { grid-template-columns:1fr; } }
  fieldset { border:3px solid var(--ink); padding:14px; margin:0 0 16px; }
  legend { font-weight:800; font-size:14px; text-transform:uppercase; letter-spacing:.04em; padding:0 6px; }
  .slots { display:flex; flex-wrap:wrap; gap:10px; }
  .slots label { display:inline-flex; align-items:center; gap:8px; border:3px solid var(--ink);
                 padding:10px 14px; font-weight:700; cursor:pointer; background:#fff; }
  .slots label:has(input:disabled) { opacity:.35; cursor:not-allowed; text-decoration:line-through; }
  .slots input { accent-color:#ff6b9d; }
  .hp { position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden; }
  .alert { border:3px solid #c00; color:#c00; padding:12px; font-weight:700; margin:0 0 16px; }
  .ok { border:3px solid #067d3e; color:#067d3e; padding:12px; font-weight:700; margin:0 0 16px; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:6px 16px; margin:0 0 20px; }
  .kv dt { font-weight:800; }
  .kv dd { margin:0; }
  h2 { font-size:20px; margin:20px 0 6px; }
  hr { border:none; border-top:3px solid var(--ink); margin:24px 0; }
  input[type=date] { border:3px solid var(--ink); padding:12px; font-size:16px; font-family:inherit; background:#fff; }
  #move-slots { margin:14px 0 0; }
  .muted { color:#555; font-size:14px; }
</style>`;

const FORM_SCRIPT = `<script>
(function () {
  var pkgs = document.getElementById("pkg");
  var date = document.getElementById("date");
  var slots = document.getElementById("slots");
  var alertBox = document.getElementById("alert");
  var form = document.getElementById("booking-form");
  var submit = document.getElementById("submit");
  var depositNote = document.getElementById("deposit-note");

  function fail(message) {
    alertBox.textContent = message;
    alertBox.hidden = false;
  }
  function clearFail() { alertBox.hidden = true; }

  function loadPackages() {
    fetch("/v1/booking/packages")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        pkgs.innerHTML = "";
        if (!data.packages.length) {
          fail("Belum ada paket yang ditawarkan. Hubungi operator lewat WhatsApp.");
          submit.disabled = true;
          return;
        }
        data.packages.forEach(function (pkg) {
          var option = document.createElement("option");
          option.value = pkg.id;
          option.textContent = pkg.name + " · " + pkg.durationMinutes + " menit · " + rupiah(pkg.priceIdr);
          pkgs.appendChild(option);
        });
        loadSlots();
      })
      .catch(function () { fail("Gagal memuat paket. Muat ulang halaman ini."); });
  }

  function rupiah(amount) {
    var digits = String(Math.abs(Math.round(amount)));
    var out = "";
    for (var i = 0; i < digits.length; i += 1) {
      if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
      out += digits[i];
    }
    return "Rp" + out;
  }

  function loadSlots() {
    clearFail();
    slots.innerHTML = "Memuat jadwal…";
    if (!pkgs.value || !date.value) { slots.innerHTML = ""; return; }
    fetch("/v1/booking/availability?packageId=" + encodeURIComponent(pkgs.value) +
          "&date=" + encodeURIComponent(date.value))
      .then(function (r) {
        if (!r.ok) throw new Error("availability");
        return r.json();
      })
      .then(function (data) {
        slots.innerHTML = "";
        var free = data.slots.filter(function (s) { return s.available; });
        if (!free.length) {
          slots.innerHTML = '<p class="muted">Tidak ada slot kosong di tanggal ini. Coba tanggal lain.</p>';
          return;
        }
        free.forEach(function (slot) {
          var label = document.createElement("label");
          var input = document.createElement("input");
          input.type = "radio";
          input.name = "start";
          input.value = slot.start;
          label.appendChild(input);
          label.appendChild(document.createTextNode(slot.label));
          slots.appendChild(label);
        });
      })
      .catch(function () { slots.innerHTML = '<p class="muted">Gagal memuat jadwal. Coba lagi.</p>'; });
  }

  pkgs.addEventListener("change", loadSlots);
  date.addEventListener("change", loadSlots);

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    clearFail();
    var picked = form.querySelector('input[name="start"]:checked');
    if (!picked) { fail("Pilih jam sesi dulu."); return; }

    submit.disabled = true;
    submit.textContent = "Mengirim…";

    fetch("/v1/booking/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        packageId: pkgs.value,
        name: document.getElementById("name").value,
        email: document.getElementById("email").value,
        phone: document.getElementById("phone").value,
        start: picked.value,
        notes: document.getElementById("notes").value || undefined,
        consent: document.getElementById("consent").checked,
        website: document.getElementById("website").value
      })
    })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status === 202 && res.body.token) {
          window.location.href = ${JSON.stringify(BOOKING_STATUS_PATH)} + res.body.token;
          return;
        }
        if (res.status === 202) {
          // Honeypot: server membalas seolah sukses. Jangan bingungkan manusia
          // yang mengisi form asli — arahkan ke halaman bantuan.
          fail("Permintaan tidak bisa diproses. Hubungi operator lewat WhatsApp.");
        } else if (res.status === 409) {
          fail(res.body.message || "Slot itu sudah terisi. Pilih jam lain.");
          loadSlots();
        } else if (res.status === 429) {
          fail("Terlalu banyak percobaan dari jaringan ini. Coba lagi satu jam lagi.");
        } else {
          fail(res.body.message || "Permintaan ditolak. Periksa isian lalu coba lagi.");
        }
        submit.disabled = false;
        submit.textContent = "Kirim permintaan";
      })
      .catch(function () {
        fail("Gagal mengirim. Periksa koneksi lalu coba lagi.");
        submit.disabled = false;
        submit.textContent = "Kirim permintaan";
      });
  });

  loadPackages();
  if (depositNote) {
    fetch("/v1/booking/packages").then(function (r) { return r.json(); }).then(function (data) {
      depositNote.textContent = data.paymentProvider === "none"
        ? "Pembayaran belum tersambung — operator akan mengirim instruksi deposit lewat WhatsApp."
        : "Instruksi deposit dikirim operator lewat WhatsApp setelah permintaan diterima.";
    }).catch(function () {});
  }
})();
</script>`;

function bookingFormPage(settings: BookingSettings, todayISO: string, maxISO: string): string {
  const timezone =
    settings.timezoneOffsetMinutes === -420
      ? "WIB"
      : `UTC${settings.timezoneOffsetMinutes >= 0 ? "+" : "-"}${Math.abs(settings.timezoneOffsetMinutes / 60)}`;

  return shell(
    "Booking sesi foto",
    `<span class="badge">Booking</span>
     <h1>Pesan sesi foto</h1>
     <p>Pilih paket dan jam yang kosong. Permintaanmu masuk dulu ke operator — jadwal baru
        terkunci setelah dikonfirmasi.</p>
     <p class="alert" id="alert" hidden></p>
     <form id="booking-form" novalidate>
       <div class="field">
         <label for="pkg">Paket</label>
         <select id="pkg" required><option>Memuat…</option></select>
       </div>
       <div class="two">
         <div class="field">
           <label for="date">Tanggal</label>
           <input type="date" id="date" value="${escapeHtml(todayISO)}"
                  min="${escapeHtml(todayISO)}" max="${escapeHtml(maxISO)}" required>
         </div>
         <div class="field">
           <label for="name">Nama</label>
           <input type="text" id="name" maxlength="120" autocomplete="name" required>
         </div>
       </div>
       <fieldset>
         <legend>Jam sesi (${escapeHtml(timezone)})</legend>
         <div class="slots" id="slots"></div>
       </fieldset>
       <div class="two">
         <div class="field">
           <label for="email">Email</label>
           <input type="email" id="email" maxlength="200" autocomplete="email" required>
         </div>
         <div class="field">
           <label for="phone">WhatsApp</label>
           <input type="tel" id="phone" maxlength="32" autocomplete="tel" required>
         </div>
       </div>
       <div class="field">
         <label for="notes">Catatan (opsional)</label>
         <textarea id="notes" maxlength="1000" placeholder="Jumlah orang, tema, permintaan khusus…"></textarea>
       </div>
       <div class="field">
         <label style="font-weight:600;text-transform:none;letter-spacing:0;display:flex;gap:10px;align-items:flex-start">
           <input type="checkbox" id="consent" style="width:auto;margin-top:4px" required>
           <span>Saya setuju data nama, email, dan nomor WhatsApp disimpan untuk keperluan
                 booking ini.</span>
         </label>
       </div>
       <div class="hp" aria-hidden="true">
         <label for="website">Website</label>
         <input type="text" id="website" tabindex="-1" autocomplete="off">
       </div>
       <button class="btn" type="submit" id="submit">Kirim permintaan</button>
     </form>
     <p class="note" id="deposit-note"></p>
     <noscript>
       <p class="alert">Halaman ini butuh JavaScript untuk memilih jam. Kalau tidak bisa
          diaktifkan, hubungi operator lewat WhatsApp — sebutkan paket, tanggal, dan jam
          yang diinginkan.</p>
     </noscript>`,
    BOOKING_CSS,
    FORM_SCRIPT,
  );
}

function statusPage(
  booking: Booking,
  deposit: { amountIdr: number; status: string; instructions: string | null },
  timezoneOffsetMinutes: number,
): string {
  const statusLabel = BOOKING_STATUS_LABELS[booking.status] ?? booking.status;
  const depositLabel = DEPOSIT_STATUS_LABELS[booking.depositStatus] ?? booking.depositStatus;
  const cancellable = booking.status === "requested" || booking.status === "approved";

  const depositBlock =
    booking.depositIdr > 0
      ? `<dt>Deposit</dt><dd>${escapeHtml(formatIdr(booking.depositIdr))} · ${escapeHtml(depositLabel)}</dd>`
      : `<dt>Deposit</dt><dd>Tidak ada</dd>`;

  return shell(
    "Status booking",
    `<span class="badge">${escapeHtml(statusLabel)}</span>
     <h1>${escapeHtml(booking.packageName)}</h1>
     <p class="muted">Simpan halaman ini — tautannya satu-satunya cara melihat status bookingmu.</p>
     <dl class="kv">
       <dt>Jadwal</dt><dd>${escapeHtml(formatDateTimeId(booking.start, timezoneOffsetMinutes))} – ${escapeHtml(formatDateTimeId(booking.end, timezoneOffsetMinutes))}</dd>
       <dt>Nama</dt><dd>${escapeHtml(booking.name)}</dd>
       <dt>Paket</dt><dd>${escapeHtml(booking.packageName)} (${booking.durationMinutes} menit)</dd>
       <dt>Harga</dt><dd>${escapeHtml(formatIdr(booking.priceIdr))}</dd>
       ${depositBlock}
       <dt>Status</dt><dd>${escapeHtml(statusLabel)}</dd>
     </dl>
     ${booking.status === "cancelled" && booking.reason ? `<p class="muted">Alasan: ${escapeHtml(booking.reason)}</p>` : ""}
     ${deposit.instructions ? `<p class="muted">${escapeHtml(deposit.instructions)}</p>` : ""}
     ${cancellable ? `<hr>
     <h2>Geser jadwal</h2>
     <p class="muted">Pilih tanggal lalu jam baru. Jadwal hanya bisa digeser beberapa jam sebelum sesi dimulai — jam yang terlalu dekat tidak akan muncul.</p>
     <label for="move-date">Tanggal baru</label>
     <input type="date" id="move-date" />
     <div id="move-slots" class="slots"></div>
     <button class="btn" type="button" id="move" disabled>Simpan jadwal baru</button>
     <p class="note" id="move-note"></p>
     <hr>
     <button class="btn" type="button" id="cancel">Batalkan booking</button>
     <p class="note" id="cancel-note"></p>` : ""}
     <script>
     (function () {
       var cancel = document.getElementById("cancel");
       var move = document.getElementById("move");
       var moveDate = document.getElementById("move-date");
       var moveSlots = document.getElementById("move-slots");
       var moveNote = document.getElementById("move-note");
       var endpoint = ${JSON.stringify(`${BOOKING_STATUS_PATH}${booking.token}`)}.replace("/booking/s/", "/v1/booking/status/");

       function loadMoveSlots() {
        if (!moveDate || !moveDate.value) { moveSlots.innerHTML = ""; move.disabled = true; return; }
        moveNote.textContent = "";
        moveSlots.textContent = "Memuat jadwal…";
        move.disabled = true;
        fetch("/v1/booking/availability?packageId=" + encodeURIComponent(${JSON.stringify(booking.packageId)}) +
              "&date=" + encodeURIComponent(moveDate.value))
          .then(function (response) { return response.json(); })
          .then(function (data) {
            moveSlots.innerHTML = "";
            var free = (data.slots || []).filter(function (slot) { return slot.available; });
            if (!free.length) {
              moveSlots.textContent = "Tidak ada jam kosong di tanggal itu. Coba tanggal lain.";
              return;
            }
            free.forEach(function (slot) {
              var label = document.createElement("label");
              var input = document.createElement("input");
              input.type = "radio";
              input.name = "move-start";
              input.value = slot.start;
              input.addEventListener("change", function () { move.disabled = false; });
              label.appendChild(input);
              label.appendChild(document.createTextNode(slot.label));
              moveSlots.appendChild(label);
            });
          })
          .catch(function () { moveSlots.textContent = "Gagal memuat jadwal. Coba lagi."; });
       }

       if (moveDate) moveDate.addEventListener("change", loadMoveSlots);

       if (move) {
         move.addEventListener("click", function () {
           var picked = document.querySelector('input[name="move-start"]:checked');
           if (!picked) { moveNote.textContent = "Pilih jam baru dulu."; return; }
           move.disabled = true;
           moveNote.textContent = "Menyimpan…";
           fetch(endpoint + "/reschedule", {
             method: "POST",
             headers: { "content-type": "application/json" },
             body: JSON.stringify({ start: picked.value })
           }).then(function (response) {
             return response.json().then(function (body) { return { ok: response.ok, body: body }; });
           }).then(function (result) {
             if (result.ok) { window.location.reload(); return; }
             moveNote.textContent = result.body.message || "Jadwal baru tidak bisa dipakai. Pilih jam lain.";
             move.disabled = false;
           }).catch(function () {
             moveNote.textContent = "Gagal menghubungi server.";
             move.disabled = false;
           });
         });
       }

       if (!cancel) return;
       cancel.addEventListener("click", function () {
         if (!window.confirm("Batalkan booking ini?")) return;
         cancel.disabled = true;
         fetch(endpoint + "/cancel", {
           method: "POST",
           headers: { "content-type": "application/json" },
           body: "{}"
         }).then(function (response) {
           if (response.ok) window.location.reload();
           else document.getElementById("cancel-note").textContent =
             "Tidak bisa dibatalkan sekarang. Hubungi operator.";
         }).catch(function () {
           document.getElementById("cancel-note").textContent = "Gagal menghubungi server.";
           cancel.disabled = false;
         });
       });
     })();
     </script>`,
    BOOKING_CSS,
  );
}

/** Tanggal lokal `YYYY-MM-DD` dari instant, memakai offset operator. */
function localDateISO(instant: string, offsetMinutes: number): string {
  return new Date(new Date(instant).getTime() - offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export async function bookingPageRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const settingsOf = (): BookingSettings => getBookingSettings(ctx.db) ?? DEFAULT_BOOKING_SETTINGS;

  app.get(BOOKING_BASE_PATH, async (_request: FastifyRequest, reply) => {
    const settings = settingsOf();
    const now = ctx.now();
    const today = localDateISO(now.toISOString(), settings.timezoneOffsetMinutes);
    const max = localDateISO(
      new Date(now.getTime() + settings.maxAdvanceDays * 86_400_000).toISOString(),
      settings.timezoneOffsetMinutes,
    );
    return reply.type("text/html; charset=utf-8").send(bookingFormPage(settings, today, max));
  });

  app.get<{ Params: { token: string } }>(`${BOOKING_STATUS_PATH}:token`, async (request, reply) => {
    const { token } = request.params;
    // Bentuk token diperiksa dulu: permintaan dengan token asal-asalan tidak
    // perlu sampai menyentuh database.
    if (!BOOKING_TOKEN_RE.test(token)) {
      return reply
        .status(404)
        .type("text/html; charset=utf-8")
        .send(
          errorPage(
            404,
            "Booking tidak ditemukan",
            "Tautannya salah atau sudah kedaluwarsa. Minta ulang tautan ke operator.",
          ),
        );
    }

    const booking = getBookingByToken(ctx.db, token);
    if (booking === null) {
      return reply
        .status(404)
        .type("text/html; charset=utf-8")
        .send(
          errorPage(
            404,
            "Booking tidak ditemukan",
            "Tautannya salah atau sudah kedaluwarsa. Minta ulang tautan ke operator.",
          ),
        );
    }

    const settings = settingsOf();
    const instructions =
      booking.depositIdr > 0 && settings.paymentProvider !== "none"
        ? `Deposit ${formatIdr(booking.depositIdr)} dikonfirmasi manual oleh operator setelah pembayaran masuk.`
        : null;

    return reply
      .type("text/html; charset=utf-8")
      .send(statusPage(booking, { amountIdr: booking.depositIdr, status: booking.depositStatus, instructions }, settings.timezoneOffsetMinutes));
  });
}
