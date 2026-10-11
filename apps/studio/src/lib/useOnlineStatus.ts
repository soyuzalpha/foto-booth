import { useEffect, useState } from "react";

/**
 * Status koneksi jaringan.
 *
 * `navigator.onLine` tidak sempurna (cuma tahu ada/tidak ada interface), tapi
 * cukup untuk indikator UI. Cek yang benar-benar bisa dipercaya soal
 * "backend bisa dijangkau" nanti di Fase 1 lewat health ping.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
