import { z } from "zod";

import { CONTENT_KINDS } from "./constants.ts";
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
 * Leads (kiosk)
 * ------------------------------------------------------------------ */

export const LeadSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().optional(),
  consent: z.boolean(),
  createdAt: z.string(),
});
export type Lead = z.infer<typeof LeadSchema>;

export const CreateLeadSchema = LeadSchema.omit({ id: true, createdAt: true });
export type CreateLead = z.infer<typeof CreateLeadSchema>;

/* ------------------------------------------------------------------ *
 * Fase 5 — upload presigned, OTP, entitlement
 *
 * Upload foto TIDAK lewat API (syarat Fase 5): API hanya menandatangani URL,
 * studio PUT langsung ke bucket. Karena itu `UploadUrlRequest` sengaja tidak
 * memuat key — key ditentukan server, bukan klien, supaya satu klien tidak bisa
 * menulis ke prefix album orang lain.
 * ------------------------------------------------------------------ */

export const UPLOAD_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

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
 * Error
 * ------------------------------------------------------------------ */

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.number().int(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
