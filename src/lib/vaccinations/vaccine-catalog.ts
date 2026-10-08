/**
 * The antigen-level vaccine catalogue: what a dose can be, in one static list.
 *
 * This is NOT a DB table, for the same reason `BIOMARKER_CATALOG` is not one
 * (`src/lib/labs/biomarker-catalog.ts`): the slug is the stable identity, the
 * display name resolves through i18n, the numbers are correctable in a patch
 * release rather than a migration, and an account that has never opened the
 * picker carries no rows for it.
 *
 * ── What it deliberately is not ────────────────────────────────────────────
 *
 * There is no manufacturer column and there is no trade name anywhere in it.
 * Entries are named for the antigen or the disease, synonyms are generic or
 * colloquial, and the one place a trade name may legitimately appear in this
 * feature is the user's own `vaccineName` transcription of their Pass — their
 * data, not our content.
 *
 * The numbers are TYPICAL values for orientation, and `source` names where
 * each one comes from so the sentence rendered beside a dose carries its
 * citation. They are not an individual schedule: what a particular person
 * needs and when depends on their history, their age and their reasons, and
 * that adjudication belongs to their doctor. Nothing in this file or in
 * anything reading it computes what is due — the module renders what a person
 * logged and, at most, offers to set a reminder they confirm themselves.
 *
 * ── Slugs are append-only ──────────────────────────────────────────────────
 *
 * A record stores `antigenSlug` verbatim, backups restore it without
 * validation, and a slug this file has stopped listing must still describe
 * what someone was given. {@link resolveCatalogEntry} is the ONLY lookup path
 * into this file and it returns `null` rather than throwing. Consumers do not
 * call it directly: since v1.42 (#1005) they ask
 * `src/lib/vaccinations/resolve-vaccine-entry.ts`, which tries the catalogue
 * first and the person's own vaccine definitions second, and every consumer
 * answers `null` by falling back to the record's own `vaccineName`. That degrade is a tested
 * guarantee, not an accident — see
 * `src/lib/vaccinations/__tests__/catalog-integrity.test.ts`.
 *
 * ── Combinations ───────────────────────────────────────────────────────────
 *
 * `components` is the axis everything downstream turns on. A combination lists
 * the monovalent antigens it contains, so one Tdap dose counts into the
 * tetanus, the diphtheria AND the pertussis series, and clears a booster
 * reminder for any of them. A monovalent lists itself.
 *
 * ATC codes are the WHO J07 subtree at the most specific level that stays
 * product-blind. Two entries may legitimately share a code: ATC classifies by
 * antigen combination and does not distinguish a full-strength childhood
 * preparation from the reduced-antigen adult one.
 */

/** The monovalent antigens a dose can contain. Combinations reference these. */
export const ANTIGEN_SLUGS = [
  "tetanus",
  "diphtheria",
  "pertussis",
  "polio",
  "measles",
  "mumps",
  "rubella",
  "varicella",
  "hib",
  "hepatitis-a",
  "hepatitis-b",
  "influenza",
  "pneumococcal",
  "herpes-zoster",
  "rsv",
  "covid-19",
  "fsme",
  "hpv",
  "meningococcal-acwy",
  "meningococcal-b",
  "rotavirus",
  "typhoid",
  "rabies",
  "yellow-fever",
  "japanese-encephalitis",
  "cholera",
] as const;

export type AntigenSlug = (typeof ANTIGEN_SLUGS)[number];

/**
 * How the picker groups an entry.
 *
 * `standard` is the general schedule, `standard60` the additions recommended
 * from the later decades, `childhood` what a child's Pass fills up with,
 * `indication` what a particular exposure or condition calls for, and `travel`
 * what a destination does. A person's own Pass mixes all five, which is why
 * the catalogue covers a whole life rather than an adult floor.
 */
export type VaccineCategory =
  "standard" | "standard60" | "childhood" | "indication" | "travel";

export interface VaccineSeed {
  /** Stable EN identity; `vaccinations.catalog.<slug>` resolves the name. */
  slug: string;
  /** WHO ATC code (J07 subtree), most specific level that stays product-blind. */
  atc: string;
  /** Component antigens — self for monovalents. The series-derivation axis. */
  components: readonly AntigenSlug[];
  /** Typical primary-series length, or null (seasonal / single-dose). */
  typicalSeriesDoses: number | null;
  /** Typical booster interval in months, or null. 12 = yearly / seasonal. */
  boosterIntervalMonths: number | null;
  /** Picker grouping. */
  category: VaccineCategory;
  /**
   * The document the numbers on this entry come from, rendered as the
   * footnote beside them. A citation is a proper noun, like a unit: literal,
   * not translated.
   */
  source: string;
  /** Generic search aliases only — never trade names. */
  synonyms?: readonly string[];
}

