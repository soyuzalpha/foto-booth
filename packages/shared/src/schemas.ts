import { z } from "zod";

import { BOOKING_STATUSES, DEPOSIT_STATUSES } from "./booking.ts";
import { type Branding } from "./branding.ts";
import { CONTENT_KINDS } from "./constants.ts";
import {
  GUESTBOOK_ENTRY_KINDS,
  GUESTBOOK_LABEL_MAX,
  type GuestbookEntry,
} from "./guestbook.ts";
import {
  LEAD_FIELD_TYPES,
  LEAD_VALUE_MAX,
  type Lead,
  type LeadField,
} from "./leads.ts";
import { TEMPLATE_DPI_DEFAULT, TEMPLATE_MIN_EXPORT_DPI } from "./template.ts";

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

export const HealthSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});
export type Health = z.infer<typeof HealthSchema>;

/* ------------------------------------------------------------------ *
 * Event & galeri
 * ------------------------------------------------------------------ */

export const EventSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** ISO date (YYYY-MM-DD). */
  date: z.string(),
  hashtag: z.string().optional(),
  createdAt: z.string(),
});
export type Event = z.infer<typeof EventSchema>;

export const CreateEventSchema = EventSchema.omit({
  id: true,
  createdAt: true,
});
export type CreateEvent = z.infer<typeof CreateEventSchema>;

export const PhotoSchema = z.object({
  id: z.string(),
  galleryId: z.string(),
  url: z.string(),
  thumbUrl: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /**
   * MIME objek. Default `image/jpeg` supaya baris lama (dan klien lama yang
   * belum mengirim field ini) tetap lolos parse — bukan galat yang harus
   * ditangani operator.
   */
  contentType: z.string().default("image/jpeg"),
  createdAt: z.string(),
});
export type Photo = z.infer<typeof PhotoSchema>;

