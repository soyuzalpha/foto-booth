/**
 * Panel booking: ringkasan okupansi, daftar permintaan, paket, dan setelan.
 *
 * Urutan blok mengikuti urutan kerja operator:
 *
 *   1. **ringkasan** — berapa yang menunggu, berapa yang terkunci;
 *   2. **daftar permintaan** — tindakan harian: setujui, tolak, geser, tandai;
 *   3. **paket** — diubah saat menaikkan harga, bukan tiap hari;
 *   4. **setelan** — sekali di awal, lalu jarang disentuh.
 *
 * Sesi operator dipakai bersama tab Galeri (`useGallery()`): masuk sekali di
 * salah satu tab, dan tab lain langsung ikut. Panel ini **tidak** menyimpan
 * tokennya sendiri — dua salinan token cepat atau lambat berbeda.
 *
 * Pembayaran: `paymentProvider` ditampilkan apa adanya. Selama masih `none`
 * atau `manual`, panel ini menyebutnya terus terang — tidak ada tombol
 * "bayar sekarang" yang menyesatkan.
 */

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  formatDateTimeId,
  type Booking,
  type BookingOperatorStatus,
  type CreateBookingPackage,
  type DepositStatus,
} from "@foto-booth/shared";

import { useGallery } from "../lib/gallery/galleryContext.ts";
import { useBookings } from "../lib/booking/useBookings.ts";

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

function rupiah(value: number): string {
  return IDR.format(value);
}

/** Sesi belum ada: arahkan ke tab yang punya formulir masuknya. */
function SignedOutCard(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="card" data-testid="booking-signed-out">
      <h2>{t("booking.title")}</h2>
      <p className="note">{t("booking.signedOut")}</p>
    </section>
  );
}

