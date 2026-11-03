import { de, enUS, es, fr, it, ko, nl, pl, ptBR, ru } from "date-fns/locale";
import type { Locale as DateFnsLocale } from "date-fns";

import type { Locale } from "@/lib/i18n/config";

/**
 * Map the app locale → the date-fns locale so the calendar's month / weekday
 * names match the UI language. Defaults to enUS for anything unmapped.
 * Imported only by the calendars, which load on demand, so the eight
 * locales never ride a page's first load.
 */
export function resolveDateFnsLocale(locale: Locale): DateFnsLocale {
  switch (locale) {
    case "de":
      return de;
    case "es":
      return es;
    case "fr":
      return fr;
    case "it":
      return it;
    case "pl":
      return pl;
    case "ko":
      return ko;
    case "nl":
      return nl;
    case "pt-BR":
      return ptBR;
    case "ru":
      return ru;
    default:
      return enUS;
  }
}