export const GallerySchema = z.object({
  id: z.string(),
  eventId: z.string(),
  /** Bagian URL publik: /a/<hash> */
  hash: z.string(),
  /** true = tamu harus memasukkan password sebelum melihat foto. */
  passwordProtected: z.boolean(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type Gallery = z.infer<typeof GallerySchema>;

/** Data yang dikirim API ke halaman galeri tamu. */
export const GalleryPublicSchema = GallerySchema.pick({
  hash: true,
  passwordProtected: true,
  expiresAt: true,
}).extend({
  event: EventSchema.pick({ name: true, date: true, hashtag: true }),
  photos: z.array(PhotoSchema),
});
export type GalleryPublic = z.infer<typeof GalleryPublicSchema>;

/* ------------------------------------------------------------------ *
 * Template (murni JSON — sama seperti aslinya)
 *
 * Bentuknya mengikuti `docs/SYSTEM-DESIGN.md` §3.4. Dua hal yang gampang
 * salah dan sengaja ditulis di sini:
 *   · `size.width/height` dalam INCI, `dpi` menentukan piksel canvas.
 *   · `x`/`y` semua elemen dalam PIKSEL canvas hasil, bukan inci.
 * ------------------------------------------------------------------ */

export const TemplateSizeSchema = z.object({
  /** Lebar dalam inci (boleh pecahan, mis. A4 = 8.27). */
  width: z.number().positive(),
  /** Tinggi dalam inci. */
  height: z.number().positive(),
  /** DPI target saat cetak. Minimal 300 supaya hasil tidak kasar. */
  dpi: z.number().int().min(TEMPLATE_MIN_EXPORT_DPI).default(TEMPLATE_DPI_DEFAULT),
  /** Label preset, mis. "2×6 in — strip". Murni buat UI. */
  name: z.string().optional(),
});
export type TemplateSize = z.infer<typeof TemplateSizeSchema>;

export const TemplateBackgroundSchema = z.object({
  type: z.enum(["color", "image"]).default("color"),
  /** `color` → "#ffffff"; `image` → URL atau data-URL. */
  value: z.string().default("#ffffff"),
  hasVignette: z.boolean().default(false),
});
export type TemplateBackground = z.infer<typeof TemplateBackgroundSchema>;

export const TemplateFrameSchema = z.object({
  id: z.string().min(1),
  /** Kotak frame di canvas hasil (px). */
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.number().default(0),
  /** Urutan pengambilan foto untuk slot ini (0-based). */
  slot: z.number().int().nonnegative(),
  /** Tebal garis tepi frame, px. 0 = tanpa tepi. */
  borderThickness: z.number().nonnegative().default(0),
  borderColor: z.string().default("#0a0a0a"),
  /** Dipakai Fase 3 (shadow elemen); disimpan sekarang biar JSON stabil. */
  hasShadow: z.boolean().default(false),
  /** Rasio crop foto, mis. "4:5". Kosong = ikut rasio kotak frame. */
  aspectRatio: z.string().optional(),
});
export type TemplateFrame = z.infer<typeof TemplateFrameSchema>;

export const TemplateTextSchema = z.object({
  id: z.string().min(1),
  /** Boleh berisi token: `{event}` `{date}` `{time}` `{custom}`. */
  text: z.string(),
  /** Kotak teks di canvas hasil (px). `x`/`y` = sudut kiri-atas kotak. */
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  fontSize: z.number().positive(),
  fontFamily: z.string(),
  color: z.string(),
  /** Garis tepi huruf; kosong = tanpa outline. */
  stroke: z.string().optional(),
  strokeWidth: z.number().nonnegative().default(0),
  align: z.enum(["left", "center", "right"]).default("center"),
  rotation: z.number().default(0),
});
export type TemplateText = z.infer<typeof TemplateTextSchema>;

export const TemplateStickerSchema = z.object({
  id: z.string().min(1),
  /** URL atau data-URL gambar sticker. */
  src: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.number().default(0),
});
export type TemplateSticker = z.infer<typeof TemplateStickerSchema>;

export const TemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  size: TemplateSizeSchema,
  background: TemplateBackgroundSchema,
  frames: z.array(TemplateFrameSchema),
  textElements: z.array(TemplateTextSchema),
  stickers: z.array(TemplateStickerSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Template = z.infer<typeof TemplateSchema>;

/* ------------------------------------------------------------------ *
 * Content library (starters / frames / backgrounds / stickers)
 * ------------------------------------------------------------------ */

export const ContentItemSchema = z.object({
  id: z.string(),
  kind: z.enum(CONTENT_KINDS),
  name: z.string(),
  url: z.string(),
  /** Untuk sticker: rasio aspek biar editor bisa menaruhnya tanpa fetch. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  tags: z.array(z.string()).default([]),
});
export type ContentItem = z.infer<typeof ContentItemSchema>;

/* ------------------------------------------------------------------ *
 * Fase 5 — upload presigned, OTP, entitlement
 *
 * Upload foto TIDAK lewat API (syarat Fase 5): API hanya menandatangani URL,
 * studio PUT langsung ke bucket. Karena itu `UploadUrlRequest` sengaja tidak
 * memuat key — key ditentukan server, bukan klien, supaya satu klien tidak bisa
 * menulis ke prefix album orang lain.
 * ------------------------------------------------------------------ */

export const UPLOAD_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/webm",
] as const;
export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

/**
 * Jenis media dari MIME.
 *
 * Dipakai halaman galeri & ZIP: `<img>` untuk foto, `<video controls>` untuk
 * video. Menebak dari ekstensi key akan salah begitu ada key lama — MIME adalah
 * satu-satunya sumber yang benar, dan ia sudah ikut tersimpan bersama objeknya.
 */
export function mediaKindForContentType(contentType: string): "photo" | "video" {
  return contentType.startsWith("video/") ? "video" : "photo";
}

export const UploadUrlRequestSchema = z.object({
  contentType: z.enum(UPLOAD_CONTENT_TYPES),
  /** Ukuran berkas, byte. Server menolak yang melebihi `PHOTO_MAX_BYTES`. */
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Nama berkas asli — murni buat tampilan, tidak dipakai menyusun key. */
  filename: z.string().max(200).optional(),
});
export type UploadUrlRequest = z.infer<typeof UploadUrlRequestSchema>;

/**
 * URL yang ditandatangani. Dua-duanya di-PUT langsung ke bucket:
 * `uploadUrl` = berkas asli, `thumbUploadUrl` = pratinjau halaman galeri.
 */
export const UploadUrlResponseSchema = z.object({
  photoId: z.string(),
  uploadUrl: z.string(),
  thumbUploadUrl: z.string(),
  key: z.string(),
  thumbKey: z.string(),
  /** ISO — setelah ini URL ditolak bucket. */
  expiresAt: z.string(),
});
export type UploadUrlResponse = z.infer<typeof UploadUrlResponseSchema>;

/** Dipanggil studio SETELAH kedua PUT sukses. */
export const RegisterPhotoSchema = z.object({
  photoId: z.string().min(1),
  key: z.string().min(1),
  thumbKey: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
  filename: z.string().max(200).optional(),
});
export type RegisterPhoto = z.infer<typeof RegisterPhotoSchema>;

export const CreateGallerySchema = z.object({
  eventId: z.string().min(1),
  /** Plaintext HANYA di request; server yang meng-hash (PBKDF2 + salt acak). */
  password: z.string().min(4).max(128).optional(),
  /** Umur galeri dalam hari. Kosong = `GALLERY_TTL_DAYS`. */
  ttlDays: z.number().int().min(1).max(365).optional(),
});
export type CreateGallery = z.infer<typeof CreateGallerySchema>;

export const UnlockGallerySchema = z.object({
  password: z.string().min(1).max(128),
});
export type UnlockGallery = z.infer<typeof UnlockGallerySchema>;

/** Balasan `POST /v1/galleries/:id/photos` — metadata yang tersimpan. */
export const RegisteredPhotoSchema = PhotoSchema;
export type RegisteredPhoto = z.infer<typeof RegisteredPhotoSchema>;

/* OTP → JWT -------------------------------------------------------- */

export const OtpRequestSchema = z.object({
  email: z.string().email(),
});
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpVerifySchema = z.object({
  email: z.string().email(),
  /** Enam digit. Sengaja string supaya `007123` tidak kehilangan nol depan. */
  code: z.string().regex(/^\d{6}$/, "kode harus 6 digit"),
});
export type OtpVerify = z.infer<typeof OtpVerifySchema>;

export const SessionSchema = z.object({
  token: z.string(),
  email: z.string().email(),
  expiresAt: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;

/** Balasan `POST /v1/auth/otp/request` — tidak pernah memuat kodenya. */
export const OtpRequestedSchema = z.object({
  sent: z.literal(true),
  expiresAt: z.string(),
});
export type OtpRequested = z.infer<typeof OtpRequestedSchema>;

/* Entitlement / lisensi -------------------------------------------- */

export const ENTITLEMENT_PLANS = ["trial", "personal", "commercial"] as const;
export type EntitlementPlan = (typeof ENTITLEMENT_PLANS)[number];

export const EntitlementSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  plan: z.enum(ENTITLEMENT_PLANS),
  status: z.enum(["active", "expired", "revoked"]),
  /** Batas galeri aktif sekaligus; `null` = tanpa batas. */
  maxActiveGalleries: z.number().int().positive().nullable(),
  issuedAt: z.string(),
  /** `null` = lisensi tidak pernah kedaluwarsa. */
  expiresAt: z.string().nullable(),
});
export type Entitlement = z.infer<typeof EntitlementSchema>;

/* ------------------------------------------------------------------ *
 * Fase 11 — Booking & reservasi
 *
 * Bentuk data di sini **sudah final** untuk Fase 11 walau pembayarannya belum
 * tersambung: `paymentProvider` dan `depositStatus` ada sejak sekarang supaya
 * menyambungkan QRIS (Fase 10) nanti tidak perlu migrasi skema.
 *
 * Snapshot harga: `Booking` menyimpan `packageName`, `priceIdr`, dan
 * `durationMinutes` **saat booking dibuat**, bukan menunjuk paket hidup. Kalau
 * operator menaikkan harga, booking lama tidak ikut berubah — itu yang benar,
 * karena klien menyetujui harga yang dia lihat.
 * ------------------------------------------------------------------ */

export const BookingPackageSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    durationMinutes: z.number().int().min(15).max(24 * 60),
    /** Harga penuh sesi (rupiah). */
    priceIdr: z.number().int().nonnegative(),
    /** Deposit yang diminta untuk mengunci slot (rupiah). 0 = tanpa deposit. */
    depositIdr: z.number().int().nonnegative(),
    active: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .refine((value) => value.depositIdr <= value.priceIdr, {
    message: "deposit tidak boleh melebihi harga paket",
    path: ["depositIdr"],
  });
export type BookingPackage = z.infer<typeof BookingPackageSchema>;

export const CreateBookingPackageSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    durationMinutes: z.number().int().min(15).max(24 * 60),
    priceIdr: z.number().int().nonnegative(),
    depositIdr: z.number().int().nonnegative().default(0),
    active: z.boolean().default(true),
  })
  .refine((value) => value.depositIdr <= value.priceIdr, {
    message: "deposit tidak boleh melebihi harga paket",
    path: ["depositIdr"],
  });
export type CreateBookingPackage = z.infer<typeof CreateBookingPackageSchema>;

/**
 * Update paket — semua field opsional.
 *
 * Batas `deposit ≤ harga` **tidak** diperiksa di sini: `partial()` tidak bisa
 * memvalidasi lintas field yang boleh jadi tidak dikirim sama sekali. Route
 * yang menggabungkan dulu dengan nilai lama, lalu memeriksa hasil gabungannya.
 */
export const UpdateBookingPackageSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  durationMinutes: z.number().int().min(15).max(24 * 60).optional(),
  priceIdr: z.number().int().nonnegative().optional(),
  depositIdr: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
});
export type UpdateBookingPackage = z.infer<typeof UpdateBookingPackageSchema>;

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * Jam buka satu hari. `close` harus setelah `open`.
 *
 * Tipe hasilnya sengaja **tidak** diekspor ulang di sini: bentuknya sama persis
 * dengan `DayHours` di `booking.ts`, dan `index.ts` meng-`export *` kedua modul
 * — mengekspor dua tipe bernama sama bikin impor jadi ambigu. Konsumen memakai
 * `DayHours` dari `booking.ts`; skema ini cuma memvalidasi bentuknya.
 */
export const DayHoursSchema = z
  .object({
    /** 0 = Minggu … 6 = Sabtu. */
    weekday: z.number().int().min(0).max(6),
    open: z.string().regex(HHMM, "jam buka harus HH:MM"),
    close: z.string().regex(HHMM, "jam tutup harus HH:MM"),
  })
  .refine((value) => value.close > value.open, {
    message: "jam tutup harus setelah jam buka",
    path: ["close"],
  });

/**
 * Provider pembayaran yang dikenal.
 *
 * `none` = belum ada gateway sama sekali (kondisi Fase 11 sekarang). `manual`
 * = operator menandai deposit masuk sendiri. `qris` disiapkan untuk Fase 10
 * dan **belum diimplementasikan** — memilihnya sekarang ditolak route.
 */
export const PAYMENT_PROVIDERS = ["none", "manual", "qris"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const BookingSettingsSchema = z.object({
  hours: z.array(DayHoursSchema).max(7),
  /** Jeda bersih-bersih antar sesi (menit). */
  bufferMinutes: z.number().int().min(0).max(240),
  /** Jarak antar awal slot; `null` = sepanjang durasi paket. */
  slotStepMinutes: z.number().int().min(5).max(240).nullable(),
  /** Booking terdekat yang masih diterima, dari sekarang (jam). */
  minNoticeHours: z.number().int().min(0).max(24 * 30),
  /** Seberapa jauh ke depan kalender dibuka (hari). */
  maxAdvanceDays: z.number().int().min(1).max(730),
  /** Offset zona operator dalam menit (WIB = -420). */
  timezoneOffsetMinutes: z.number().int().min(-840).max(840),
  /** Tanggal tutup (libur, acara lain) — `YYYY-MM-DD`. */
  closedDates: z.array(z.string().regex(DATE_ONLY)).max(365),
  paymentProvider: z.enum(PAYMENT_PROVIDERS),
  /** Kalau true, slot baru hanya dikunci setelah deposit masuk. */
  requireDeposit: z.boolean(),
});
export type BookingSettings = z.infer<typeof BookingSettingsSchema>;

export const UpdateBookingSettingsSchema = BookingSettingsSchema.partial();
export type UpdateBookingSettings = z.infer<typeof UpdateBookingSettingsSchema>;

/**
 * Setelan awal sebelum operator menyentuhnya.
 *
 * Zona default WIB (UTC+7 → offset −420) karena aplikasi ini dipakai di
 * Indonesia; jam buka 09:00–21:00 tiap hari kecuali Senin, buffer 30 menit
 * (waktu bersih-bersih antar sesi), dan `paymentProvider: "none"` — kondisi
 * jujur Fase 11, belum ada gateway.
 */
export const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  hours: [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({
    weekday,
    open: "09:00",
    close: "21:00",
  })),
  bufferMinutes: 30,
  slotStepMinutes: null,
  minNoticeHours: 24,
  maxAdvanceDays: 180,
  timezoneOffsetMinutes: -420,
  closedDates: [],
  paymentProvider: "none",
  requireDeposit: false,
};

/** Body `POST /v1/booking/requests` — dari form publik. */
export const BookingRequestSchema = z.object({
  packageId: z.string().min(1),
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  phone: z.string().min(6).max(32),
  start: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), "waktu mulai tidak valid"),
  notes: z.string().max(1000).optional(),
  /** Persetujuan simpan data (UU PDP). Wajib `true`. */
  consent: z.literal(true),
  /**
   * Honeypot. Form asli tidak punya field ini; bot mengisinya. Route membalas
   * sukses palsu tanpa menyimpan apa pun — bukan 400, karena 400 memberi tahu
   * bot bahwa jebakannya terdeteksi.
   */
  website: z.string().max(200).optional(),
});
export type BookingRequest = z.infer<typeof BookingRequestSchema>;

