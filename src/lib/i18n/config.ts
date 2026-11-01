export const locales = [
  "de",
  "en",
  "fr",
  "es",
  "it",
  "pl",
  "ko",
  "nl",
  "pt-BR",
  "ru",
] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

/**
 * Narrow an arbitrary stored / request-supplied string to a shipped locale,
 * falling back to the app default.
 *
 * Background paths (the reminder worker, the Coach completion) historically
 * hand-rolled this as `locale === "en" || locale === "de" ? locale : default`,
 * which silently collapsed es / fr / it / pl to English even though their
 * bundles were complete. Route every such coercion through here so adding a
 * locale to `locales` is the only edit a new language needs.
 */
export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (locales as readonly string[]).includes(value)
  );
}

/**
 * Map a BCP-47 language tag (`navigator.language`, one Accept-Language entry)
 * to a shipped locale: an exact match first, case-insensitive so `pt-br`
 * finds `pt-BR`, then the primary subtag, so `de-AT` reads German and `pt-PT`
 * reads the one Portuguese bundle rather than English.
 */
export function localeFromLanguageTag(
  tag: string | null | undefined,
): Locale | null {
  const lower = tag?.trim().toLowerCase();
  if (!lower) return null;
  const exact = locales.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const primary = lower.split("-")[0];
  return locales.find((l) => l.toLowerCase().split("-")[0] === primary) ?? null;
}

export function coerceLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * English name of each shipped language, for model-facing directives ("reply
 * in French"). Distinct from `localeLabels`, which is the endonym shown in the
 * language picker — a prompt directive has to be written in the prompt's own
 * language to be reliably followed.
 */
export const localeLanguageNames: Record<Locale, string> = {
  de: "German",
  en: "English",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pl: "Polish",
  ko: "Korean",
  nl: "Dutch",
  "pt-BR": "Brazilian Portuguese",
  ru: "Russian",
};

export const localeLabels: Record<Locale, string> = {
  de: "Deutsch",
  en: "English",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  pl: "Polski",
  ko: "한국어",
  nl: "Nederlands",
  "pt-BR": "Português (Brasil)",
  ru: "Русский",
};

/**
 * v1.4.25 — locales actively maintained by the project owner.
 * Locales outside this set are AI-initial translations and surface a
 * <MaintainershipBanner> notice at the top of the auth shell so users
 * know to expect rough edges and where to contribute fixes. Promoting
 * a locale here turns the banner off.
 */
const MAINTAINED_LOCALES: ReadonlySet<Locale> = new Set(["de", "en"]);

export function isMaintainedLocale(locale: Locale): boolean {
  return MAINTAINED_LOCALES.has(locale);
}
