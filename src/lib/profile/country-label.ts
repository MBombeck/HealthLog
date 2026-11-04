/**
 * Country names in the app languages, for the source lines of the life
 * circumstances (screening hints, AUDIT-C cut-offs): a rule always says whose
 * rule it is, in the language of the account reading it.
 *
 * Client-safe, no imports.
 */
export type SourceCountry = "DE" | "KR" | "US";

const NAMES: Readonly<Record<string, Readonly<Record<SourceCountry, string>>>> =
  {
    de: { DE: "Deutschland", KR: "Südkorea", US: "USA" },
    en: { DE: "Germany", KR: "South Korea", US: "United States" },
    es: { DE: "Alemania", KR: "Corea del Sur", US: "Estados Unidos" },
    fr: { DE: "Allemagne", KR: "Corée du Sud", US: "États-Unis" },
    it: { DE: "Germania", KR: "Corea del Sud", US: "Stati Uniti" },
    pl: { DE: "Niemcy", KR: "Korea Południowa", US: "Stany Zjednoczone" },
    nl: { DE: "Duitsland", KR: "Zuid-Korea", US: "Verenigde Staten" },
    ko: { DE: "독일", KR: "대한민국", US: "미국" },
    "pt-BR": { DE: "Alemanha", KR: "Coreia do Sul", US: "Estados Unidos" },
    ru: { DE: "Германия", KR: "Южная Корея", US: "США" },
  };

export function countryLabel(
  country: SourceCountry,
  locale: string | null | undefined,
): string {
  return (NAMES[locale ?? "en"] ?? NAMES.en)[country];
}