export const BookingSchema = z.object({
  id: z.string(),
  /** Bagian URL halaman status: `/booking/<token>`. Rahasia, tanpa login. */
  token: z.string(),
  packageId: z.string(),
  packageName: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  /** Instant UTC ISO. */
  start: z.string(),
  end: z.string(),
  durationMinutes: z.number().int().positive(),
  priceIdr: z.number().int().nonnegative(),
  depositIdr: z.number().int().nonnegative(),
  depositStatus: z.enum(DEPOSIT_STATUSES),
  status: z.enum(BOOKING_STATUSES),
  notes: z.string().optional(),
  /** Alasan tolak/batal — dikirim ke klien di halaman status. */
  reason: z.string().optional(),
  /** Event studio yang dibuat saat booking disetujui; null selama belum. */
  eventId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Booking = z.infer<typeof BookingSchema>;

/** Yang boleh dilihat tamu lewat token: tanpa `id` internal & alasan internal. */
export const BookingPublicSchema = BookingSchema.omit({ id: true, reason: true });
export type BookingPublic = z.infer<typeof BookingPublicSchema>;

export const BookingSlotSchema = z.object({
  start: z.string(),
  end: z.string(),
  /** Jam dinding zona operator, mis. `"14:00–15:00"`. */
  label: z.string(),
  available: z.boolean(),
});
export type BookingSlot = z.infer<typeof BookingSlotSchema>;

export const BookingAvailabilitySchema = z.object({
  date: z.string(),
  timezoneOffsetMinutes: z.number().int(),
  slots: z.array(BookingSlotSchema),
});
export type BookingAvailability = z.infer<typeof BookingAvailabilitySchema>;

/** Status yang boleh di-set operator. `requested` bukan — itu keadaan awal. */
export const BOOKING_OPERATOR_STATUSES = ["approved", "rejected", "cancelled", "completed"] as const;
export type BookingOperatorStatus = (typeof BOOKING_OPERATOR_STATUSES)[number];

export const UpdateBookingStatusSchema = z.object({
  status: z.enum(BOOKING_OPERATOR_STATUSES),
  reason: z.string().max(500).optional(),
});
export type UpdateBookingStatus = z.infer<typeof UpdateBookingStatusSchema>;

export const RescheduleBookingSchema = z.object({
  start: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), "waktu mulai tidak valid"),
  reason: z.string().max(500).optional(),
});
export type RescheduleBooking = z.infer<typeof RescheduleBookingSchema>;

