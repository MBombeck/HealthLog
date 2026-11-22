/**
 * Official medication leaflets, step 1 (#1430): the link out to a national
 * medicine registry's own search page.
 *
 * The server makes no request to any registry. This file is a static table of
 * search URL templates, one per registry, and a pure function that fills the
 * medication's name (and its strength where the registry's search finds a
 * product by it) into the template. The person's browser opens the result in a
 * new tab, exactly as if they had typed the name into the registry's search
 * box themselves. Several registries forbid automated collection; a person
 * following a link is not that, and nothing here ever fetches.
 *
 * Every template was checked by hand against the live registry (November 2026)
 * with a real query, "Ramipril" and "Ramipril 5 mg": the `source` comment on
 * each entry says what the registry's own search does with the query and why
 * the template carries what it carries. A registry whose search takes nothing
 * from the address opens on its search page, and the interface asks the person
 * to search for the name there (`prefill: "none"`).
 *
 * Safety: every URL is built from a constant `https:` origin in this table and
 * only the query value is encoded into it; `buildLeafletSearch` re-parses the
 * result and returns null unless its protocol is `https:` and its host is the
 * entry's own. No caller can supply a host.
 */

/** The registries a person can pick, as ISO 3166 alpha-2 codes plus `EU`. */
export const MEDICINE_REGISTRIES = [
  "PL",
  "DE",
  "ES",
  "FR",
  "GB",
  "BE",
  "NL",
  "US",
  "CA",
  "AU",
  "BR",
  "EU",
] as const;

export type MedicineRegistry = (typeof MEDICINE_REGISTRIES)[number];

/** What the setting stores: a registry, or `NONE` for no leaflet search. */
export const MEDICINE_REGISTRY_CHOICES = [
  ...MEDICINE_REGISTRIES,
  "NONE",
] as const;

export type MedicineRegistryChoice = (typeof MEDICINE_REGISTRY_CHOICES)[number];

export function isMedicineRegistryChoice(
  value: unknown,
): value is MedicineRegistryChoice {
  return (
    typeof value === "string" &&
    (MEDICINE_REGISTRY_CHOICES as readonly string[]).includes(value)
  );
}

/**
 * How much of the medication the registry's search address carries:
 *  - `nameAndStrength`: the name and, when the dose reads as a strength, the
 *    strength ("Ramipril 5 mg"); the registry finds the product by both.
 *  - `name`: the name only; the registry finds nothing for "Ramipril 5 mg".
 *  - `none`: the search page opens empty; the person types the name.
 */
export type LeafletPrefill = "nameAndStrength" | "name" | "none";

interface RegistryTemplate {
  /** The only host a link for this registry may point at. */
  host: string;
  /** Who runs the search the link opens. Not translated: a proper name. */
  authority: string;
  prefill: LeafletPrefill;
  /** The search address for one query; `query` is ignored when `none`. */
  build: (query: string) => string;
}

/**
 * Replace the characters a registry's own address parser splits on with a
 * space, before the value is percent-encoded. Encoding alone is not enough
 * where the page decodes the whole query string and splits it afterwards.
 */
function spaceOut(query: string, characters: RegExp): string {
  return query.replace(characters, " ").replace(/\s+/g, " ").trim();
}

