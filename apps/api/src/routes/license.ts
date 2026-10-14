/**
 * Lisensi & order (Fase 10, FEATURE-MATRIX #84–#85).
 *
 * Ini permukaan **mekanisme**-nya, bukan uangnya. Yang bisa dilakukan di sini:
 * order lisensi dicatat, operator memindahkan statusnya, kode aktivasi
 * diterbitkan saat lunas, dan kode itu ditebus jadi entitlement perangkat.
 * Yang **tidak** ada: panggilan ke Midtrans/Xendit. Permintaan pemilik produk
 * eksplisit — bangun UI dan mekanismenya dulu; gateway pembayaran menyusul.
 *
 * Tiga keputusan yang membentuk berkas ini:
 *
 *   · **Harga tidak pernah datang dari klien.** `CreateOrderSchema` tidak
 *     punya `amountIdr`; harga diambil dari `LICENSE_CATALOG` di server dan
 *     disalin ke baris order. Kalau klien boleh mengirim harga, pemegang token
 *     operator bisa membeli lisensi komersial seharga seribu rupiah — dan
 *     tidak ada satu pun layar yang akan terlihat salah.
 *   · **`sku_name` dan `amount_idr` adalah snapshot.** Order menyimpan nama &
 *     harga saat dibeli, bukan menunjuk katalog hidup. Menaikkan harga besok
 *     tidak boleh mengubah invoice yang sudah dikirim.
 *   · **Transisi status lewat `canTransitionOrder`, bukan `if` lokal.** Order
 *     yang sudah `refunded` tidak boleh hidup lagi hanya karena webhook
 *     gateway datang terlambat atau terulang.
 *
 * Provider `qris` sengaja menjawab **501**, bukan membuat order yang menggantung
 * di "menunggu pembayaran" yang tidak akan pernah bisa dibayar. Stub yang
 * mengembalikan sukses palsu jauh lebih mahal daripada error yang terlihat.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  ACTIVATION_CODE_LENGTH,
  CreateOrderSchema,
  LICENSE_CATALOG,
  LICENSE_SKU_IDS,
  ORDER_PROVIDERS,
  PLAN_LIMITS,
  RedeemActivationSchema,
  UpdateOrderStatusSchema,
  activationCodeState,
  canTransitionOrder,
  evaluateLicense,
  findSku,
  formatActivationCode,
  isActivationCode,
  isOrderProviderLive,
  isOrderStatus,
  normalizeActivationCode,
  planLimits,
  type ActivationCode,
  type Order,
} from "@foto-booth/shared";

import { authenticate } from "../auth.ts";
import type { ServerContext } from "../context.ts";
import { newActivationCode, newId } from "../secrets.ts";
import {
  getActivationCode,
  getEntitlement,
  getOrder,
  insertActivationCode,
  insertOrder,
  listActivationCodes,
  listOrders,
  redeemActivationCode,
  revokeActivationCode,
  updateOrder,
  upsertEntitlement,
} from "../store.ts";

const INVALID = (message: string) => ({ error: "invalid_request", message, statusCode: 400 });
const UNAUTHORIZED = (status: number, message: string) => ({ error: "unauthorized", message, statusCode: status });
const NOT_FOUND = (message: string) => ({ error: "not_found", message, statusCode: 404 });
const CONFLICT = (message: string) => ({ error: "conflict", message, statusCode: 409 });
const UNAVAILABLE = (message: string) => ({ error: "payment_unavailable", message, statusCode: 501 });

/** Batas jumlah order yang dikembalikan satu permintaan. */
const ORDERS_MAX_LIMIT = 200;

/**
 * Bentuk order untuk klien: kode aktivasi ditampilkan berkelompok.
 *
 * `reference` di DB disimpan tanpa tanda hubung supaya `UNIQUE` benar-benar
 * mencegah dua kode yang sama ditulis dengan format berbeda. Yang dikirim ke
 * klien adalah bentuk yang dibaca manusia (`ABCD-EFGH-JKLM`) — operator
 * menyalinnya ke invoice, dan kode 12 huruf tanpa jeda adalah sumber salah
 * baca yang tidak perlu ada.
 */
function orderForClient(order: Order): Order & { referenceFormatted: string | null } {
  return {
    ...order,
    referenceFormatted: order.reference === null ? null : formatActivationCode(order.reference),
  };
}

/** Bentuk kode untuk panel: status dihitung di sini supaya klien tidak menebak. */
function codeForClient(code: ActivationCode, now: Date) {
  return {
    ...code,
    formatted: formatActivationCode(code.code),
    state: activationCodeState(code, now),
  };
}