export const CancelBookingSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type CancelBooking = z.infer<typeof CancelBookingSchema>;

/* ------------------------------------------------------------------ *
 * Leads & analytics (Fase 9)
 *
 * Logika murninya ada di `leads.ts` (validasi nilai, escape CSV, retensi).
 * Yang di sini cuma **bentuk kabel**: apa yang boleh masuk lewat HTTP dan apa
 * yang keluar. Skema `LeadField`/`Lead` dianotasi `z.ZodType<...>` alih-alih
 * di-`infer` supaya tipe-nya tetap satu sumber di `leads.ts` — dua deklarasi
 * dengan nama sama akan saling membatalkan saat `index.ts` memakai `export *`.
 * ------------------------------------------------------------------ */

export const LeadFieldTypeSchema = z.enum(LEAD_FIELD_TYPES);

export const LeadFieldSchema: z.ZodType<LeadField> = z.object({
  id: z.string(),
  /** `null` = field global, berlaku untuk semua event. */
  eventId: z.string().nullable(),
  /** Kunci stabil untuk CSV; tidak pernah berubah setelah dibuat. */
  key: z.string().min(1),
  label: z.string().min(1).max(80),
  type: LeadFieldTypeSchema,
  required: z.boolean(),
  options: z.array(z.string().min(1).max(80)).max(40),
  helpText: z.string().max(200).nullable(),
  sortOrder: z.number().int().min(0).max(1000),
  active: z.boolean(),
  createdAt: z.string(),
});

