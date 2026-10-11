import { useEffect, useState } from "react";

export type ServiceWorkerStatus = "unsupported" | "pending" | "active";

/**
 * Apakah app shell sudah tersimpan di perangkat.
 *
 * "active" di sini berarti ada service worker yang mengontrol halaman ini —
 * itulah yang bikin aplikasi tetap kebuka saat jaringan mati.
 */
export function useServiceWorkerStatus(): ServiceWorkerStatus {
  const [status, setStatus] = useState<ServiceWorkerStatus>(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return "unsupported";
    }

    return navigator.serviceWorker.controller ? "active" : "pending";
  });

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const onControllerChange = () => setStatus("active");
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    // Service worker pertama kali butuh satu reload untuk mengontrol halaman,
    // jadi status juga dicek ulang setelah registrasi selesai.
    let cancelled = false;
    void navigator.serviceWorker.ready.then(() => {
      if (cancelled) return;
      if (navigator.serviceWorker.controller) setStatus("active");
    });

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return status;
}
