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
 * Error
 * ------------------------------------------------------------------ */

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.number().int(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