export const LeadValueSchema = z.union([z.string().max(LEAD_VALUE_MAX), z.boolean()]);

export const LeadSchema: z.ZodType<Lead> = z.object({
  id: z.string(),
  eventId: z.string().nullable(),
  galleryId: z.string().nullable(),
  values: z.record(z.string(), LeadValueSchema),
  consent: z.boolean(),
  consentText: z.string(),
  consentVersion: z.string(),
  source: z.string(),
  createdAt: z.string(),
});

/** Body `POST /v1/leads/admin/fields` — kunci diturunkan server dari label. */
export const CreateLeadFieldSchema = z
  .object({
    eventId: z.string().min(1).nullable().optional(),
    label: z.string().min(1).max(80),
    type: LeadFieldTypeSchema,
    required: z.boolean().default(false),
    options: z.array(z.string().min(1).max(80)).max(40).default([]),
    helpText: z.string().max(200).nullable().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    active: z.boolean().default(true),
  })
  .refine((value) => value.type !== "select" || value.options.length > 0, {
    message: "field bertipe select harus punya minimal satu pilihan",
    path: ["options"],
  });
export type CreateLeadField = z.infer<typeof CreateLeadFieldSchema>;

export const UpdateLeadFieldSchema = z
  .object({
    label: z.string().min(1).max(80).optional(),
    required: z.boolean().optional(),
    options: z.array(z.string().min(1).max(80)).max(40).optional(),
    helpText: z.string().max(200).nullable().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "tidak ada yang diubah" });
