/**
 * The registry a person starts with (#1430), derived once from what the
 * account already says about where they are, and only where that is
 * unambiguous. Everything else starts at `NONE`: nothing is opened for a
 * person who has not chosen, and the setting is always theirs to change.
 *
 * Two signals, neither enough alone:
 *  - the time zone names a country, but every account starts on the instance
 *    default zone, so a zone nobody chose would put a person in the wrong
 *    country;
 *  - the language narrows the countries (German: Germany or Belgium; French:
 *    France, Belgium or Canada) but rarely names one.
 * A zone in a country whose language the account speaks is a country. Polish
 * and Brazilian Portuguese name one registry on their own. A zone outside the
 * list (Vienna, Zurich, Mexico City) gives `NONE`, which is right: their
 * registries are not in the table.
 */
import type { Locale } from "@/lib/i18n/config";
import type {
  MedicineRegistry,
  MedicineRegistryChoice,
} from "@/lib/medications/leaflet-registries";

/** The registries a language is spoken with, among those in the table. */
const LOCALE_REGISTRIES: Readonly<Record<Locale, readonly MedicineRegistry[]>> =
  {
    de: ["DE", "BE"],
    en: ["GB", "US", "CA", "AU"],
    fr: ["FR", "BE", "CA"],
    es: ["ES"],
    nl: ["NL", "BE"],
    pl: ["PL"],
    "pt-BR": ["BR"],
    it: [],
    ko: [],
    ru: [],
  };

/** Languages that name one registry without help from the time zone. */
const UNAMBIGUOUS_LOCALES: Readonly<Partial<Record<Locale, MedicineRegistry>>> =
  {
    pl: "PL",
    "pt-BR": "BR",
  };

/** Exact IANA zones of the countries in the table. */
const ZONE_REGISTRY: Readonly<Record<string, MedicineRegistry>> = {
  "Europe/Warsaw": "PL",
  // A country table, not a fallback zone: Berlin is listed because it is in
  // Germany, beside every other zone of the table's countries.
  // eslint-disable-next-line healthlog/no-default-zone-literal
  "Europe/Berlin": "DE",
  "Europe/Busingen": "DE",
  "Europe/Madrid": "ES",
  "Africa/Ceuta": "ES",
  "Atlantic/Canary": "ES",
  "Europe/Paris": "FR",
  "Europe/London": "GB",
  "Europe/Belfast": "GB",
  "Europe/Brussels": "BE",
  "Europe/Amsterdam": "NL",
  "Pacific/Honolulu": "US",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Phoenix": "US",
  "America/Los_Angeles": "US",
  "America/Anchorage": "US",
  "America/Juneau": "US",
  "America/Boise": "US",
  "America/Detroit": "US",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Edmonton": "CA",
  "America/Winnipeg": "CA",
  "America/Regina": "CA",
  "America/Halifax": "CA",
  "America/St_Johns": "CA",
  "America/Moncton": "CA",
  "America/Montreal": "CA",
  "America/Sao_Paulo": "BR",
  "America/Manaus": "BR",
  "America/Fortaleza": "BR",
  "America/Recife": "BR",
  "America/Bahia": "BR",
  "America/Belem": "BR",
  "America/Cuiaba": "BR",
  "America/Campo_Grande": "BR",
  "America/Porto_Velho": "BR",
  "America/Rio_Branco": "BR",
  "America/Maceio": "BR",
  "America/Noronha": "BR",
};

/** Zone families that belong to one country in the table. */
const ZONE_PREFIX_REGISTRY: ReadonlyArray<
  readonly [prefix: string, registry: MedicineRegistry]
> = [
  ["Australia/", "AU"],
  ["America/Indiana/", "US"],
  ["America/Kentucky/", "US"],
  ["America/North_Dakota/", "US"],
  ["US/", "US"],
  ["Canada/", "CA"],
  ["Brazil/", "BR"],
];

function registryOfZone(
  timezone: string | null | undefined,
): MedicineRegistry | null {
  if (!timezone) return null;
  const exact = ZONE_REGISTRY[timezone];
  if (exact) return exact;
  for (const [prefix, registry] of ZONE_PREFIX_REGISTRY) {
    if (timezone.startsWith(prefix)) return registry;
  }
  return null;
}

/**
 * The starting registry for an account. `locale` is the stored language; an
 * account that never picked one (NULL, the instance default) gives no
 * language signal and starts at `NONE`.
 */
export function deriveMedicineRegistry(input: {
  locale: string | null | undefined;
  timezone: string | null | undefined;
}): MedicineRegistryChoice {
  const locale = input.locale as Locale | null | undefined;
  const candidates = (locale && LOCALE_REGISTRIES[locale]) || [];
  const zoneRegistry = registryOfZone(input.timezone);
  if (zoneRegistry && candidates.includes(zoneRegistry)) return zoneRegistry;
  const single = locale ? UNAMBIGUOUS_LOCALES[locale] : undefined;
  return single ?? "NONE";
}
