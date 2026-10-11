import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Tombol "install sebagai app".
 *
 * Chrome/Edge mengirim `beforeinstallprompt`; event-nya harus disimpan dan
 * dipanggil nanti dari gesture pengguna. Safari/Firefox tidak mengirim event
 * ini — di sana tombolnya cukup tidak muncul.
 */
export function useInstallPrompt(): { canInstall: boolean; install: () => void } {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };

    const onInstalled = () => setDeferred(null);

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(() => {
    if (deferred === null) return;
    void deferred.prompt();
    void deferred.userChoice.then(() => setDeferred(null));
  }, [deferred]);

  return { canInstall: deferred !== null, install };
}