export async function licenseRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const guard = (request: FastifyRequest) => authenticate(request, ctx);

  /* ---- Katalog (publik) ------------------------------------------ */

  // Halaman harga dan panel studio membaca daftar yang sama. Publik karena
  // calon pembeli memang harus bisa melihat harga sebelum menghubungi
  // operator; tidak ada rahasia di sini.
  app.get("/v1/license/catalog", async (_request, reply) => {
    const items = LICENSE_SKU_IDS.map((id) => {
      const sku = LICENSE_CATALOG[id];
      return { ...sku, limits: PLAN_LIMITS[sku.plan], live: true };
    });
    return reply.send({
      items,
      providers: ORDER_PROVIDERS.map((p) => ({ id: p, live: isOrderProviderLive(p) })),
      activationCodeLength: ACTIVATION_CODE_LENGTH,
    });
  });

  /* ---- Entitlement perangkat -------------------------------------- */

  app.get("/v1/license/entitlement", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const now = ctx.now();
    const entitlement = getEntitlement(ctx.db, auth.operator.email);
    return reply.send({
      entitlement,
      verdict: evaluateLicense(entitlement, now),
      limits: entitlement === null ? null : planLimits(entitlement.plan),
    });
  });

  /* ---- Order ------------------------------------------------------ */

  app.get("/v1/license/orders", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const query = (request.query ?? {}) as Record<string, unknown>;
    const status = typeof query.status === "string" ? query.status : undefined;
    if (status !== undefined && !isOrderStatus(status)) {
      return reply.status(400).send(INVALID(`status tidak dikenal: ${status}`));
    }

    const email = typeof query.email === "string" && query.email !== "" ? query.email : undefined;
    const rawLimit = typeof query.limit === "string" ? Number(query.limit) : NaN;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), ORDERS_MAX_LIMIT) : undefined;

    const orders = listOrders(ctx.db, { status, email, limit }).map(orderForClient);
    return reply.send({ orders });
  });

  app.post("/v1/license/orders", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const parsed = CreateOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));
    }

    const sku = findSku(parsed.data.sku);
    if (sku === null) return reply.status(400).send(INVALID(`SKU tidak dikenal: ${parsed.data.sku}`));

    if (!isOrderProviderLive(parsed.data.provider)) {
      return reply
        .status(501)
        .send(
          UNAVAILABLE(
            `Provider "${parsed.data.provider}" belum tersambung ke gateway pembayaran. ` +
              `Pakai "manual": order dicatat, operator mengonfirmasi sendiri saat dana masuk.`,
          ),
        );
    }

    const now = ctx.now().toISOString();
    const order = insertOrder(
      ctx.db,
      newId("ord"),
      {
        sku: sku.sku,
        // Snapshot: nama & harga saat dibeli, bukan rujukan ke katalog hidup.
        skuName: sku.name,
        email: parsed.data.email,
        amountIdr: sku.priceIdr,
        status: "created",
        provider: parsed.data.provider,
        note: parsed.data.note ?? null,
      },
      now,
    );

    return reply.status(201).send({ order: orderForClient(order) });
  });

  app.get("/v1/license/orders/:id", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const { id } = request.params as { id: string };
    const order = getOrder(ctx.db, id);
    if (order === null) return reply.status(404).send(NOT_FOUND(`Order ${id} tidak ditemukan`));

    const codes = listActivationCodes(ctx.db, id).map((c) => codeForClient(c, ctx.now()));
    return reply.send({ order: orderForClient(order), codes });
  });

  app.post("/v1/license/orders/:id/status", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const { id } = request.params as { id: string };
    const parsed = UpdateOrderStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));
    }

    const current = getOrder(ctx.db, id);
    if (current === null) return reply.status(404).send(NOT_FOUND(`Order ${id} tidak ditemukan`));

    const target = parsed.data.status;
    if (target === current.status) {
      return reply.status(409).send(CONFLICT(`Order sudah berstatus "${current.status}"`));
    }
    if (!canTransitionOrder(current.status, target)) {
      return reply
        .status(409)
        .send(CONFLICT(`Tidak bisa memindahkan order dari "${current.status}" ke "${target}"`));
    }

    const now = ctx.now();
    const iso = now.toISOString();

    // Kode aktivasi diterbitkan **saat lunas**, bukan saat order dibuat: kode
    // yang sudah beredar sebelum uang masuk tidak bisa ditarik kembali.
    let issued: ActivationCode | null = null;
    let reference = current.reference;

    if (target === "paid" && reference === null) {
      const sku = findSku(current.sku);
      // Katalog bisa saja sudah tidak memuat SKU ini (SKU ditarik dari jualan).
      // Order lama tetap harus bisa dilunasi — plan & batasnya diambil dari
      // snapshot yang sudah tersimpan, bukan ditebak.
      const plan = sku?.plan ?? "personal";
      const limits = PLAN_LIMITS[plan];

      let code = newActivationCode();
      // Tabrakan 12 karakter dari 32^12 kemungkinan praktis nol, tapi
      // `code` adalah PRIMARY KEY: satu tabrakan akan jadi error 500 yang
      // membingungkan. Tiga percobaan cukup untuk memastikan itu tidak terjadi.
      for (let attempt = 0; attempt < 3 && getActivationCode(ctx.db, code) !== null; attempt += 1) {
        code = newActivationCode();
      }

      issued = insertActivationCode(
        ctx.db,
        { code, orderId: id, plan, maxActiveGalleries: limits.maxActiveGalleries, expiresAt: null },
        iso,
      );
      reference = issued.code;
    }

    const updated = updateOrder(
      ctx.db,
      id,
      {
        status: target,
        reference,
        note: parsed.data.note ?? undefined,
        paidAt: target === "paid" ? iso : undefined,
      },
      iso,
    );
    if (updated === null) return reply.status(404).send(NOT_FOUND(`Order ${id} tidak ditemukan`));

    // Dana dikembalikan → kode yang sudah diterbitkan dicabut. Membiarkannya
    // hidup berarti pelanggan yang uangnya kembali tetap bisa mengaktifkan
    // perangkatnya.
    if (target === "refunded" && reference !== null) {
      revokeActivationCode(ctx.db, reference, iso);
    }

    return reply.send({
      order: orderForClient(updated),
      issuedCode: issued === null ? null : codeForClient(issued, now),
    });
  });

  /* ---- Kode aktivasi ---------------------------------------------- */

  app.get("/v1/license/activation-codes", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const query = (request.query ?? {}) as Record<string, unknown>;
    const orderId = typeof query.orderId === "string" && query.orderId !== "" ? query.orderId : undefined;

    const now = ctx.now();
    const codes = listActivationCodes(ctx.db, orderId).map((c) => codeForClient(c, now));
    return reply.send({ codes });
  });

  /**
   * Tebus kode → entitlement perangkat.
   *
   * Butuh token operator karena entitlement selalu terikat email: tanpa itu,
   * kode apa pun bisa ditebus anonim dan tidak ada cara mengetahui perangkat
   * siapa yang memegang lisensi.
   *
   * Kode yang salah bentuk dijawab **400**, bukan 404: bentuk kode bisa
   * diperiksa tanpa menyentuh DB, dan jawaban berbeda untuk "bukan kode" vs
   * "kode tidak ada" membuat percobaan kode jadi bisa diukur.
   */
  app.post("/v1/license/activate", async (request, reply) => {
    const auth = guard(request);
    if (!auth.ok) return reply.status(auth.status).send(UNAUTHORIZED(auth.status, auth.message));

    const parsed = RedeemActivationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(INVALID(parsed.error.issues[0]?.message ?? "body tidak valid"));
    }

    const raw = parsed.data.code;
    if (!isActivationCode(raw)) {
      return reply
        .status(400)
        .send(INVALID(`Kode aktivasi harus ${ACTIVATION_CODE_LENGTH} karakter (huruf/angka, tanpa I, O, 0, 1)`));
    }

    const code = normalizeActivationCode(raw);
    const now = ctx.now();
    const stored = getActivationCode(ctx.db, code);
    if (stored === null) return reply.status(404).send(NOT_FOUND("Kode aktivasi tidak ditemukan"));

    const state = activationCodeState(stored, now);
    if (state === "revoked") {
      return reply.status(409).send(CONFLICT("Kode aktivasi sudah dicabut — hubungi penjual."));
    }
    if (state === "redeemed") {
      return reply.status(409).send(CONFLICT("Kode aktivasi sudah dipakai di perangkat lain."));
    }
    if (state === "expired") {
      return reply.status(409).send(CONFLICT("Kode aktivasi sudah kedaluwarsa."));
    }

    // `redeemActivationCode` memakai `WHERE redeemed_at IS NULL`, jadi klik
    // ganda / dua tab tidak bisa menerbitkan lisensi yang sama dua kali.
    const redeemed = redeemActivationCode(ctx.db, code, auth.operator.email, now.toISOString());
    if (redeemed === null) {
      return reply.status(409).send(CONFLICT("Kode aktivasi sudah dipakai di perangkat lain."));
    }

    const entitlement = upsertEntitlement(
      ctx.db,
      newId("ent"),
      {
        email: auth.operator.email,
        plan: redeemed.plan,
        status: "active",
        maxActiveGalleries: redeemed.maxActiveGalleries,
        expiresAt: redeemed.expiresAt,
      },
      now.toISOString(),
    );

    return reply.send({
      entitlement,
      verdict: evaluateLicense(entitlement, now),
      limits: planLimits(entitlement.plan),
      code: codeForClient(redeemed, now),
    });
  });
}
