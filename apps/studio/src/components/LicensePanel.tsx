/**
 * Panel lisensi & order (Fase 10, FEATURE-MATRIX #84–#85).
 *
 * Ini panel **mekanisme**: katalog SKU, catat order, pindahkan status, terbitkan
 * kode aktivasi, tebus kode jadi entitlement. Tidak ada tombol "bayar" yang
 * memanggil gateway — provider `qris` ditampilkan sebagai **belum tersedia**,
 * bukan tombol yang gagal saat ditekan.
 *
 * Keputusan yang terlihat di sini:
 *
 *   · **Harga diambil dari katalog server.** Formulir order tidak punya kolom
 *     harga sama sekali; yang dikirim cuma SKU, email, provider. Kalau operator
 *     bisa mengetik harga, cepat atau lambat ada invoice yang tidak cocok
 *     dengan katalog.
 *   · **Provider yang belum hidup dinonaktifkan, bukan disembunyikan.** Operator
 *     perlu tahu QRIS memang direncanakan dan memang belum bisa dipakai —
 *     menyembunyikannya membuat mereka mengira harus cari di tempat lain.
 *   · **Kode aktivasi ditampilkan berkelompok** (`ABCD-EFGH-JKLM`) memakai
 *     `formatted` dari server, supaya yang disalin operator sama dengan yang
 *     dibaca pelanggan dari invoice.
 *   · **Tombol status hanya muncul untuk transisi yang sah.** Panel memakai
 *     `canTransitionOrder` yang sama dengan API, jadi operator tidak ditawari
 *     tombol yang pasti dijawab 409.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  LICENSE_SKU_IDS,
  ORDER_STATUS_LABELS,
  canTransitionOrder,
  formatIdr,
  isOrderSettled,
  type CreateOrderInput,
  type LicenseSkuId,
  type OrderProvider,
  type OrderStatus,
} from "@foto-booth/shared";

import { useGallery } from "../lib/gallery/galleryContext.ts";
import type { ClientOrder } from "../lib/license/licenseClient.ts";
import { useLicense } from "../lib/license/useLicense.ts";

/** Transisi yang masuk akal ditawarkan dari sebuah status. */
const OFFERED: Record<OrderStatus, readonly OrderStatus[]> = {
  created: ["pending", "paid", "failed"],
  pending: ["paid", "expired", "failed"],
  paid: ["refunded"],
  expired: [],
  failed: [],
  refunded: [],
};

function SignedOutCard(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="card" data-testid="license-signed-out">
      <h2>{t("license.title")}</h2>
      <p className="note">{t("license.signedOut")}</p>
    </section>
  );
}