function ReportCard({
  total,
  loading,
}: {
  total: { requested: number; booked: number; bookedHours: number; revenueIdr: number } | null;
  loading: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <section className="card" data-testid="booking-report">
      <h2>{t("booking.report.title")}</h2>
      {total === null ? (
        <p className="note">{loading ? t("booking.loading") : t("booking.report.empty")}</p>
      ) : (
        <dl>
          <div className="row">
            <dt>{t("booking.report.requested")}</dt>
            <dd data-testid="booking-report-requested">{total.requested}</dd>
          </div>
          <div className="row">
            <dt>{t("booking.report.booked")}</dt>
            <dd data-testid="booking-report-booked">{total.booked}</dd>
          </div>
          <div className="row">
            <dt>{t("booking.report.hours")}</dt>
            <dd data-testid="booking-report-hours">{total.bookedHours}</dd>
          </div>
          <div className="row">
            <dt>{t("booking.report.revenue")}</dt>
            <dd data-testid="booking-report-revenue">{rupiah(total.revenueIdr)}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}

function BookingRow({
  booking,
  timezoneOffsetMinutes,
  busy,
  onStatus,
  onDeposit,
  onReschedule,
}: {
  booking: Booking;
  timezoneOffsetMinutes: number;
  busy: boolean;
  onStatus: (id: string, status: BookingOperatorStatus, reason?: string) => Promise<void>;
  onDeposit: (id: string, status: DepositStatus) => Promise<void>;
  onReschedule: (id: string, start: string) => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [rescheduling, setRescheduling] = useState(false);
  const [newStart, setNewStart] = useState("");

  const terminal = booking.status === "cancelled" || booking.status === "rejected" || booking.status === "completed";

  return (
    <li className="gallery-list" data-testid={`booking-row-${booking.id}`}>
      <div className="capture-head">
        <strong>{booking.name}</strong>
        <span className={`badge ${booking.status === "approved" ? "badge-ok" : terminal ? "badge-off" : "badge-warn"}`}>
          {t(`booking.status.${booking.status}`)}
        </span>
      </div>

      <dl>
        <div className="row">
          <dt>{t("booking.field.when")}</dt>
          <dd>{formatDateTimeId(booking.start, timezoneOffsetMinutes)}</dd>
        </div>
        <div className="row">
          <dt>{t("booking.field.package")}</dt>
          <dd>
            {booking.packageName} · {rupiah(booking.priceIdr)}
          </dd>
        </div>
        <div className="row">
          <dt>{t("booking.field.contact")}</dt>
          <dd>
            {booking.email} · {booking.phone}
          </dd>
        </div>
        <div className="row">
          <dt>{t("booking.field.deposit")}</dt>
          <dd data-testid={`booking-deposit-${booking.id}`}>
            <span className={`badge ${booking.depositStatus === "paid" ? "badge-ok" : "badge-warn"}`}>
              {t(`booking.deposit.${booking.depositStatus}`)}
            </span>{" "}
            {rupiah(booking.depositIdr)}
          </dd>
        </div>
      </dl>

      {booking.reason !== undefined && booking.reason !== "" && (
        <p className="note">{t("booking.field.reason")}: {booking.reason}</p>
      )}

      <div className="field-row">
        {booking.status === "requested" && (
          <button
            className="btn btn-small"
            type="button"
            disabled={busy}
            data-testid={`booking-approve-${booking.id}`}
            onClick={() => void onStatus(booking.id, "approved")}
          >
            {t("booking.action.approve")}
          </button>
        )}
        {booking.status === "approved" && (
          <button
            className="btn btn-small"
            type="button"
            disabled={busy}
            data-testid={`booking-complete-${booking.id}`}
            onClick={() => void onStatus(booking.id, "completed")}
          >
            {t("booking.action.complete")}
          </button>
        )}
        {(booking.status === "requested" || booking.status === "approved") && (
          <>
            <button
              className="btn btn-ghost btn-small"
              type="button"
              disabled={busy}
              data-testid={`booking-reject-${booking.id}`}
              onClick={() => {
                const reason = window.prompt(t("booking.action.rejectPrompt")) ?? undefined;
                void onStatus(booking.id, "rejected", reason);
              }}
            >
              {t("booking.action.reject")}
            </button>
            <button
              className="btn btn-ghost btn-small"
              type="button"
              disabled={busy}
              data-testid={`booking-cancel-${booking.id}`}
              onClick={() => {
                if (window.confirm(t("booking.action.cancelConfirm"))) {
                  void onStatus(booking.id, "cancelled");
                }
              }}
            >
              {t("booking.action.cancel")}
            </button>
            <button
              className="btn btn-ghost btn-small"
              type="button"
              disabled={busy}
              data-testid={`booking-reschedule-${booking.id}`}
              onClick={() => setRescheduling((open) => !open)}
            >
              {t("booking.action.reschedule")}
            </button>
          </>
        )}
        {booking.depositIdr > 0 && booking.depositStatus !== "paid" && (
          <button
            className="btn btn-small"
            type="button"
            disabled={busy}
            data-testid={`booking-mark-paid-${booking.id}`}
            onClick={() => void onDeposit(booking.id, "paid")}
          >
            {t("booking.action.markPaid")}
          </button>
        )}
      </div>

      {rescheduling && (
        <div className="field-row">
          <label className="field">
            <span>{t("booking.action.newTime")}</span>
            <input
              type="datetime-local"
              value={newStart}
              data-testid={`booking-newtime-${booking.id}`}
              onChange={(event) => setNewStart(event.target.value)}
            />
          </label>
          <button
            className="btn btn-small"
            type="button"
            disabled={busy || newStart === ""}
            data-testid={`booking-reschedule-save-${booking.id}`}
            onClick={() => {
              // `datetime-local` memberi waktu dinding lokal browser; konversi
              // ke instant UTC supaya server menerima titik waktu yang sama.
              const parsed = new Date(newStart);
              if (Number.isNaN(parsed.getTime())) return;
              void onReschedule(booking.id, parsed.toISOString()).then(() => setRescheduling(false));
            }}
          >
            {t("booking.action.saveTime")}
          </button>
        </div>
      )}
    </li>
  );
}

function PackageCard({
  packages,
  busy,
  onCreate,
}: {
  packages: { id: string; name: string; durationMinutes: number; priceIdr: number; depositIdr: number; active: boolean }[];
  busy: boolean;
  onCreate: (body: CreateBookingPackage) => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [priceIdr, setPriceIdr] = useState("500000");
  const [depositIdr, setDepositIdr] = useState("100000");

  const submit = useCallback(async () => {
    const duration = Number.parseInt(durationMinutes, 10);
    const price = Number.parseInt(priceIdr, 10);
    const deposit = Number.parseInt(depositIdr, 10);
    if (name.trim() === "" || !Number.isFinite(duration) || !Number.isFinite(price)) return;
    if (deposit > price) return;

    await onCreate({
      name: name.trim(),
      durationMinutes: duration,
      priceIdr: price,
      depositIdr: Number.isFinite(deposit) ? deposit : 0,
      active: true,
    });
    setName("");
  }, [depositIdr, durationMinutes, name, onCreate, priceIdr]);

  const depositTooBig = Number.parseInt(depositIdr, 10) > Number.parseInt(priceIdr, 10);

  return (
    <section className="card card-wide" data-testid="booking-packages">
      <h2>{t("booking.packages.title")}</h2>

      {packages.length === 0 ? (
        <p className="note">{t("booking.packages.empty")}</p>
      ) : (
        <ul className="gallery-list">
          {packages.map((pkg) => (
            <li key={pkg.id} data-testid={`booking-package-${pkg.id}`}>
              <div className="capture-head">
                <strong>{pkg.name}</strong>
                <span className={`badge ${pkg.active ? "badge-ok" : "badge-off"}`}>
                  {pkg.active ? t("booking.packages.active") : t("booking.packages.inactive")}
                </span>
              </div>
              <p className="note">
                {t("booking.packages.detail", {
                  minutes: pkg.durationMinutes,
                  price: rupiah(pkg.priceIdr),
                  deposit: rupiah(pkg.depositIdr),
                })}
              </p>
            </li>
          ))}
        </ul>
      )}

      <h3>{t("booking.packages.createTitle")}</h3>
      <label className="field">
        <span>{t("booking.packages.name")}</span>
        <input
          type="text"
          value={name}
          data-testid="booking-package-name"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span>{t("booking.packages.duration")}</span>
          <input
            type="number"
            min={15}
            value={durationMinutes}
            data-testid="booking-package-duration"
            onChange={(event) => setDurationMinutes(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("booking.packages.price")}</span>
          <input
            type="number"
            min={0}
            value={priceIdr}
            data-testid="booking-package-price"
            onChange={(event) => setPriceIdr(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("booking.packages.deposit")}</span>
          <input
            type="number"
            min={0}
            value={depositIdr}
            data-testid="booking-package-deposit"
            onChange={(event) => setDepositIdr(event.target.value)}
          />
        </label>
      </div>
      {depositTooBig && (
        <p className="banner banner-warn" role="status">
          {t("booking.packages.depositTooBig")}
        </p>
      )}
      <div className="field-row">
        <button
          className="btn"
          type="button"
          disabled={busy || name.trim() === "" || depositTooBig}
          data-testid="booking-package-create"
          onClick={() => void submit()}
        >
          {busy ? t("booking.packages.creating") : t("booking.packages.create")}
        </button>
      </div>
    </section>
  );
}

function SettingsCard({
  bufferMinutes,
  minNoticeHours,
  maxAdvanceDays,
  requireDeposit,
  paymentProvider,
  busy,
  onSave,
}: {
  bufferMinutes: number;
  minNoticeHours: number;
  maxAdvanceDays: number;
  requireDeposit: boolean;
  paymentProvider: string;
  busy: boolean;
  onSave: (body: {
    bufferMinutes?: number;
    minNoticeHours?: number;
    maxAdvanceDays?: number;
    requireDeposit?: boolean;
    paymentProvider?: "none" | "manual";
  }) => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [buffer, setBuffer] = useState(String(bufferMinutes));
  const [notice, setNotice] = useState(String(minNoticeHours));
  const [advance, setAdvance] = useState(String(maxAdvanceDays));
  const [deposit, setDeposit] = useState(requireDeposit);
  const [provider, setProvider] = useState<"none" | "manual">(
    paymentProvider === "manual" ? "manual" : "none",
  );

  return (
    <section className="card card-wide" data-testid="booking-settings">
      <h2>{t("booking.settings.title")}</h2>
      <p className="note">{t("booking.settings.note")}</p>

      <div className="field-row">
        <label className="field">
          <span>{t("booking.settings.buffer")}</span>
          <input
            type="number"
            min={0}
            max={240}
            value={buffer}
            data-testid="booking-setting-buffer"
            onChange={(event) => setBuffer(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("booking.settings.notice")}</span>
          <input
            type="number"
            min={0}
            value={notice}
            data-testid="booking-setting-notice"
            onChange={(event) => setNotice(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("booking.settings.advance")}</span>
          <input
            type="number"
            min={1}
            value={advance}
            data-testid="booking-setting-advance"
            onChange={(event) => setAdvance(event.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span>{t("booking.settings.provider")}</span>
        <select
          value={provider}
          data-testid="booking-setting-provider"
          onChange={(event) => setProvider(event.target.value === "manual" ? "manual" : "none")}
        >
          <option value="none">{t("booking.settings.providerNone")}</option>
          <option value="manual">{t("booking.settings.providerManual")}</option>
        </select>
      </label>
      <p className="note" data-testid="booking-provider-note">
        {t("booking.settings.providerNote")}
      </p>

      <label className="check">
        <input
          type="checkbox"
          checked={deposit}
          data-testid="booking-setting-require-deposit"
          onChange={(event) => setDeposit(event.target.checked)}
        />
        <span>{t("booking.settings.requireDeposit")}</span>
      </label>

      <div className="field-row">
        <button
          className="btn"
          type="button"
          disabled={busy}
          data-testid="booking-settings-save"
          onClick={() =>
            void onSave({
              bufferMinutes: Number.parseInt(buffer, 10),
              minNoticeHours: Number.parseInt(notice, 10),
              maxAdvanceDays: Number.parseInt(advance, 10),
              requireDeposit: deposit,
              paymentProvider: provider,
            })
          }
        >
          {busy ? t("booking.saving") : t("booking.settings.save")}
        </button>
      </div>
    </section>
  );
}

export default function BookingPanel(): React.JSX.Element {
  const { t } = useTranslation();
  const { session } = useGallery();
  const bookings = useBookings({ token: session?.token ?? null });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const pending = useMemo(
    () => bookings.bookings.filter((booking) => booking.status === "requested"),
    [bookings.bookings],
  );

  if (session === null) return <SignedOutCard />;

  return (
    <div data-testid="panel-booking">
      <div className="grid">
        <ReportCard total={bookings.report?.total ?? null} loading={bookings.loading} />

        <section className="card">
          <h2>{t("booking.pending.title")}</h2>
          <p className="note">{t("booking.pending.note")}</p>
          <p className="badge badge-warn" data-testid="booking-pending-count">
            {pending.length}
          </p>
          <div className="field-row">
            <button
              className="btn btn-small"
              type="button"
              disabled={bookings.loading}
              data-testid="booking-refresh"
              onClick={() => void run(async () => {
                await bookings.refresh();
                await bookings.refreshReport();
              })}
            >
              {bookings.loading ? t("booking.loading") : t("booking.refresh")}
            </button>
          </div>
        </section>
      </div>

      {(actionError ?? bookings.error) !== null && (
        <p className="banner banner-error" role="status" data-testid="booking-error">
          {actionError ?? bookings.error}
        </p>
      )}

      <section className="card card-wide" data-testid="booking-list">
        <h2>{t("booking.list.title")}</h2>
        {bookings.bookings.length === 0 ? (
          <p className="note">{bookings.loading ? t("booking.loading") : t("booking.list.empty")}</p>
        ) : (
          <ul>
            {bookings.bookings.map((booking) => (
              <BookingRow
                key={booking.id}
                booking={booking}
                timezoneOffsetMinutes={bookings.settings.timezoneOffsetMinutes}
                busy={busy}
                onStatus={(id, status, reason) =>
                  run(() => bookings.setStatus(id, reason === undefined ? { status } : { status, reason }))
                }
                onDeposit={(id, status) => run(() => bookings.setDeposit(id, status))}
                onReschedule={(id, start) => run(() => bookings.reschedule(id, { start }))}
              />
            ))}
          </ul>
        )}
      </section>

      <PackageCard
        packages={bookings.packages}
        busy={busy}
        onCreate={(body) => run(() => bookings.createPackage(body))}
      />

      <SettingsCard
        bufferMinutes={bookings.settings.bufferMinutes}
        minNoticeHours={bookings.settings.minNoticeHours}
        maxAdvanceDays={bookings.settings.maxAdvanceDays}
        requireDeposit={bookings.settings.requireDeposit}
        paymentProvider={bookings.settings.paymentProvider}
        busy={busy}
        onSave={(body) => run(() => bookings.updateSettings(body))}
      />

      <p className="note">{t("booking.footerNote")}</p>
    </div>
  );
}
