export const locales = ["de", "en", "fr", "es", "it", "pl"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

export const localeLabels: Record<Locale, string> = {
  de: "Deutsch",
  en: "English",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  pl: "Polski",
};

/**
 * v1.4.25 W9e — locales actively maintained by the project owner.
 * Locales outside this set are AI-initial translations and surface a
 * <MaintainershipBanner> notice at the top of the auth shell so users
 * know to expect rough edges and where to contribute fixes. Promoting
 * a locale here turns the banner off.
 */
const MAINTAINED_LOCALES: ReadonlySet<Locale> = new Set(["de", "en"]);

export function isMaintainedLocale(locale: Locale): boolean {
  return MAINTAINED_LOCALES.has(locale);
}
