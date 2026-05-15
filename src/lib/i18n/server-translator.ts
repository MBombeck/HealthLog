import { defaultLocale, type Locale } from "./config";
import { allMessages, resolveKey } from "./shared-resolve";

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
