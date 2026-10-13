import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { APP_NAME, APP_VERSION, CONTENT_KINDS, LOCALES, type Locale } from "@foto-booth/shared";

import CapturePanel from "./components/CapturePanel.tsx";
import BookingPanel from "./components/BookingPanel.tsx";
import DebugPanel from "./components/DebugPanel.tsx";
import GalleryPanel from "./components/GalleryPanel.tsx";
import KioskOverlay from "./components/KioskOverlay.tsx";
import KioskPanel from "./components/KioskPanel.tsx";
import TemplatePanel from "./components/TemplatePanel.tsx";
import UploadStatusPanel from "./components/UploadStatusPanel.tsx";
import { fetchHealth, type HealthResponse } from "./lib/api";
import { useContentSync } from "./lib/content/useContentSync.ts";
import { GalleryProvider } from "./lib/gallery/GalleryProvider.tsx";
import { setLocale } from "./lib/i18n";
import { useKiosk } from "./lib/kiosk/useKiosk.ts";
import { useInstallPrompt } from "./lib/useInstallPrompt";
import { useOnlineStatus } from "./lib/useOnlineStatus";
import { useServiceWorkerStatus } from "./lib/useServiceWorkerStatus";
import { formatBytes, useStorageStatus } from "./lib/useStorageStatus";