export type UpdateLeadField = z.infer<typeof UpdateLeadFieldSchema>;

/**
 * Body `POST /v1/leads` — dari form tamu.
 *
 * `values` sengaja `record(unknown)`: nama kuncinya ditentukan field yang
 * dikonfigurasi operator, jadi tidak bisa ditulis mati di skema. Validasi
 * sebenarnya ada di `validateLeadValues` (`leads.ts`), yang tahu field mana
 * yang wajib dan tipe apa isinya.
 */
export const LeadSubmissionSchema = z.object({
  /** Bagian URL galeri tamu — sumber event & galeri diambil dari sini. */
  galleryHash: z.string().min(1).max(64).optional(),
  eventId: z.string().min(1).optional(),
  values: z.record(z.string(), z.unknown()).default({}),
  /** Persetujuan simpan data (UU PDP). Wajib `true`. */
  consent: z.literal(true),
  /** Honeypot, sama seperti form booking. */
  website: z.string().max(200).optional(),
});
export type LeadSubmission = z.infer<typeof LeadSubmissionSchema>;

/* ---- Analytics ---------------------------------------------------- */

/** Ringkas satu event untuk dasbor. */
export const EventAnalyticsSchema = z.object({
  eventId: z.string(),
  name: z.string(),
  date: z.string(),
  galleries: z.number().int().nonnegative(),
  photos: z.number().int().nonnegative(),
  /** Jumlah buka halaman galeri (dihitung sekali per galeri per hari). */
  views: z.number().int().nonnegative(),
  leads: z.number().int().nonnegative(),
});
export type EventAnalytics = z.infer<typeof EventAnalyticsSchema>;

