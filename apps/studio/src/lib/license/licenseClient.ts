/**
 * Klien HTTP lisensi & order (Fase 10, FEATURE-MATRIX #84–#85).
 *
 * Sisi **operator** — kecuali katalog, semua request butuh token sesi. Katalog
 * sengaja publik di API karena calon pembeli memang harus bisa melihat harga
 * sebelum menghubungi operator; klien di sini tetap memanggilnya tanpa token.
 *
 * Yang menentukan bentuk berkas ini:
 *
 *   · **Harga tidak pernah dikirim ke server.** `createOrder` tidak punya
 *     parameter harga sama sekali — bukan sekadar tidak dipakai. Tipe yang
 *     tidak bisa membawa harga lebih kuat dari komentar yang melarangnya.
 *   · **Balasan divalidasi per-item.** Satu order rusak di tengah daftar
 *     dibuang; sisanya tetap tampil. Panel lisensi yang kosong gara-gara satu
 *     baris buruk membuat operator mengira semua ordernya hilang.
 *   · **501 dibedakan dari error lain.** Provider yang belum tersambung
 *     (`qris`) bukan kesalahan operator dan bukan kesalahan jaringan; panel
 *     perlu bisa mengatakan "belum tersedia" alih-alih "gagal".
 *   · **`null` untuk entitlement yang tidak dikenali**, bukan lemparan: badge
 *     lisensi yang hilang lebih baik daripada tab yang mati.
 */

import {
  API_PREFIX,
  OrderSchema,
  type CreateOrderInput,
  type LicenseSku,
  type Order,
  type OrderProvider,
  type OrderStatus,
  type PlanLimits,
} from "@foto-booth/shared";

/** Satu SKU di katalog publik, sudah dilengkapi batas plan-nya. */
export interface CatalogItem extends LicenseSku {
  limits: PlanLimits;
}

/**
 * Order seperti yang dikirim API: kode aktivasi ditambah bentuk tampilannya.
 *
 * `referenceFormatted` dihitung **server** (`formatActivationCode`). Panel tidak
 * merakit ulang tanda hubungnya sendiri: dua tempat yang memformat kode yang
 * sama cepat atau lambat berbeda, dan yang dibaca pelanggan dari invoice adalah
 * versi server.
 */
export interface ClientOrder extends Order {
  referenceFormatted: string | null;
}

export interface CatalogState {
  items: CatalogItem[];
  providers: { id: OrderProvider; live: boolean }[];
  activationCodeLength: number;
}

/** Kode aktivasi seperti yang dikirim API: bentuk tampilan + status terhitung. */
export interface ClientActivationCode {
  code: string;
  formatted: string;
  state: "unredeemed" | "redeemed" | "revoked" | "expired";
  orderId: string | null;
  plan: string;
  maxActiveGalleries: number | null;
  issuedAt: string;
  expiresAt: string | null;
  redeemedAt: string | null;
  redeemedBy: string | null;
  revokedAt: string | null;
}

export interface EntitlementState {
  entitlement: {
    id: string;
    email: string;
    plan: string;
    status: string;
    maxActiveGalleries: number | null;
    issuedAt: string;
    expiresAt: string | null;
  } | null;
  verdict: { state: string; allowed: boolean; daysLeft: number | null; reason: string | null };
  limits: PlanLimits | null;
}

export interface LicenseClient {
  catalog(): Promise<CatalogState>;
  entitlement(): Promise<EntitlementState>;
  listOrders(filter?: { status?: OrderStatus; email?: string; limit?: number }): Promise<ClientOrder[]>;
  createOrder(body: CreateOrderInput): Promise<ClientOrder>;
  getOrder(id: string): Promise<{ order: ClientOrder; codes: ClientActivationCode[] }>;
  setOrderStatus(
    id: string,
    status: OrderStatus,
    note?: string,
  ): Promise<{ order: ClientOrder; issuedCode: ClientActivationCode | null }>;
  listCodes(orderId?: string): Promise<ClientActivationCode[]>;
  activate(code: string): Promise<EntitlementState & { code: ClientActivationCode }>;
}