function LanguageSwitch(): React.JSX.Element {
  const { i18n, t } = useTranslation();
  const current = i18n.resolvedLanguage as Locale | undefined;

  return (
    <div className="lang" role="group" aria-label={t("locale.label")}>
      {LOCALES.map((locale) => (
        <button
          key={locale}
          type="button"
          aria-pressed={current === locale}
          onClick={() => setLocale(locale)}
        >
          {locale.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function StatusPanel(): React.JSX.Element {
  const { t } = useTranslation();
  const online = useOnlineStatus();
  const sw = useServiceWorkerStatus();
  const storage = useStorageStatus();
  const content = useContentSync(CONTENT_KINDS);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [probed, setProbed] = useState(false);

  // Ping backend saat pertama buka dan setiap kali status jaringan berubah.
  useEffect(() => {
    let cancelled = false;

    void fetchHealth().then((result) => {
      if (cancelled) return;
      setHealth(result);
      setProbed(true);
    });

    return () => {
      cancelled = true;
    };
  }, [online]);

  const reachable = health !== null;

  return (
    <>
      <div className="grid">
        <section className="card">
          <h2>{t("status.connection")}</h2>
          <dl>
            <div className="row">
              <dt>{t("status.connection")}</dt>
              <dd>
                <span className={`badge ${online ? "badge-ok" : "badge-off"}`}>
                  {online ? t("status.connectionOnline") : t("status.connectionOffline")}
                </span>
              </dd>
            </div>
            <div className="row">
              <dt>API</dt>
              <dd>
                {!probed ? (
                  <span className="badge badge-warn">{t("status.checking")}</span>
                ) : reachable ? (
                  <span className="badge badge-ok">v{health.version}</span>
                ) : (
                  <span className="badge badge-off">{t("status.connectionOffline")}</span>
                )}
              </dd>
            </div>
            <div className="row">
              <dt>{t("status.mode")}</dt>
              <dd>
                {online && reachable
                  ? t("status.modeOnline")
                  : online
                    ? t("status.modeHybrid")
                    : t("status.modeOffline")}
              </dd>
            </div>
          </dl>
        </section>

        <section className="card">
          <h2>{t("status.serviceWorker")}</h2>
          <dl>
            <div className="row">
              <dt>{t("status.serviceWorker")}</dt>
              <dd>
                <span className={`badge ${sw === "active" ? "badge-ok" : "badge-warn"}`}>
                  {sw === "active"
                    ? t("status.serviceWorkerActive")
                    : t("status.serviceWorkerInactive")}
                </span>
              </dd>
            </div>
            <div className="row">
              <dt>{t("status.version")}</dt>
              <dd>{APP_VERSION}</dd>
            </div>
          </dl>
          <p className="note">
            {sw === "active"
              ? "App shell tersimpan — aplikasi tetap kebuka tanpa jaringan."
              : "Muat ulang sekali supaya app shell tersimpan di perangkat."}
          </p>
        </section>

        <section className="card card-wide">
          <h2>{t("status.storage")}</h2>
          {storage.kind === "ready" ? (
            <>
              <dl>
                <div className="row">
                  <dt>{t("status.storage")}</dt>
                  <dd>
                    <span className={`badge ${storage.persisted ? "badge-ok" : "badge-warn"}`}>
                      {storage.persisted
                        ? t("status.storagePersistent")
                        : t("status.storageBestEffort")}
                    </span>
                  </dd>
                </div>
              </dl>
              <div className="bar" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.min(
                      100,
                      storage.quotaBytes > 0
                        ? (storage.usageBytes / storage.quotaBytes) * 100
                        : 0,
                    )}%`,
                  }}
                />
              </div>
              <p className="note">
                {t("status.storageUsage", {
                  used: formatBytes(storage.usageBytes),
                  quota: formatBytes(storage.quotaBytes),
                })}
              </p>
            </>
          ) : (
            <p className="note">
              {storage.kind === "unsupported" ? t("status.storageUnavailable") : t("status.checking")}
            </p>
          )}
        </section>

        <section className="card card-wide" data-testid="card-content-cache">
          <h2>{t("status.contentCache")}</h2>
          <dl>
            <div className="row">
              <dt>{t("status.contentCacheState")}</dt>
              <dd>
                <span
                  className={`badge ${content.status === "ok" ? "badge-ok" : "badge-warn"}`}
                  data-testid="content-cache-status"
                >
                  {content.status === "ok"
                    ? t("status.contentCacheReady")
                    : content.status === "syncing"
                      ? t("status.checking")
                      : content.status === "offline"
                        ? t("status.contentCacheOffline")
                        : t("status.contentCacheIdle")}
                </span>
              </dd>
            </div>
            <div className="row">
              <dt>{t("status.contentCacheAssets")}</dt>
              <dd data-testid="content-cache-assets">{content.cachedAssets}</dd>
            </div>
          </dl>
          <p className="note">
            {t("status.contentCacheNote", { kinds: content.syncedKinds.length })}
          </p>
        </section>
      </div>
    </>
  );
}

export default function App(): React.JSX.Element {
  // Provider membungkus semuanya: panel capture, panel galeri, dan status
  // upload membaca galeri aktif + sesi operator yang sama.
  return (
    <GalleryProvider>
      <StudioApp />
    </GalleryProvider>
  );
}

function StudioApp(): React.JSX.Element {
  const { t } = useTranslation();
  const online = useOnlineStatus();
  const { canInstall, install } = useInstallPrompt();
  const [tab, setTab] = useState<"capture" | "template" | "gallery" | "booking" | "kiosk">("capture");
  const kiosk = useKiosk();

  return (
    <div className={`app${kiosk.enabled ? " is-kiosk" : ""}`}>
      <KioskOverlay kiosk={kiosk} />
      <header className="top">
        <div className="top-in">
          <a className="brand" href="/studio/">
            <img src="/studio/icon.svg" alt="" width={34} height={34} />
            {APP_NAME}
          </a>
          <span className={`pill ${online ? "pill-on" : "pill-off"}`}>
            <span className="dot" />
            {online ? t("status.connectionOnline") : t("status.connectionOffline")}
          </span>
          <LanguageSwitch />
        </div>
      </header>

      <main className="main">
        <div className="hero">
          <h1>{t("status.title")}</h1>
          <p className="sub">{t("app.tagline")}</p>
        </div>

        <div className="tabs" role="tablist" data-testid="tabs">
          <button
            className={`tab${tab === "capture" ? " is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={tab === "capture"}
            data-testid="tab-capture"
            onClick={() => setTab("capture")}
          >
            {t("tabs.capture")}
          </button>
          <button
            className={`tab${tab === "template" ? " is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={tab === "template"}
            data-testid="tab-template"
            onClick={() => setTab("template")}
          >
            {t("tabs.template")}
          </button>
          <button
            className={`tab${tab === "gallery" ? " is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={tab === "gallery"}
            data-testid="tab-gallery"
            onClick={() => setTab("gallery")}
          >
            {t("tabs.gallery")}
          </button>
          <button
            className={`tab${tab === "booking" ? " is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={tab === "booking"}
            data-testid="tab-booking"
            onClick={() => setTab("booking")}
          >
            {t("tabs.booking")}
          </button>
          <button
            className={`tab${tab === "kiosk" ? " is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={tab === "kiosk"}
            data-testid="tab-kiosk"
            onClick={() => setTab("kiosk")}
          >
            {t("tabs.kiosk")}
          </button>
        </div>

        {tab === "capture" ? (
          <>
            <CapturePanel />
            <details className="status-panel" open>
              <summary>
                {t("upload.title")}
                <span className="muted"> — {t("upload.pending")}</span>
              </summary>
              <UploadStatusPanel />
            </details>
          </>
        ) : tab === "template" ? (
          <div data-testid="panel-template">
            <TemplatePanel />
          </div>
        ) : tab === "gallery" ? (
          <GalleryPanel />
        ) : tab === "booking" ? (
          <BookingPanel />
        ) : (
          <KioskPanel kiosk={kiosk} />
        )}

        {/* Dashboard status dipindah ke bawah konten: dulu dia duduk di ATAS
            panel capture dan memakan ~700px, jadi capture selalu butuh scroll.
            Sekarang jadi panel lipat di kaki halaman. */}
        <details className="status-panel">
          <summary>
            {t("status.title")}
            <span className="muted"> — {t("status.subtitle")}</span>
          </summary>
          <StatusPanel />
        </details>

        {/* Panel debug di luar panel status: `?debug=1` harus langsung terlihat,
            bukan terkubur di dalam `<details>` yang tertutup. */}
        <DebugPanel />

        {canInstall && (
          <section className="install" style={{ marginTop: 22 }}>
            <p>{t("install.hint")}</p>
            <button className="btn" type="button" onClick={install}>
              {t("install.button")}
            </button>
          </section>
        )}
      </main>

      <footer className="foot">
        <div className="foot-in">
          <span>
            {APP_NAME} v{APP_VERSION} — {t("footer.note")}
          </span>
          <nav>
            <a href="/">{t("footer.landing")}</a>
            <a href="/v1/health">/health</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
