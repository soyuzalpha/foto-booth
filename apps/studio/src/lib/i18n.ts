import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { DEFAULT_LOCALE, LOCALES, type Locale } from "@foto-booth/shared";

import en from "../locales/en.json";
import id from "../locales/id.json";

const STORAGE_KEY = "foto-booth:locale";

function readStoredLocale(): Locale {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value !== null && (LOCALES as readonly string[]).includes(value)) {
      return value as Locale;
    }
  } catch {
    // localStorage bisa diblokir (mode privat, kebijakan situs). Pakai default.
  }

  return DEFAULT_LOCALE;
}

void i18n.use(initReactI18next).init({
  resources: {
    id: { translation: id },
    en: { translation: en },
  },
  lng: readStoredLocale(),
  fallbackLng: DEFAULT_LOCALE,
  interpolation: { escapeValue: false },
});

export function setLocale(locale: Locale): void {
  void i18n.changeLanguage(locale);

  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Diabaikan: preferensi bahasa tidak kritis.
  }
}

export default i18n;