export class LicenseHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "LicenseHttpError";
    this.status = status;
  }

  /** Provider yang belum tersambung — bukan kesalahan operator. */
  get isUnavailable(): boolean {
    return this.status === 501;
  }
}

export interface LicenseClientOptions {
  /** Token sesi operator. Tanpa ini semua rute operator mengembalikan 401. */
  token?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

async function describeFailure(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
  } catch {
    // Bukan JSON — status saja.
  }
  return `HTTP ${res.status}`;
}

/** Daftar balasan apa pun → order yang valid saja. */
export function parseOrders(raw: unknown): ClientOrder[] {
  if (!Array.isArray(raw)) return [];
  const orders: ClientOrder[] = [];
  for (const item of raw) {
    const parsed = OrderSchema.safeParse(item);
    if (!parsed.success) continue;
    const formatted = (item as { referenceFormatted?: unknown }).referenceFormatted;
    orders.push({
      ...parsed.data,
      // `OrderSchema` membuang kunci tak dikenal, jadi bentuk tampilan diambil
      // terpisah. Kalau server tidak mengirimnya, panel tetap bisa merakit
      // sendiri dari `reference` — tapi jalur normal selalu dari server.
      referenceFormatted: typeof formatted === "string" ? formatted : null,
    });
  }
  return orders;
}

/** Kode aktivasi: tidak ada skema Zod-nya (bentuknya ditentukan server), jadi diperiksa manual. */
export function parseCodes(raw: unknown): ClientActivationCode[] {
  if (!Array.isArray(raw)) return [];
  const codes: ClientActivationCode[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.code !== "string" || record.code === "") continue;
    if (typeof record.formatted !== "string") continue;
    if (typeof record.state !== "string") continue;
    codes.push({
      code: record.code,
      formatted: record.formatted,
      state: record.state as ClientActivationCode["state"],
      orderId: typeof record.orderId === "string" ? record.orderId : null,
      plan: typeof record.plan === "string" ? record.plan : "personal",
      maxActiveGalleries:
        typeof record.maxActiveGalleries === "number" ? record.maxActiveGalleries : null,
      issuedAt: typeof record.issuedAt === "string" ? record.issuedAt : "",
      expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
      redeemedAt: typeof record.redeemedAt === "string" ? record.redeemedAt : null,
      redeemedBy: typeof record.redeemedBy === "string" ? record.redeemedBy : null,
      revokedAt: typeof record.revokedAt === "string" ? record.revokedAt : null,
    });
  }
  return codes;
}

function parseEntitlementState(raw: unknown): EntitlementState {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const verdictRaw = (typeof record.verdict === "object" && record.verdict !== null
    ? record.verdict
    : {}) as Record<string, unknown>;

  const entRaw = record.entitlement;
  const entitlement =
    typeof entRaw === "object" && entRaw !== null
      ? (() => {
          const e = entRaw as Record<string, unknown>;
          return {
            id: typeof e.id === "string" ? e.id : "",
            email: typeof e.email === "string" ? e.email : "",
            plan: typeof e.plan === "string" ? e.plan : "personal",
            status: typeof e.status === "string" ? e.status : "active",
            maxActiveGalleries:
              typeof e.maxActiveGalleries === "number" ? e.maxActiveGalleries : null,
            issuedAt: typeof e.issuedAt === "string" ? e.issuedAt : "",
            expiresAt: typeof e.expiresAt === "string" ? e.expiresAt : null,
          };
        })()
      : null;

  const limitsRaw = record.limits;
  const limits =
    typeof limitsRaw === "object" && limitsRaw !== null
      ? {
          maxActiveGalleries:
            typeof (limitsRaw as Record<string, unknown>).maxActiveGalleries === "number"
              ? ((limitsRaw as Record<string, unknown>).maxActiveGalleries as number)
              : null,
          allowsWhiteLabel: (limitsRaw as Record<string, unknown>).allowsWhiteLabel === true,
          allowsCommercialUse: (limitsRaw as Record<string, unknown>).allowsCommercialUse === true,
        }
      : null;

  return {
    entitlement,
    verdict: {
      state: typeof verdictRaw.state === "string" ? verdictRaw.state : "none",
      allowed: verdictRaw.allowed === true,
      daysLeft: typeof verdictRaw.daysLeft === "number" ? verdictRaw.daysLeft : null,
      reason: typeof verdictRaw.reason === "string" ? verdictRaw.reason : null,
    },
    limits,
  };
}

