export const locales = ["de", "en"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "de";

export const localeLabels: Record<Locale, string> = {
  de: "Deutsch",
  en: "English",
};
