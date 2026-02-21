"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { locales, defaultLocale, type Locale } from "./config";

import deMessages from "../../../messages/de.json";
import enMessages from "../../../messages/en.json";

const allMessages: Record<Locale, Record<string, unknown>> = {
  de: deMessages,
  en: enMessages,
};

// Resolve nested key like "nav.dashboard" from a message object
function resolveKey(
  messages: Record<string, unknown>,
  key: string,
): string | undefined {
  const parts = key.split(".");
  let current: unknown = messages;

  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return typeof current === "string" ? current : undefined;
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectSystemLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const browserLang = navigator.language.split("-")[0];
  return (locales as readonly string[]).includes(browserLang)
    ? (browserLang as Locale)
    : defaultLocale;
}

function getSavedLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  const saved = localStorage.getItem("healthlog-locale");
  if (saved && (locales as readonly string[]).includes(saved)) {
    return saved as Locale;
  }
  return null;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    return getSavedLocale() ?? detectSystemLocale();
  });

  const setLocale = useCallback((newLocale: Locale) => {
    if ((locales as readonly string[]).includes(newLocale)) {
      setLocaleState(newLocale);
      localStorage.setItem("healthlog-locale", newLocale);
      document.documentElement.lang = newLocale;
    }
  }, []);

  // Set HTML lang on mount
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let value = resolveKey(allMessages[locale], key);

      // Fallback to German if key missing in current locale
      if (value === undefined && locale !== "de") {
        value = resolveKey(allMessages.de, key);
      }

      // Fallback to key itself
      if (value === undefined) {
        return key;
      }

      // Replace {param} placeholders
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }

      return value;
    },
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslations() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useTranslations must be used within I18nProvider");
  }
  return context;
}