export function createLicenseClient(options: LicenseClientOptions = {}): LicenseClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? globalThis.fetch;
  const token = options.token;

  async function send(path: string, init: RequestInit = {}, withAuth = true): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    if (withAuth && token !== undefined && token !== "") {
      headers.authorization = `Bearer ${token}`;
    }

    const res = await doFetch(`${baseUrl}${API_PREFIX}${path}`, { ...init, headers });
    if (!res.ok) throw new LicenseHttpError(res.status, await describeFailure(res));
    return res;
  }

  return {
    async catalog() {
      const res = await send("/license/catalog", {}, false);
      const body = (await res.json()) as Record<string, unknown>;
      return {
        items: Array.isArray(body.items) ? (body.items as CatalogItem[]) : [],
        providers: Array.isArray(body.providers)
          ? (body.providers as { id: OrderProvider; live: boolean }[])
          : [],
        activationCodeLength:
          typeof body.activationCodeLength === "number" ? body.activationCodeLength : 12,
      };
    },

    async entitlement() {
      const res = await send("/license/entitlement");
      return parseEntitlementState(await res.json());
    },

    async listOrders(filter = {}) {
      const query = new URLSearchParams();
      if (filter.status !== undefined) query.set("status", filter.status);
      if (filter.email !== undefined) query.set("email", filter.email);
      if (filter.limit !== undefined) query.set("limit", String(filter.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";

      const res = await send(`/license/orders${suffix}`);
      const body = (await res.json()) as { orders?: unknown };
      return parseOrders(body.orders);
    },

    async createOrder(body) {
      const res = await send("/license/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const raw = (await res.json()) as { order?: unknown };
      const parsed = parseOrders([raw.order]);
      if (parsed.length === 0) throw new LicenseHttpError(res.status, "balasan order tidak dikenali");
      return parsed[0]!;
    },

    async getOrder(id) {
      const res = await send(`/license/orders/${encodeURIComponent(id)}`);
      const body = (await res.json()) as { order?: unknown; codes?: unknown };
      const parsed = parseOrders([body.order]);
      if (parsed.length === 0) throw new LicenseHttpError(res.status, "balasan order tidak dikenali");
      return { order: parsed[0]!, codes: parseCodes(body.codes) };
    },

    async setOrderStatus(id, status, note) {
      const res = await send(`/license/orders/${encodeURIComponent(id)}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(note === undefined ? { status } : { status, note }),
      });
      const body = (await res.json()) as { order?: unknown; issuedCode?: unknown };
      const parsed = parseOrders([body.order]);
      if (parsed.length === 0) throw new LicenseHttpError(res.status, "balasan order tidak dikenali");
      const issued = parseCodes(body.issuedCode === null ? [] : [body.issuedCode]);
      return { order: parsed[0]!, issuedCode: issued[0] ?? null };
    },

    async listCodes(orderId) {
      const suffix = orderId === undefined ? "" : `?orderId=${encodeURIComponent(orderId)}`;
      const res = await send(`/license/activation-codes${suffix}`);
      const body = (await res.json()) as { codes?: unknown };
      return parseCodes(body.codes);
    },

    async activate(code) {
      const res = await send("/license/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const state = parseEntitlementState(body);
      const codes = parseCodes(body.code === undefined ? [] : [body.code]);
      if (codes.length === 0) {
        // Aktivasi yang dijawab 200 tanpa kode berarti bentuk balasan berubah.
        // Melempar di sini lebih baik daripada panel menampilkan `undefined`.
        throw new LicenseHttpError(res.status, "balasan aktivasi tidak memuat kode");
      }
      return { ...state, code: codes[0]! };
    },
  };
}
