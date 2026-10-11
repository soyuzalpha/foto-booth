import { z } from "zod";

import { CONTENT_KINDS } from "./constants.ts";

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
 * ------------------------------------------------------------------ */

export const TemplateSizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** DPI target saat cetak. */
  dpi: z.number().int().positive().default(300),
});
export type TemplateSize = z.infer<typeof TemplateSizeSchema>;

export const TemplateFrameSchema = z.object({
  id: z.string(),
  /** Posisi & ukuran dalam koordinat template (px). */
  x: z.number(),
  y: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  rotation: z.number().default(0),
  /** Urutan pengambilan foto untuk slot ini (0-based). */
  slot: z.number().int().nonnegative(),
});
export type TemplateFrame = z.infer<typeof TemplateFrameSchema>;

export const TemplateTextSchema = z.object({
  id: z.string(),
  text: z.string(),
  x: z.number(),
  y: z.number(),
  fontSize: z.number().positive(),
  fontFamily: z.string(),
  color: z.string(),
  align: z.enum(["left", "center", "right"]).default("center"),
  /** Kalau true, teks diisi otomatis (mis. tanggal, hashtag event). */
  binding: z.string().optional(),
});
export type TemplateText = z.infer<typeof TemplateTextSchema>;

export const TemplateSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  size: TemplateSizeSchema,
  /** URL background; boleh kosong (putih). */
  background: z.string().optional(),
  frames: z.array(TemplateFrameSchema),
  textElements: z.array(TemplateTextSchema),
  stickers: z.array(z.string()),
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
