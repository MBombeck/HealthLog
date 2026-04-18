import deMessages from "../../../messages/de.json";
import enMessages from "../../../messages/en.json";
import { defaultLocale, type Locale } from "./config";

const allMessages: Record<Locale, Record<string, unknown>> = {
  de: deMessages,
  en: enMessages,
};

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

export interface ServerTranslator {
  locale: Locale;
  t(key: string, params?: Record<string, string | number>): string;
}

/**
 * Server-side translator that reads the same messages/{en,de}.json bundles
 * the client uses. Falls back to English, then to the raw key.
 *
 * Use this from API routes / background jobs where useTranslations() is not
 * available. Mirrors the behaviour of the client I18nProvider.
 */
export function getServerTranslator(locale: Locale): ServerTranslator {
  return {
    locale,
    t(key, params) {
      let value = resolveKey(allMessages[locale], key);
      if (value === undefined && locale !== defaultLocale) {
        value = resolveKey(allMessages[defaultLocale], key);
      }
      if (value === undefined) return key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return value;
    },
  };
}
