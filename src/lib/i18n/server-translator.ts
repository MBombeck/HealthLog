import { defaultLocale, type Locale } from "./config";
import { formatMessage } from "./format-message";
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
      let source: Locale = locale;
      let value = resolveKey(allMessages[locale], key);
      if (value === undefined && locale !== defaultLocale) {
        value = resolveKey(allMessages[defaultLocale], key);
        source = defaultLocale;
      }
      if (value === undefined) return key;
      // Placeholders and plural blocks are filled literally: a parameter value
      // is never re-read as a template or a `$` replacement pattern
      // (`format-message.ts`). The plural rules are those of the bundle the
      // text came from, so an English fallback picks English forms.
      return formatMessage(value, params, source);
    },
  };
}
