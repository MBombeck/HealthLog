/**
 * The procedure and surgery history: every visit filed as PROCEDURE that
 * happened, newest first, searchable by body site.
 *
 * The body site is ciphertext at rest (`Encounter.bodySiteEncrypted`), so the
 * search cannot run in SQL. It runs here, after the decrypt, over the account's
 * own procedures only. That set is a person's surgical history: tens of rows,
 * not thousands, and a decrypt pass per search costs less than a plaintext
 * search column would cost in exposure. The read is still bounded
 * (`MAX_PROCEDURES`), so an account that somehow holds more cannot turn one
 * search into an unbounded decrypt loop.
 *
 * Only DONE visits count. "What surgeries have you had" is asked about things
 * that happened: a booked operation sits in the visits list's upcoming half,
 * and a cancelled one or a no-show did not happen at all.
 *
 * The search and the facet grouping are pure functions, exported for the unit
 * test, and the route is a thin wrapper over `loadProcedureHistory`.
 */
import type { Laterality, Prisma } from "@/generated/prisma/client";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import type { ShareDomain } from "@/lib/sharing/scope";
import {
  toEncounterDTO,
  type BodySiteFacetDTO,
  type ProcedureListDTO,
} from "@/lib/encounters/dto";
import {
  ENCOUNTER_INCLUDE,
  loadEncounterLinksForMany,
} from "@/lib/encounters/service";
import type { ProcedureListQuery } from "@/lib/validations/encounters";

/** Upper bound on the procedures one read decrypts. */
export const MAX_PROCEDURES = 500;

/** What the search reads off one procedure, already decrypted. */
export interface ProcedureSearchItem {
  bodySite: string | null;
  laterality: Laterality | null;
  reason: string | null;
}

/** Lower-case, accents folded, whitespace collapsed. */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether one procedure matches the query.
 *
 * Every word of `q` has to appear somewhere in the site, the side or the
 * reason. The side is searchable through its words (`lateralityTerms`), so
 * "left knee" finds a procedure whose site says "Knee" and whose side is LEFT:
 * the person reads those as one phrase and should not have to know they are
 * stored apart. `laterality`, when given, is an exact filter on the field.
 */
export function matchesProcedureQuery(
  item: ProcedureSearchItem,
  query: ProcedureListQuery,
  lateralityTerms: (laterality: Laterality | null) => string[],
): boolean {
  if (query.laterality && item.laterality !== query.laterality) return false;
  const words = normalizeSearchText(query.q ?? "")
    .split(" ")
    .filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalizeSearchText(
    [item.bodySite, item.reason, ...lateralityTerms(item.laterality)]
      .filter(Boolean)
      .join(" "),
  );
  return words.every((word) => haystack.includes(word));
}

/**
 * One facet per body site and side, most frequent first.
 *
 * Keyed on the folded text, so "Left knee" and "left  knee" are one site; the
 * first spelling seen is the one shown. Procedures with no site contribute no
 * facet: there is nothing to filter them by.
 */
export function groupBodySites(
  items: readonly ProcedureSearchItem[],
): BodySiteFacetDTO[] {
  const facets = new Map<string, BodySiteFacetDTO>();
  for (const item of items) {
    const shown = item.bodySite?.replace(/\s+/g, " ").trim();
    if (!shown) continue;
    const key = `${normalizeSearchText(shown)}|${item.laterality ?? ""}`;
    const facet = facets.get(key);
    if (facet) facet.count += 1;
    else
      facets.set(key, {
        bodySite: shown,
        laterality: item.laterality,
        count: 1,
      });
  }
  // A stable sort, so equal counts keep the order they were first met in —
  // newest procedure first, because that is the order the rows arrive in.
  return [...facets.values()].sort((a, b) => b.count - a.count);
}

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/**
 * The words a side can be searched by: the English word, which the API and
 * the MCP tool speak, and the record owner's own word, which the person types.
 */
export function lateralityTermsFor(
  locale: string | null | undefined,
): (laterality: Laterality | null) => string[] {
  const { t } = getServerTranslator(resolveLocale(locale));
  const en = getServerTranslator("en").t;
  const key = (laterality: Laterality) => {
    switch (laterality) {
      case "LEFT":
        return "encounters.laterality.left";
      case "RIGHT":
        return "encounters.laterality.right";
      default:
        return "encounters.laterality.both";
    }
  };
  return (laterality) =>
    laterality ? [en(key(laterality)), t(key(laterality))] : [];
}

/**
 * Read, decrypt, facet and filter the account's procedure history.
 *
 * The facets and the total are computed before the filter; the list after it.
 * Links ride each row for the same reason they ride the visits list: the edit
 * sheet seeds its pickers from the row it was handed.
 */
export async function loadProcedureHistory(
  tx: Prisma.TransactionClient,
  userId: string,
  query: ProcedureListQuery,
  options: {
    locale: string | null;
    visible: (domain: ShareDomain) => boolean;
    now?: Date;
  },
): Promise<ProcedureListDTO> {
  const rows = await tx.encounter.findMany({
    where: {
      userId,
      deletedAt: null,
      kind: "PROCEDURE",
      status: "DONE",
      occurredAt: { lte: options.now ?? new Date() },
    },
    orderBy: { occurredAt: "desc" },
    take: MAX_PROCEDURES,
    include: ENCOUNTER_INCLUDE,
  });

  const decrypted = rows.map((row) => ({ row, dto: toEncounterDTO(row) }));
  const terms = lateralityTermsFor(options.locale);
  const matching = decrypted.filter(({ dto }) =>
    matchesProcedureQuery(dto, query, terms),
  );

  const links = await loadEncounterLinksForMany(
    tx,
    userId,
    matching.map(({ row }) => row.id),
    options.visible,
  );

  return {
    procedures: matching.map(({ row, dto }) => ({
      ...dto,
      links: links.get(row.id),
    })),
    bodySites: groupBodySites(decrypted.map(({ dto }) => dto)),
    total: decrypted.length,
  };
}