export const AnalyticsOverviewSchema = z.object({
  from: z.string(),
  to: z.string(),
  totals: z.object({
    events: z.number().int().nonnegative(),
    galleries: z.number().int().nonnegative(),
    photos: z.number().int().nonnegative(),
    views: z.number().int().nonnegative(),
    leads: z.number().int().nonnegative(),
  }),
  events: z.array(EventAnalyticsSchema),
});
export type AnalyticsOverview = z.infer<typeof AnalyticsOverviewSchema>;

/* ------------------------------------------------------------------ *
 * Branding, sharing & guestbook (Fase 9)
 *
 * Logika murninya ada di `branding.ts`, `sharing.ts`, dan `guestbook.ts`.
 * Yang di sini cuma bentuk kabel. `BrandingSchema` sengaja **longgar** (string
 * biasa, bukan `.max()`): normalisasi sebenarnya (`normalizeBranding`) memotong
 * & membersihkan nilai rusak alih-alih menolaknya. Menolak di sini akan
 * membuat operator kehilangan seluruh simpanan gara-gara satu spasi lebih.
 * ------------------------------------------------------------------ */

export const BrandingSchema: z.ZodType<Branding> = z.object({
  logoUrl: z.string().nullable(),
  heading: z.string(),
  subheading: z.string(),
  footer: z.string(),
});

/** Body `PUT /v1/branding` — semua opsional; yang tidak dikirim dibiarkan. */
export const UpdateBrandingSchema = z
  .object({
    logoUrl: z.string().nullable().optional(),
    heading: z.string().optional(),
    subheading: z.string().optional(),
    footer: z.string().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "tidak ada yang diubah" });
export type UpdateBranding = z.infer<typeof UpdateBrandingSchema>;

/** `z.ZodType` karena tipe aslinya milik `guestbook.ts` (satu sumber). */
export const GuestbookEntrySchema: z.ZodType<GuestbookEntry> = z.object({
  id: z.string(),
  eventId: z.string(),
  galleryId: z.string().nullable(),
  kind: z.enum(GUESTBOOK_ENTRY_KINDS),
  contentType: z.string(),
  key: z.string(),
  durationSeconds: z.number(),
  bytes: z.number(),
  label: z.string(),
  visible: z.boolean(),
  createdAt: z.string(),
});

/** Body `POST /v1/guestbook` — metadata setelah berkas naik ke bucket. */
export const GuestbookDraftSchema = z.object({
  eventId: z.string().min(1),
  galleryHash: z.string().min(1).max(64).optional(),
  kind: z.enum(GUESTBOOK_ENTRY_KINDS),
  contentType: z.string().min(1),
  durationSeconds: z.number(),
  bytes: z.number(),
  label: z.string().max(GUESTBOOK_LABEL_MAX).optional(),
  /** Kunci objek dari URL upload; diperiksa di route, bukan dipercaya. */
  key: z.string().min(1),
});
export type GuestbookDraftInput = z.infer<typeof GuestbookDraftSchema>;

/* ------------------------------------------------------------------ *
 * Error
 * ------------------------------------------------------------------ */

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.number().int(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