export default function LicensePanel(): React.JSX.Element {
  const { t } = useTranslation();
  const { session } = useGallery();
  const token = session?.token ?? null;

  const license = useLicense({ token });

  const [sku, setSku] = useState<LicenseSkuId>("booth-personal");
  const [email, setEmail] = useState(session?.email ?? "");
  const [provider, setProvider] = useState<OrderProvider>("manual");
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<ClientOrder | null>(null);

  const [code, setCode] = useState("");
  const [redeemed, setRedeemed] = useState<string | null>(null);

  // Email operator ikut terisi saat sesi muncul — panel bisa terbuka sebelum
  // sesi selesai dipulihkan dari localStorage.
  useEffect(() => {
    if (session !== null && email === "") setEmail(session.email);
  }, [session, email]);

  const submitOrder = useCallback(async () => {
    const body: CreateOrderInput = {
      sku,
      email,
      provider,
      ...(note.trim() === "" ? {} : { note: note.trim() }),
    };
    try {
      const order = await license.createOrder(body);
      setCreated(order);
      setNote("");
    } catch {
      // Kesalahan sudah tampil lewat `error`.
    }
  }, [license, sku, email, provider, note]);

  const redeem = useCallback(async () => {
    if (code.trim() === "") return;
    try {
      const entry = await license.activate(code.trim());
      setRedeemed(entry.formatted);
      setCode("");
    } catch {
      // Kesalahan sudah tampil lewat `error`.
    }
  }, [license, code]);

  if (session === null) {
    return (
      <div data-testid="panel-license">
        <SignedOutCard />
      </div>
    );
  }

  const verdict = license.entitlement?.verdict ?? null;
  const limits = license.entitlement?.limits ?? null;

  return (
    <div data-testid="panel-license">
      {/* ---- Status lisensi perangkat ---- */}
      <section className="card card-wide" data-testid="license-status">
        <div className="capture-head">
          <h2>{t("license.status.title")}</h2>
          <span
            className={`badge${verdict?.allowed === true ? " badge-ok" : " badge-warn"}`}
            data-testid="license-verdict"
          >
            {verdict === null ? t("license.status.unknown") : t(`license.state.${verdict.state}`)}
          </span>
        </div>

        {license.error !== null && (
          <p className="banner banner-error" role="status" data-testid="license-error">
            {license.error}
          </p>
        )}
        {redeemed !== null && (
          <p className="banner banner-ok" role="status" data-testid="license-redeemed">
            {t("license.redeemed", { code: redeemed })}
          </p>
        )}

        <p className="note" data-testid="license-verdict-reason">
          {verdict?.reason ?? t("license.status.allowed")}
        </p>

        {limits !== null && (
          <ul className="note" data-testid="license-limits">
            <li>
              {limits.maxActiveGalleries === null
                ? t("license.limits.galleriesUnlimited")
                : t("license.limits.galleries", { count: limits.maxActiveGalleries })}
            </li>
            <li>
              {limits.allowsWhiteLabel ? t("license.limits.whiteLabelYes") : t("license.limits.whiteLabelNo")}
            </li>
            <li>
              {limits.allowsCommercialUse
                ? t("license.limits.commercialYes")
                : t("license.limits.commercialNo")}
            </li>
          </ul>
        )}

        <div className="field-row">
          <label className="field">
            <span>{t("license.activate.label")}</span>
            <input
              type="text"
              value={code}
              placeholder={t("license.activate.placeholder")}
              data-testid="license-activate-input"
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button
            className="btn"
            type="button"
            disabled={license.busy || code.trim() === ""}
            data-testid="license-activate"
            onClick={() => void redeem()}
          >
            {t("license.activate.submit")}
          </button>
        </div>
        <p className="note">{t("license.activate.hint")}</p>
      </section>

      {/* ---- Katalog ---- */}
      <section className="card card-wide" data-testid="license-catalog">
        <div className="capture-head">
          <h2>{t("license.catalog.title")}</h2>
          <span className="badge">
            {license.loading ? t("license.loading") : t("license.catalog.hint")}
          </span>
        </div>

        <div className="field-row">
          {license.catalog.items.map((item) => (
            <div className="card" key={item.sku} data-testid={`license-sku-${item.sku}`}>
              <h3>{item.name}</h3>
              <p data-testid={`license-price-${item.sku}`}>
                <strong>{formatIdr(item.priceIdr)}</strong>
              </p>
              <p className="note">{item.blurb}</p>
              <button
                className="btn btn-ghost btn-small"
                type="button"
                data-testid={`license-choose-${item.sku}`}
                onClick={() => setSku(item.sku)}
              >
                {t("license.catalog.choose")}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Buat order ---- */}
      <section className="card card-wide" data-testid="license-order-form">
        <div className="capture-head">
          <h2>{t("license.order.title")}</h2>
          <span className="badge">{t("license.order.hint")}</span>
        </div>

        {created !== null && (
          <p className="banner banner-ok" role="status" data-testid="license-order-created">
            {t("license.order.created", { id: created.id, amount: formatIdr(created.amountIdr) })}
          </p>
        )}

        <div className="field-row">
          <label className="field">
            <span>{t("license.order.sku")}</span>
            <select
              value={sku}
              data-testid="license-order-sku"
              onChange={(event) => setSku(event.target.value as LicenseSkuId)}
            >
              {LICENSE_SKU_IDS.map((id) => (
                <option key={id} value={id}>
                  {license.catalog.items.find((i) => i.sku === id)?.name ?? id}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("license.order.email")}</span>
            <input
              type="email"
              value={email}
              data-testid="license-order-email"
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{t("license.order.provider")}</span>
            <select
              value={provider}
              data-testid="license-order-provider"
              onChange={(event) => setProvider(event.target.value as OrderProvider)}
            >
              {license.catalog.providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.live}>
                  {p.live ? p.id : `${p.id} — ${t("license.provider.notLive")}`}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("license.order.note")}</span>
            <input
              type="text"
              value={note}
              data-testid="license-order-note"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        </div>

        <p className="note">{t("license.order.priceHint")}</p>

        <button
          className="btn"
          type="button"
          disabled={license.busy || email.trim() === ""}
          data-testid="license-order-submit"
          onClick={() => void submitOrder()}
        >
          {t("license.order.submit")}
        </button>
      </section>

      {/* ---- Daftar order ---- */}
      <section className="card card-wide" data-testid="license-orders">
        <div className="capture-head">
          <h2>{t("license.orders.title")}</h2>
          <button
            className="btn btn-ghost btn-small"
            type="button"
            disabled={license.loading}
            data-testid="license-orders-refresh"
            onClick={() => void license.refresh()}
          >
            {t("license.refresh")}
          </button>
        </div>

        {license.orders.length === 0 ? (
          <p className="note" data-testid="license-orders-empty">
            {t("license.orders.empty")}
          </p>
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-testid="license-orders-table">
              <thead>
                <tr>
                  <th>{t("license.orders.sku")}</th>
                  <th>{t("license.orders.email")}</th>
                  <th>{t("license.orders.amount")}</th>
                  <th>{t("license.orders.status")}</th>
                  <th>{t("license.orders.code")}</th>
                  <th>{t("license.orders.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {license.orders.map((order) => (
                  <tr key={order.id} data-testid={`license-order-${order.id}`}>
                    <td>{order.skuName}</td>
                    <td className="muted">{order.email}</td>
                    <td>{formatIdr(order.amountIdr)}</td>
                    <td data-testid={`license-order-status-${order.id}`}>
                      {ORDER_STATUS_LABELS[order.status]}
                    </td>
                    <td>
                      {order.referenceFormatted === null ? (
                        <span className="muted">{t("license.orders.noCode")}</span>
                      ) : (
                        <code data-testid={`license-order-code-${order.id}`}>
                          {order.referenceFormatted}
                        </code>
                      )}
                    </td>
                    <td>
                      {isOrderSettled(order.status)
                        ? t("license.orders.settled")
                        : OFFERED[order.status].map((next) => (
                            <button
                              className="btn btn-ghost btn-small"
                              key={next}
                              type="button"
                              disabled={license.busy || !canTransitionOrder(order.status, next)}
                              data-testid={`license-order-${order.id}-to-${next}`}
                              onClick={() => void license.setOrderStatus(order.id, next)}
                            >
                              {ORDER_STATUS_LABELS[next]}
                            </button>
                          ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
