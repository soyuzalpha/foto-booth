import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { APP_VERSION } from "@foto-booth/shared";

import App from "./App";
import "./lib/i18n";
import { initSentry } from "./lib/telemetry/sentry.ts";
import "./styles.css";

// Telemetri dipasang **sebelum** React supaya error saat render pertama pun
// tertangkap. Tanpa `VITE_SENTRY_DSN` ini no-op total (tanpa jaringan, tanpa
// log) — kiosk klien yang tak mau telemetri tetap jalan apa adanya.
const sentry = initSentry({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  release: APP_VERSION,
});

window.addEventListener("error", (event) => {
  sentry.captureError(event.error ?? event.message, { source: "window.error" });
});

window.addEventListener("unhandledrejection", (event) => {
  sentry.captureError(event.reason, { source: "unhandledrejection" });
});

const container = document.getElementById("root");

if (container === null) {
  throw new Error("#root tidak ditemukan di index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