const REGISTRY_TEMPLATES: Readonly<Record<MedicineRegistry, RegistryTemplate>> =
  {
    // Poland: the Medicinal Products Register (Rejestr Produktów Leczniczych)
    // of the e-Health Centre. Its search page reads `name` from the address
    // and runs the search; "Ramipril" lists the products, "Ramipril 5 mg"
    // finds nothing, because the strength is a separate field.
    PL: {
      host: "rejestry.ezdrowie.gov.pl",
      authority: "Rejestr Produktów Leczniczych",
      prefill: "name",
      build: (q) =>
        `https://rejestry.ezdrowie.gov.pl/rpl/search?name=${encodeURIComponent(q)}`,
    },
    // Germany: BfArM's AMIce, the official medicinal product information
    // system. It is a session application behind an anonymous sign-in and a
    // terms-of-use page; its search takes nothing from the address. (The
    // PatientenInfo-Service is a private service and its search is a POST
    // form, so it is not linked.)
    DE: {
      host: "portal.bfarm.de",
      authority: "BfArM AMIce",
      prefill: "none",
      build: () => "https://portal.bfarm.de/amguifree/",
    },
    // Spain: AEMPS CIMA. The result list reads `multiple` from the address
    // (the same parameter its home search sends); "Ramipril" lists 73
    // products, "Ramipril 5 mg" none. The page decodes the whole query
    // string before splitting it on `&` and `=`, so those two, and `%`,
    // become spaces first.
    ES: {
      host: "cima.aemps.es",
      authority: "AEMPS CIMA",
      prefill: "name",
      build: (q) =>
        `https://cima.aemps.es/cima/publico/lista.html?multiple=${encodeURIComponent(spaceOut(q, /[&=%]/g))}`,
    },
    // France: the Base de données publique des médicaments. Its home page
    // runs a name search from `choixRecherche=medicament&txtCaracteres=`
    // (the address form of the previous site, which it still honours);
    // "Ramipril" finds 51 medicines, "Ramipril 5 mg" none.
    FR: {
      host: "base-donnees-publique.medicaments.gouv.fr",
      authority: "Base de données publique des médicaments",
      prefill: "name",
      build: (q) =>
        `https://base-donnees-publique.medicaments.gouv.fr/?choixRecherche=medicament&txtCaracteres=${encodeURIComponent(q)}`,
    },
    // United Kingdom: the MHRA Products site, which publishes each product's
    // patient information leaflet. Its search page reads `search` from the
    // address and fills the search; the results show after the site's own
    // one-time disclaimer. Name only, so a strength written differently from
    // the product name cannot narrow the list to nothing.
    GB: {
      host: "products.mhra.gov.uk",
      authority: "MHRA Products",
      prefill: "name",
      build: (q) =>
        `https://products.mhra.gov.uk/search/?search=${encodeURIComponent(q)}&page=1`,
    },
    // Belgium: the FAMHP medicinal product database. Its result page reads
    // `search` as a JSON object `{"term": …}`; "Ramipril 5 mg" lists the
    // 5 mg products of every maker.
    BE: {
      host: "medicinesdatabase.be",
      authority: "FAMHP medicines database",
      prefill: "nameAndStrength",
      build: (q) =>
        `https://medicinesdatabase.be/human-use/medicines?search=${encodeURIComponent(JSON.stringify({ term: q }))}`,
    },
    // Netherlands: the CBG Medicines Information Bank (an Oracle APEX
    // application). Page 2 is its result list and `P2_QS` its quick-search
    // item, set through the APEX address form; the value is wrapped in
    // backslashes so a comma stays part of it. "Ramipril" finds 30 products,
    // "Ramipril 5 mg" none. APEX splits the address on `:` and treats `\` as
    // its quote, so both become spaces first.
    NL: {
      host: "www.geneesmiddeleninformatiebank.nl",
      authority: "CBG Geneesmiddeleninformatiebank",
      prefill: "name",
      build: (q) =>
        `https://www.geneesmiddeleninformatiebank.nl/ords/f?p=111:2::SEARCH::2:P0_DOMAIN,P0_LANG,P2_QS:H,NL,${encodeURIComponent(`\\${spaceOut(q, /[\\:]/g)}\\`)}`,
    },
    // United States: NLM DailyMed, the FDA-submitted labeling. Its search
    // reads `query`; "Ramipril" finds 55 labels, "Ramipril 5 mg" none.
    US: {
      host: "dailymed.nlm.nih.gov",
      authority: "DailyMed",
      prefill: "name",
      build: (q) =>
        `https://dailymed.nlm.nih.gov/dailymed/search.cfm?labeltype=all&query=${encodeURIComponent(q)}`,
    },
    // Canada: Health Canada's Drug Product Database. Its search is a POST
    // form with a session token; the address carries nothing.
    CA: {
      host: "health-products.canada.ca",
      authority: "Health Canada Drug Product Database",
      prefill: "none",
      build: () => "https://health-products.canada.ca/dpd-bdpp/",
    },
    // Australia: the TGA's ARTG search, which links each product's Consumer
    // Medicine Information. It reads `keywords`; "Ramipril 5 mg" lists the
    // 5 mg products first.
    AU: {
      host: "www.tga.gov.au",
      authority: "TGA ARTG",
      prefill: "nameAndStrength",
      build: (q) =>
        `https://www.tga.gov.au/resources/artg?keywords=${encodeURIComponent(q)}`,
    },
    // Brazil: ANVISA's Bulário Eletrônico. The search form reads
    // `nomeProduto` from the address (an in-page route after `#`) and fills
    // the medication field; the person presses "Consultar", which runs the
    // site's own human check.
    BR: {
      host: "consultas.anvisa.gov.br",
      authority: "ANVISA Bulário Eletrônico",
      prefill: "name",
      build: (q) =>
        `https://consultas.anvisa.gov.br/#/bulario/?nomeProduto=${encodeURIComponent(q)}`,
    },
    // European Union: EMA's medicine finder, for centrally authorised
    // medicines. Its search runs as a form post and a facet page that EMA
    // keeps away from automated clients; the address carries nothing.
    EU: {
      host: "www.ema.europa.eu",
      authority: "European Medicines Agency",
      prefill: "none",
      build: () => "https://www.ema.europa.eu/en/medicines",
    },
  };

