/**
 * Tes penyimpan CSV.
 *
 * Yang diuji cuma tiga hal yang gampang rusak tanpa kelihatan:
 *
 *   1. **BOM ikut terkirim.** Tanpa itu Excel Windows membaca berkasnya
 *      sebagai ANSI dan nama beraksen jadi rusak — kerusakan yang baru
 *      ketahuan setelah berkasnya sampai ke klien.
 *   2. **Nama berkas dari parameter**, bukan "download" bawaan browser.
 *   3. **Tanpa DOM, tidak melempar.** Lingkungan uji tidak punya `document`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { downloadCsv, REVOKE_DELAY_MS } from "./downloadCsv.ts";

interface FakeLink {
  href: string;
  download: string;
  clicked: number;
  removed: number;
}

function fakeDoc(): { doc: Document; links: FakeLink[] } {
  const links: FakeLink[] = [];
  const doc = {
    createElement: () => {
      const link: FakeLink = { href: "", download: "", clicked: 0, removed: 0 };
      links.push(link);
      return {
        set href(value: string) {
          link.href = value;
        },
        get href() {
          return link.href;
        },
        set download(value: string) {
          link.download = value;
        },
        get download() {
          return link.download;
        },
        click: () => {
          link.clicked += 1;
        },
        remove: () => {
          link.removed += 1;
        },
      };
    },
    body: { appendChild: () => {} },
  } as unknown as Document;
  return { doc, links };
}

test("BOM benar-benar ikut lewat pembacaan byte", async () => {
  const { doc } = fakeDoc();
  const holder: { blob: Blob | null } = { blob: null };

  downloadCsv("leads.csv", "waktu,nama\n2026-10-12,Budi\n", {
    document: doc,
    createObjectUrl: (blob) => {
      holder.blob = blob;
      return "blob:1";
    },
    revokeObjectUrl: () => {},
    setTimer: () => 0,
  });

  const blob = holder.blob;
  assert.ok(blob !== null);

  // Diperiksa di level byte: `Blob.text()` menghapus BOM saat mendekode, jadi
  // teksnya selalu tampak "tanpa BOM" walau byte-nya ada.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xef, 0xbb, 0xbf]);
  assert.match(await blob.text(), /Budi/);
});

test("nama berkas dipakai apa adanya dan tautannya dibersihkan", () => {
  const { doc, links } = fakeDoc();

  const ok = downloadCsv("leads-2026-10-12.csv", "a\n", {
    document: doc,
    createObjectUrl: () => "blob:1",
    revokeObjectUrl: () => {},
    setTimer: () => 0,
  });

  assert.equal(ok, true);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.download, "leads-2026-10-12.csv");
  assert.equal(links[0]?.clicked, 1);
  assert.equal(links[0]?.removed, 1);
});

test("URL blob dilepas setelah jeda, bukan langsung", () => {
  const { doc } = fakeDoc();
  const revoked: string[] = [];
  const scheduled: { fn: (() => void) | null; ms: number | null } = { fn: null, ms: null };

  downloadCsv("leads.csv", "a\n", {
    document: doc,
    createObjectUrl: () => "blob:9",
    revokeObjectUrl: (url) => revoked.push(url),
    setTimer: (fn, ms) => {
      scheduled.fn = fn;
      scheduled.ms = ms;
      return 0;
    },
  });

  // Belum dilepas: melepas langsung membatalkan unduhan di Safari.
  assert.deepEqual(revoked, []);
  assert.equal(scheduled.ms, REVOKE_DELAY_MS);
  scheduled.fn?.();
  assert.deepEqual(revoked, ["blob:9"]);
});

test("tanpa DOM, fungsi ini diam dan mengembalikan false", () => {
  const ok = downloadCsv("leads.csv", "a\n", {
    document: undefined,
    createObjectUrl: () => "blob:1",
    revokeObjectUrl: () => {},
    setTimer: () => 0,
  });
  // Di Node `document` tidak ada; yang penting tidak melempar.
  assert.equal(ok, false);
});
