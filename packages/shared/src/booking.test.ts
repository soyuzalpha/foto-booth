/**
 * Tes logika booking (Fase 11).
 *
 * Yang diuji di sini semuanya aritmetika waktu dan aturan transisi — bagian
 * yang kalau salah tidak melempar error apa pun, cuma membuat kalender
 * operator berbohong (slot ganda, atau slot kosong yang ditolak).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  availableSlots,
  BOOKING_STATUSES,
  buildIcs,
  canTransition,
  conflictsWithBuffer,
  findConflict,
  generateSlots,
  icsEscape,
  icsStamp,
  isTerminal,
  localParts,
  minutesToTime,
  occupancyReport,
  overlaps,
  parseTimeToMinutes,
  slotInstant,
  weekdayOf,
  type DayHours,
} from "./booking.ts";

/** Offset WIB (UTC+7) seperti `getTimezoneOffset()` Java. */
const WIB = -420;

/* ---- jam dinding -------------------------------------------------- */

test("parseTimeToMinutes menerima HH:MM dan menolak yang tidak masuk akal", () => {
  assert.equal(parseTimeToMinutes("09:30"), 570);
  assert.equal(parseTimeToMinutes("00:00"), 0);
  assert.equal(parseTimeToMinutes("23:59"), 1439);
  assert.equal(parseTimeToMinutes("9:05"), 545);
  assert.equal(parseTimeToMinutes("24:00"), null);
  assert.equal(parseTimeToMinutes("09:60"), null);
  assert.equal(parseTimeToMinutes("pagi"), null);
});

test("minutesToTime bolak-balik dengan parseTimeToMinutes", () => {
  for (const value of ["00:00", "07:05", "09:30", "13:00", "23:59"]) {
    const minutes = parseTimeToMinutes(value);
    assert.notEqual(minutes, null);
    assert.equal(minutesToTime(minutes as number), value);
  }
});

test("slotInstant + localParts bolak-balik di zona WIB", () => {
  // 09:00 WIB (UTC+7) = 02:00 UTC hari yang sama.
  const instant = slotInstant("2026-11-01", 540, WIB);
  assert.equal(instant, "2026-11-01T02:00:00.000Z");

  const back = localParts(instant, WIB);
  assert.deepEqual(back, { date: "2026-11-01", time: "09:00", minutes: 540 });
});

test("slotInstant menyeberang hari saat zona di timur jauh", () => {
  // 23:00 WIB 1 Nov = 16:00 UTC 1 Nov; tapi 01:00 WIB 2 Nov = 18:00 UTC 1 Nov.
  assert.equal(slotInstant("2026-11-02", 60, WIB), "2026-11-01T18:00:00.000Z");
});

test("weekdayOf: 2026-10-12 = Senin (1), 2026-11-01 = Minggu (0)", () => {
  assert.equal(weekdayOf("2026-10-12"), 1);
  assert.equal(weekdayOf("2026-11-01"), 0);
});

/* ---- slot --------------------------------------------------------- */

const HOURS: DayHours[] = [
  { weekday: 1, open: "09:00", close: "21:00" }, // Senin
  { weekday: 2, open: "10:00", close: "18:00" }, // Selasa
];

test("generateSlots hari tutup = kosong", () => {
  // 2026-11-01 Minggu — tidak ada di HOURS.
  assert.deepEqual(generateSlots({ dateISO: "2026-11-01", hours: HOURS, durationMinutes: 60, timezoneOffsetMinutes: WIB }), []);
});

test("generateSlots: sesi 60 menit buka 09–21 = 12 slot, terakhir 20:00", () => {
  const slots = generateSlots({ dateISO: "2026-10-12", hours: HOURS, durationMinutes: 60, timezoneOffsetMinutes: WIB });
  assert.equal(slots.length, 12);
  assert.equal(slots[0]?.label, "09:00–10:00");
  assert.equal(slots[11]?.label, "20:00–21:00");
});

test("generateSlots: sesi 90 menit muat tepat sampai jam tutup", () => {
  const slots = generateSlots({ dateISO: "2026-10-12", hours: HOURS, durationMinutes: 90, timezoneOffsetMinutes: WIB });
  assert.equal(slots.length, 8);
  assert.equal(slots[7]?.label, "19:30–21:00");
});