/** The host a registry's link may point at; tests and the UI use it. */
export function registryHost(registry: MedicineRegistry): string {
  return REGISTRY_TEMPLATES[registry].host;
}

/** Who runs a registry's search, for the settings list. */
export function registryAuthority(registry: MedicineRegistry): string {
  return REGISTRY_TEMPLATES[registry].authority;
}

/**
 * A strength the registries can match, read from the free-text dose: a number
 * and a unit ("5mg", "2,5 mg", "100 µg", "0.5 ml"), written back as
 * "<number> <unit>". Anything else ("1 tablet", "two puffs") is not a
 * strength, and the search carries the name alone.
 */
const STRENGTH_PATTERN =
  /^\s*(\d+(?:[.,]\d+)?)\s*(mg|g|µg|μg|mcg|ug|ml|mL|IE|IU|I\.E\.|%)(?=$|[\s/])/i;

export function strengthFromDose(
  dose: string | null | undefined,
): string | null {
  if (!dose) return null;
  const match = STRENGTH_PATTERN.exec(dose);
  if (!match) return null;
  const unit = match[2].toLowerCase() === "ml" ? "ml" : match[2];
  return `${match[1]} ${unit}`;
}

export interface LeafletSearch {
  registry: MedicineRegistry;
  /** Who runs the search, for the link's label ("DailyMed"). */
  authority: string;
  /** The address to open in a new tab; always `https:` on `host`. */
  url: string;
  host: string;
  prefill: LeafletPrefill;
  /**
   * What the person searches for: the text the address carries, or, when it
   * carries nothing, the text to type on the page that opens.
   */
  searchTerm: string;
}

/**
 * The registry search link for one medication, or null when the person chose
 * no registry or the medication has no name. Pure: no request is made.
 */
export function buildLeafletSearch(
  registry: MedicineRegistryChoice | null | undefined,
  medication: { name: string; dose?: string | null },
): LeafletSearch | null {
  if (!registry || registry === "NONE") return null;
  const template = REGISTRY_TEMPLATES[registry];
  if (!template) return null;
  const name = medication.name.trim().replace(/\s+/g, " ");
  if (!name) return null;
  const strength =
    template.prefill === "nameAndStrength"
      ? strengthFromDose(medication.dose)
      : null;
  const query =
    strength && !name.includes(strength) ? `${name} ${strength}` : name;
  const url = template.build(query);
  // The table is the only source of origins, but the check is cheap and makes
  // the property local: nothing but an `https:` link to the entry's own host
  // ever leaves this function.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.host !== template.host) {
    return null;
  }
  return {
    registry,
    authority: template.authority,
    url,
    host: template.host,
    prefill: template.prefill,
    searchTerm: template.prefill === "none" ? name : query,
  };
}