/** The German standing-committee schedule, for everything on it. */
const STIKO = "STIKO Epid Bull 4/2026";

export const VACCINE_CATALOG: readonly VaccineSeed[] = [
  // ── Monovalent: the general schedule ────────────────────────────────────
  {
    // Primary series in infancy, then a lifelong ten-year rhythm. The
    // ten-year figure is the one number in this file most people already
    // know, and the one a reminder is most often set from.
    slug: "tetanus",
    atc: "J07AM01",
    components: ["tetanus"],
    typicalSeriesDoses: 3,
    boosterIntervalMonths: 120,
    category: "standard",
    source: STIKO,
    synonyms: ["lockjaw"],
  },
  {
    // Travels with tetanus in practice; the schedule and the interval match,
    // which is why the combined preparation is the usual one.
    slug: "diphtheria",
    atc: "J07AF01",
    components: ["diphtheria"],
    typicalSeriesDoses: 3,
    boosterIntervalMonths: 120,
    category: "standard",
    source: STIKO,
  },
  {
    // No fixed adult rhythm: refreshed once in adulthood, and again in each
    // pregnancy, neither of which is an interval. Null rather than a number
    // invented to fill the field.
    slug: "pertussis",
    atc: "J07AJ02",
    components: ["pertussis"],
    typicalSeriesDoses: 3,
    boosterIntervalMonths: null,
    category: "standard",
    source: STIKO,
    synonyms: ["whooping cough"],
  },
  {
    // Four doses in childhood, one refresher in adolescence. Adults refresh
    // only for travel to a region where it still circulates, which is a
    // destination question rather than an interval.
    slug: "polio",
    atc: "J07BF03",
    components: ["polio"],
    typicalSeriesDoses: 4,
    boosterIntervalMonths: null,
    category: "standard",
    source: STIKO,
    synonyms: ["poliomyelitis", "ipv"],
  },
  {
    // Three doses in infancy; no routine adult booster.
    slug: "hepatitis-b",
    atc: "J07BC01",
    components: ["hepatitis-b"],
    typicalSeriesDoses: 3,
    boosterIntervalMonths: null,
    category: "standard",
    source: STIKO,
    synonyms: ["hep b"],
  },
  {
    // Two doses, then variant-adapted refreshers whose cadence is a moving
    // recommendation rather than a fixed schedule. Twelve months is the
    // rhythm the seasonal refresher has settled into.
    slug: "covid-19",
    atc: "J07BN01",
    components: ["covid-19"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: 12,
    category: "standard",
    source: STIKO,
    synonyms: ["coronavirus", "sars-cov-2"],
  },

  // ── Monovalent: added in the later decades ──────────────────────────────
  {
    // Seasonal: one dose per year against that year's strains, so there is no
    // series to be part of. Null rather than 1 — every autumn's dose would
    // otherwise read as a booster on a one-dose series it had already passed.
    slug: "influenza",
    atc: "J07BB02",
    components: ["influenza"],
    typicalSeriesDoses: null,
    boosterIntervalMonths: 12,
    category: "standard60",
    source: STIKO,
    synonyms: ["flu", "seasonal flu"],
  },
  {
    slug: "pneumococcal",
    atc: "J07AL02",
    components: ["pneumococcal"],
    typicalSeriesDoses: 1,
    boosterIntervalMonths: null,
    category: "standard60",
    source: STIKO,
    synonyms: ["pneumonia"],
  },
  {
    // Two doses, two to six months apart; no booster after them.
    slug: "herpes-zoster",
    atc: "J07BK03",
    components: ["herpes-zoster"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: null,
    category: "standard60",
    source: STIKO,
    synonyms: ["shingles", "zoster"],
  },
  {
    slug: "rsv",
    atc: "J07BX05",
    components: ["rsv"],
    typicalSeriesDoses: 1,
    boosterIntervalMonths: null,
    category: "standard60",
    source: STIKO,
    synonyms: ["respiratory syncytial virus"],
  },

  // ── Monovalent: the childhood Pass ──────────────────────────────────────
  {
    // Given as part of a combined preparation in practice; the monovalent
    // entry exists because an older Pass line may record it on its own.
    slug: "measles",
    atc: "J07BD01",
    components: ["measles"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: null,
    category: "childhood",
    source: STIKO,
  },
  {
    slug: "mumps",
    atc: "J07BE01",
    components: ["mumps"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: null,
    category: "childhood",
    source: STIKO,
  },
  {
    slug: "rubella",
    atc: "J07BJ01",
    components: ["rubella"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: null,
    category: "childhood",
    source: STIKO,
    synonyms: ["german measles"],
  },
  {
    slug: "varicella",
    atc: "J07BK01",
    components: ["varicella"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: null,
    category: "childhood",
    source: STIKO,
    synonyms: ["chickenpox"],
  },
  {
    slug: "hib",
    atc: "J07AG01",
    components: ["hib"],
    typicalSeriesDoses: 3,
    boosterIntervalMonths: null,
    category: "childhood",
    source: STIKO,
    synonyms: ["haemophilus influenzae type b"],
  },
  {
    // Oral, and the series is finished early — the whole course sits inside
    // the first months of life.
    slug: "rotavirus",
    atc: "J07BH01",
    components: ["rotavirus"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: null,
    category: "childhood",
    source: STIKO,
  },
  {
    // Two doses when the course starts before fifteen, three when it starts
    // later. Two is the typical value; the record's own `seriesDoses`
    // override is there for the person whose Pass says three.
    slug: "hpv",
    atc: "J07BM03",
    components: ["hpv"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: null,
    category: "childhood",
    source: STIKO,
    synonyms: ["human papillomavirus"],
  },

  // ── Monovalent: by indication ───────────────────────────────────────────
  {
    // Three doses, then a refresher every three to five years while the
    // exposure lasts. Sixty months is the longer end of that window.
    slug: "fsme",
    atc: "J07BA02",
    components: ["fsme"],
    typicalSeriesDoses: 3,
    boosterIntervalMonths: 60,
    category: "indication",
    source: STIKO,
    synonyms: ["tick-borne encephalitis", "tbe"],
  },
  {
    slug: "hepatitis-a",
    atc: "J07BC02",
    components: ["hepatitis-a"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: null,
    category: "indication",
    source: STIKO,
    synonyms: ["hep a"],
  },
  {
    slug: "meningococcal-acwy",
    atc: "J07AH08",
    components: ["meningococcal-acwy"],
    typicalSeriesDoses: 1,
    boosterIntervalMonths: null,
    category: "indication",
    source: STIKO,
    synonyms: ["meningococcus acwy", "quadrivalent meningococcal"],
  },
  {
    slug: "meningococcal-b",
    atc: "J07AH09",
    components: ["meningococcal-b"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: null,
    category: "indication",
    source: STIKO,
    synonyms: ["meningococcus b"],
  },
  {
    // The pre-exposure course. What follows an actual exposure is treatment
    // and is not a schedule this catalogue has an opinion about.
    slug: "rabies",
    atc: "J07BG01",
    components: ["rabies"],
    typicalSeriesDoses: 3,
    boosterIntervalMonths: null,
    category: "indication",
    source: STIKO,
    synonyms: ["lyssa"],
  },

  // ── Monovalent: by destination ──────────────────────────────────────────
  // Not on the standing-committee schedule, so each cites the WHO position
  // paper for its own antigen rather than borrowing a citation from a
  // document that does not cover it.
  {
    slug: "typhoid",
    atc: "J07AP03",
    components: ["typhoid"],
    typicalSeriesDoses: 1,
    boosterIntervalMonths: 36,
    category: "travel",
    source: "WHO position paper on typhoid vaccines",
    synonyms: ["typhoid fever"],
  },
  {
    // One dose is treated as lifelong protection; the certificate that used
    // to expire after ten years no longer does.
    slug: "yellow-fever",
    atc: "J07BL01",
    components: ["yellow-fever"],
    typicalSeriesDoses: 1,
    boosterIntervalMonths: null,
    category: "travel",
    source: "WHO position paper on yellow fever vaccines",
  },
  {
    slug: "japanese-encephalitis",
    atc: "J07BA01",
    components: ["japanese-encephalitis"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: 12,
    category: "travel",
    source: "WHO position paper on Japanese encephalitis vaccines",
  },
  {
    // Oral, and the only entry here whose route is not an injection — which
    // is why route derives from the antigen at the export boundary rather
    // than being asked of the person filling in the form.
    slug: "cholera",
    atc: "J07AE01",
    components: ["cholera"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: 24,
    category: "travel",
    source: "WHO position paper on cholera vaccines",
  },

  // ── Combinations ────────────────────────────────────────────────────────
  {
    // The adult refresher most Passes are full of.
    slug: "td",
    atc: "J07AM51",
    components: ["tetanus", "diphtheria"],
    typicalSeriesDoses: 3,
    boosterIntervalMonths: 120,
    category: "standard",
    source: STIKO,
    synonyms: ["tetanus diphtheria"],
  },
  {
    slug: "tdap",
    atc: "J07AJ52",
    components: ["tetanus", "diphtheria", "pertussis"],
    typicalSeriesDoses: 3,
    boosterIntervalMonths: 120,
    category: "standard",
    source: STIKO,
    synonyms: ["tetanus diphtheria pertussis"],
  },
  {
    slug: "tdap-ipv",
    atc: "J07CA02",
    components: ["tetanus", "diphtheria", "pertussis", "polio"],
    typicalSeriesDoses: 3,
    boosterIntervalMonths: 120,
    category: "standard",
    source: STIKO,
  },
  {
    // The childhood preparation. Same ATC code as the adult one above: ATC
    // classifies the antigen combination and does not distinguish the
    // full-strength form from the reduced-antigen one.
    slug: "dtap-ipv",
    atc: "J07CA02",
    components: ["diphtheria", "tetanus", "pertussis", "polio"],
    typicalSeriesDoses: 4,
    boosterIntervalMonths: null,
    category: "childhood",
    source: STIKO,
  },
  {
    // Six antigens in one injection, which is what makes an infant Pass page
    // short and this catalogue's component axis necessary: one line here
    // counts into six separate series.
    slug: "hexavalent",
    atc: "J07CA09",
    components: [
      "diphtheria",
      "tetanus",
      "pertussis",
      "polio",
      "hib",
      "hepatitis-b",
    ],
    typicalSeriesDoses: 3,
    boosterIntervalMonths: null,
    category: "childhood",
    source: STIKO,
    synonyms: ["six-in-one"],
  },
  {
    slug: "mmr",
    atc: "J07BD52",
    components: ["measles", "mumps", "rubella"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: null,
    category: "childhood",
    source: STIKO,
    synonyms: ["measles mumps rubella"],
  },
  {
    slug: "mmrv",
    atc: "J07BD54",
    components: ["measles", "mumps", "rubella", "varicella"],
    typicalSeriesDoses: 2,
    boosterIntervalMonths: null,
    category: "childhood",
    source: STIKO,
    synonyms: ["measles mumps rubella varicella"],
  },
  {
    slug: "hepa-hepb",
    atc: "J07BC20",
    components: ["hepatitis-a", "hepatitis-b"],
    typicalSeriesDoses: 3,
    boosterIntervalMonths: null,
    category: "travel",
    source: STIKO,
    synonyms: ["hepatitis a and b"],
  },
  {
    slug: "hepa-typhoid",
    atc: "J07CA10",
    components: ["hepatitis-a", "typhoid"],
    typicalSeriesDoses: 1,
    boosterIntervalMonths: null,
    category: "travel",
    source: "WHO position paper on typhoid vaccines",
  },
];

/** Every slug the catalogue currently offers, combinations included. */
export const VACCINE_CATALOG_SLUGS: readonly string[] = VACCINE_CATALOG.map(
  (entry) => entry.slug,
);

const BY_SLUG = new Map<string, VaccineSeed>(
  VACCINE_CATALOG.map((entry) => [entry.slug, entry]),
);

/**
 * The one lookup path into the catalogue.
 *
 * Returns `null` for anything it does not know — an empty slug, a slug a past
 * release wrote and this one no longer lists, a slug restored verbatim from a
 * backup written by an older version. It never throws, because every one of
 * those is a real row belonging to a real person, and the caller's answer is
 * to fall back to the record's own `vaccineName` rather than to fail.
 */
export function resolveCatalogEntry(
  slug: string | null | undefined,
): VaccineSeed | null {
  if (!slug) return null;
  return BY_SLUG.get(slug) ?? null;
}