test("generateSlots menghormati jam buka per hari dan step sendiri", () => {
  const selasa = generateSlots({ dateISO: "2026-10-13", hours: HOURS, durationMinutes: 60, timezoneOffsetMinutes: WIB });
  assert.equal(selasa[0]?.label, "10:00–11:00");
  assert.equal(selasa.length, 8);

  const step30 = generateSlots({
    dateISO: "2026-10-12",
    hours: HOURS,
    durationMinutes: 60,
    stepMinutes: 30,
    timezoneOffsetMinutes: WIB,
  });
  assert.equal(step30[0]?.label, "09:00–10:00");
  assert.equal(step30[1]?.label, "09:30–10:30");
  assert.equal(step30.length, 23); // 540..1200 tiap 30 menit
});

test("generateSlots menolak durasi/step tidak positif", () => {
  assert.deepEqual(generateSlots({ dateISO: "2026-10-12", hours: HOURS, durationMinutes: 0, timezoneOffsetMinutes: WIB }), []);
  assert.deepEqual(
    generateSlots({ dateISO: "2026-10-12", hours: HOURS, durationMinutes: 60, stepMinutes: -5, timezoneOffsetMinutes: WIB }),
    [],
  );
});

/* ---- tabrakan & buffer -------------------------------------------- */

test("overlaps memakai interval setengah-terbuka: berdempetan bukan tabrakan", () => {
  const a = { start: "2026-10-12T02:00:00.000Z", end: "2026-10-12T03:00:00.000Z" };
  const b = { start: "2026-10-12T03:00:00.000Z", end: "2026-10-12T04:00:00.000Z" };
  assert.equal(overlaps(a, b), false);

  const c = { start: "2026-10-12T02:59:00.000Z", end: "2026-10-12T04:00:00.000Z" };
  assert.equal(overlaps(a, c), true);
});

test("buffer memblokir slot yang berdempetan", () => {
  const taken = { start: "2026-10-12T02:00:00.000Z", end: "2026-10-12T03:00:00.000Z" };
  const next = { start: "2026-10-12T03:00:00.000Z", end: "2026-10-12T04:00:00.000Z" };

  assert.equal(conflictsWithBuffer(next, taken, 0), false);
  assert.equal(conflictsWithBuffer(next, taken, 15), true);

  // Buffer juga berlaku ke sisi sebaliknya: booking yang datang lebih awal.
  const before = { start: "2026-10-12T01:00:00.000Z", end: "2026-10-12T02:00:00.000Z" };
  assert.equal(conflictsWithBuffer(before, taken, 15), true);
  assert.equal(conflictsWithBuffer(before, taken, 0), false);
});

test("findConflict mengembalikan booking yang bentrok, bukan sekadar true", () => {
  const taken = [
    { id: "b1", start: "2026-10-12T02:00:00.000Z", end: "2026-10-12T03:00:00.000Z" },
    { id: "b2", start: "2026-10-12T05:00:00.000Z", end: "2026-10-12T06:00:00.000Z" },
  ];
  const hit = findConflict({ start: "2026-10-12T05:30:00.000Z", end: "2026-10-12T06:30:00.000Z" }, taken, 0);
  assert.equal(hit?.id, "b2");

  assert.equal(findConflict({ start: "2026-10-12T03:00:00.000Z", end: "2026-10-12T04:00:00.000Z" }, taken, 0), null);
});

test("availableSlots menyaring slot yang terisi", () => {
  const slots = generateSlots({ dateISO: "2026-10-12", hours: HOURS, durationMinutes: 60, timezoneOffsetMinutes: WIB });
  // Ambil slot 10:00–11:00 sebagai yang sudah terisi.
  const taken = [{ start: slots[1]!.start, end: slots[1]!.end }];
  const free = availableSlots(slots, taken, 0);
  assert.equal(free.length, 11);
  assert.equal(free.some((slot) => slot.label === "10:00–11:00"), false);
});

/* ---- transisi status ---------------------------------------------- */

test("transisi status hanya yang masuk akal", () => {
  assert.equal(canTransition("requested", "approved"), true);
  assert.equal(canTransition("requested", "rejected"), true);
  assert.equal(canTransition("requested", "cancelled"), true);
  assert.equal(canTransition("requested", "completed"), false);

  assert.equal(canTransition("approved", "completed"), true);
  assert.equal(canTransition("approved", "cancelled"), true);
  assert.equal(canTransition("approved", "rejected"), false);

  // Status akhir tidak bisa keluar.
  for (const terminal of ["rejected", "cancelled", "completed"] as const) {
    assert.equal(isTerminal(terminal), true);
    for (const to of BOOKING_STATUSES) assert.equal(canTransition(terminal, to), false);
  }
  assert.equal(isTerminal("requested"), false);
  assert.equal(isTerminal("approved"), false);
});

