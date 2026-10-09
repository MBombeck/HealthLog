/**
 * The one answer to "what was this dose", catalogue or the person's own.
 *
 * Since v1.42 (#1005) a dose can name a vaccine the shipped catalogue does
 * not list: the person defines it once (`CustomVaccine`: a name, the
 * antigens it protects against, a series length, a booster interval) and
 * logs doses against it. Every consumer that used to ask the catalogue —
 * the series derivation, the booster satisfy matcher, the booster mint, the
 * DTO, the doctor report, the document links, MCP search, the picker's info
 * sentences and the booster offer — asks this module instead, so a custom
 * vaccine counts into a series, clears a booster and offers one exactly the
 * way a catalogue entry does.
 *
 * ── Precedence ─────────────────────────────────────────────────────────────
 *
 * The catalogue wins when both resolve. A catalogue slug is the shipped,
 * sourced answer; a definition is the person's own. A dose carries one or
 * the other in practice, and the rule only decides the rare row that
 * carries both (an edit that picked a catalogue entry without clearing the
 * definition).
 *
 * A definition that is soft-deleted does not resolve, and neither does an
 * antigen it lists that the catalogue does not know: storage is tolerant (a
 * restore writes what the file held), the answer is not. A dose with nothing
 * that resolves falls back to its `vaccineName`, the same degrade a dead
 * catalogue slug has always had.
 *
 * Pure apart from {@link loadCustomVaccineLookup}, which takes the client it
 * reads through, so the client components can import the resolver itself.
 */
import type { Prisma } from "@/generated/prisma/client";

import {
  ANTIGEN_SLUGS,
  resolveCatalogEntry,
  type AntigenSlug,
  type VaccineCategory,
} from "@/lib/vaccinations/vaccine-catalog";

/** A definition as the resolver reads it. */
export interface CustomVaccineDefinition {
  id: string;
  name: string;
  components: readonly string[];
  typicalSeriesDoses: number | null;
  boosterIntervalMonths: number | null;
  /** Absent on a DTO, which only ever carries live definitions. */
  deletedAt?: Date | null;
}

/** The record's definitions, by id. */
export type CustomVaccineLookup = ReadonlyMap<string, CustomVaccineDefinition>;

/** The fields of a dose the resolver reads. */
export interface VaccineIdentity {
  antigenSlug?: string | null;
  customVaccineId?: string | null;
}

/** The resolved entry, in the shape a catalogue seed has. */
export interface ResolvedVaccineEntry {
  kind: "catalog" | "custom";
  /** The catalogue slug, or null for a definition. */
  slug: string | null;
  /** The definition's id, or null for a catalogue entry. */
  customVaccineId: string | null;
  /**
   * The definition's own name. Null for a catalogue entry, whose name
   * resolves through i18n (`vaccinations.catalog.<slug>`).
   */
  name: string | null;
  /** WHO ATC code; a definition has none. */
  atc: string | null;
  /** The antigens a dose counts into. */
  components: readonly AntigenSlug[];
  typicalSeriesDoses: number | null;
  boosterIntervalMonths: number | null;
  /** Picker grouping; a definition has none. */
  category: VaccineCategory | null;
  /** The citation for the numbers; a definition is the person's, not cited. */
  source: string | null;
  /** Generic search aliases; a definition has its name and nothing else. */
  synonyms: readonly string[];
}

const KNOWN_ANTIGENS: ReadonlySet<string> = new Set(ANTIGEN_SLUGS);

/** The listed antigens the catalogue knows, deduplicated, in stored order. */
export function knownAntigens(raw: readonly string[]): AntigenSlug[] {
  const seen = new Set<string>();
  const out: AntigenSlug[] = [];
  for (const value of raw) {
    if (!KNOWN_ANTIGENS.has(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value as AntigenSlug);
  }
  return out;
}

/**
 * Resolve a dose to its entry, catalogue first. Null when neither arm
 * resolves — the caller then falls back to the dose's `vaccineName`.
 */
export function resolveVaccineEntry(
  record: VaccineIdentity,
  customs?: CustomVaccineLookup,
): ResolvedVaccineEntry | null {
  const catalog = resolveCatalogEntry(record.antigenSlug);
  if (catalog) {
    return {
      kind: "catalog",
      slug: catalog.slug,
      customVaccineId: null,
      name: null,
      atc: catalog.atc,
      components: catalog.components,
      typicalSeriesDoses: catalog.typicalSeriesDoses,
      boosterIntervalMonths: catalog.boosterIntervalMonths,
      category: catalog.category,
      source: catalog.source,
      synonyms: catalog.synonyms ?? [],
    };
  }
  if (!record.customVaccineId || !customs) return null;
  const custom = customs.get(record.customVaccineId);
  if (!custom || custom.deletedAt) return null;
  return {
    kind: "custom",
    slug: null,
    customVaccineId: custom.id,
    name: custom.name,
    atc: null,
    components: knownAntigens(custom.components),
    typicalSeriesDoses: custom.typicalSeriesDoses,
    boosterIntervalMonths: custom.boosterIntervalMonths,
    category: null,
    source: null,
    synonyms: [],
  };
}

/**
 * The antigens a dose counts into. Empty for a free-text-only dose and for
 * one whose arms no longer resolve: a name string is not evidence about
 * which antigens were given, and guessing from one is how a booster reminder
 * would be cleared by a dose that never contained it.
 */
export function componentsForDose(
  record: VaccineIdentity,
  customs?: CustomVaccineLookup,
): readonly AntigenSlug[] {
  return resolveVaccineEntry(record, customs)?.components ?? [];
}

/** A lookup over the definitions a list of rows carries. */
export function customLookupOf(
  definitions: ReadonlyArray<CustomVaccineDefinition | null | undefined>,
): CustomVaccineLookup {
  const map = new Map<string, CustomVaccineDefinition>();
  for (const definition of definitions) {
    if (definition) map.set(definition.id, definition);
  }
  return map;
}

/** The columns a definition is resolved from. */
export const CUSTOM_VACCINE_RESOLVE_SELECT = {
  id: true,
  name: true,
  components: true,
  typicalSeriesDoses: true,
  boosterIntervalMonths: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CustomVaccineSelect;

/**
 * The record's live definitions, by id. An Impfpass names a handful at most,
 * so the whole set is read rather than the ids a page happens to need.
 */
export async function loadCustomVaccineLookup(
  client: Pick<Prisma.TransactionClient, "customVaccine">,
  userId: string,
): Promise<CustomVaccineLookup> {
  const rows = await client.customVaccine.findMany({
    where: { userId, deletedAt: null },
    select: CUSTOM_VACCINE_RESOLVE_SELECT,
  });
  return customLookupOf(rows);
}