/* ---- laporan ------------------------------------------------------ */

test("occupancyReport memisahkan terpakai, menunggu, dan batal", () => {
  const report = occupancyReport(
    [
      { status: "approved", start: "2026-10-12T02:00:00.000Z", priceIdr: 500_000, depositIdr: 100_000 },
      { status: "completed", start: "2026-10-11T02:00:00.000Z", priceIdr: 500_000, depositIdr: 100_000 },
      { status: "requested", start: "2026-10-13T02:00:00.000Z", priceIdr: 500_000, depositIdr: 100_000 },
      { status: "cancelled", start: "2026-10-14T02:00:00.000Z", priceIdr: 500_000, depositIdr: 100_000 },
      { status: "rejected", start: "2026-10-15T02:00:00.000Z", priceIdr: 500_000, depositIdr: 100_000 },
    ],
    120,
  );

  assert.equal(report.booked, 2);
  assert.equal(report.requested, 1);
  assert.equal(report.cancelled, 1);
  assert.equal(report.rejected, 1);
  assert.equal(report.bookedHours, 4);
  // Pendapatan hanya dari yang selesai; deposit dari approved + completed.
  assert.equal(report.revenueIdr, 500_000);
  assert.equal(report.depositIdr, 200_000);
});

/* ---- .ics --------------------------------------------------------- */

test("icsStamp menghasilkan bentuk UTC tanpa tanda baca", () => {
  assert.equal(icsStamp("2026-11-01T02:00:00.000Z"), "20261101T020000Z");
});

test("icsEscape menetralkan koma, titik-koma, backslash, dan baris baru", () => {
  assert.equal(icsEscape("Budi; Sarah, dan Andi"), "Budi\\; Sarah\\, dan Andi");
  assert.equal(icsEscape("baris1\nbaris2"), "baris1\\nbaris2");
  assert.equal(icsEscape("C:\\foto"), "C:\\\\foto");
});

test("buildIcs: CRLF, properti wajib, dan STATUS:CANCELLED", () => {
  const ics = buildIcs(
    [
      {
        uid: "bk_1@foto-booth",
        start: "2026-11-01T02:00:00.000Z",
        end: "2026-11-01T03:00:00.000Z",
        summary: "Pernikahan Budi & Sarah",
        description: "Paket 2 jam",
        location: "Gedung A",
      },
      {
        uid: "bk_2@foto-booth",
        start: "2026-11-02T02:00:00.000Z",
        end: "2026-11-02T03:00:00.000Z",
        summary: "Sesi batal",
        cancelled: true,
      },
    ],
    { now: "2026-10-12T00:00:00.000Z" },
  );

  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal(ics.includes("\n\n"), false);
  assert.ok(ics.includes("DTSTART:20261101T020000Z"));
  assert.ok(ics.includes("DTSTAMP:20261012T000000Z"));
  assert.ok(ics.includes("SUMMARY:Pernikahan Budi & Sarah"));
  assert.ok(ics.includes("LOCATION:Gedung A"));
  assert.equal(ics.match(/STATUS:CONFIRMED/g)?.length, 1);
  assert.equal(ics.match(/STATUS:CANCELLED/g)?.length, 1);
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2);
});

test("buildIcs melipat baris panjang > 75 oktet", () => {
  const long = "Sesi foto keluarga besar ".repeat(6).trim();
  const ics = buildIcs(
    [{ uid: "bk_9@foto-booth", start: "2026-11-01T02:00:00.000Z", end: "2026-11-01T03:00:00.000Z", summary: long }],
    { now: "2026-10-12T00:00:00.000Z" },
  );

  const lines = ics.split("\r\n");
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, `baris terlalu panjang: ${line}`);
  }
  // Baris lanjutan dimulai satu spasi, dan isinya tetap utuh setelah digabung.
  const folded = lines.filter((line) => line.startsWith(" "));
  assert.ok(folded.length >= 1);

  let unfolded = "";
  for (const line of lines) {
    if (line.startsWith(" ") && unfolded !== "") unfolded += line.slice(1);
    else unfolded += line;
  }
  assert.ok(unfolded.includes(`SUMMARY:${long}`));
});
