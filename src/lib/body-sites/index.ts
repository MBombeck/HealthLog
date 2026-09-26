/**
 * The body-site view: every procedure and condition filed at one site, and what
 * is linked to them (v1.39.2, Discussion #1025).
 *
 * A body site lives on two records, `Encounter.bodySiteEncrypted` (a procedure,
 * or any visit that carries one) and `IllnessEpisode.bodySiteEncrypted` (a
 * condition). Both are ciphertext at rest, so grouping and matching cannot run
 * in SQL. They run here, after the decrypt, over the record's own rows only and
 * bounded per kind (`MAX_ROWS_PER_KIND`): a person's procedures and conditions
 * with a site are tens of rows, and the bound keeps an unusual account from
 * turning one read into an unbounded decrypt loop. The same reasoning is
 * written at the two columns and in `src/lib/encounters/procedures.ts`, whose
 * folding this module reuses so both views agree on what "the same site" is.
 *
 * Sharing. The route sits in the `profile` section, like the visits it reads.
 * Conditions are the `illness` section: a grant without it gets no condition
 * row, no condition site among the choices and no condition count, and a
 * procedure's link to a condition comes back as a placeholder with no label.
 * The same per-family rule covers a procedure's documents and lab results and
 * a condition's documents (`loadEncounterLinksForMany` for the visit side, the
 * same predicate for the condition side). A link is never dropped, so a
 * delegate can see that something is filed without being told what.
 *
 * The pure pieces (folding, grouping, matching) are exported for the unit test.
 */
import type { Laterality, Prisma } from "@/generated/prisma/client";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { getEvent } from "@/lib/logging/context";
import { listTargetsBySource } from "@/lib/links";
import type { ShareDomain } from "@/lib/sharing/scope";
import { toEncounterDTO, type EncounterLinkDTO } from "@/lib/encounters/dto";
import {
  ENCOUNTER_INCLUDE,
  loadEncounterLinksForMany,
} from "@/lib/encounters/service";
import { normalizeSearchText } from "@/lib/encounters/procedures";
import type { BodySiteQuery } from "@/lib/validations/body-sites";
import type {
  BodySiteConditionDTO,
  BodySiteDTO,
  BodySiteListDTO,
} from "@/lib/body-sites/dto";

/** Upper bound on the rows one read decrypts, per kind. */
export const MAX_ROWS_PER_KIND = 500;

/** What grouping and matching read off one record, already decrypted. */
export interface SiteItem {
  kind: "procedure" | "condition";
  bodySite: string | null;
  laterality: Laterality | null;
}

/** The display form of a site: whitespace collapsed, trimmed, null when empty. */
function shownSite(value: string | null): string | null {
  const shown = value?.replace(/\s+/g, " ").trim();
  return shown ? shown : null;
}

/**
 * One entry per site, across both kinds, most records first.
 *
 * Keyed on the folded text so "Left knee" and "left  knee" are one site; the
 * first spelling met is the one shown, and the rows arrive newest first. The
 * side is a breakdown inside the site rather than part of its key: the view
 * asks "what is at the knee" first and "which knee" second, and a condition on
 * the left knee and a procedure on the right one are still the same site.
 */
export function groupSites(items: readonly SiteItem[]): BodySiteDTO[] {
  const sites = new Map<string, BodySiteDTO>();
  for (const item of items) {
    const shown = shownSite(item.bodySite);
    if (!shown) continue;
    const key = normalizeSearchText(shown);
    let site = sites.get(key);
    if (!site) {
      site = { bodySite: shown, procedures: 0, conditions: 0, sides: [] };
      sites.set(key, site);
    }
    if (item.kind === "procedure") site.procedures += 1;
    else site.conditions += 1;
    const side = site.sides.find((s) => s.laterality === item.laterality);
    if (side) side.count += 1;
    else site.sides.push({ laterality: item.laterality, count: 1 });
  }
  const order: Array<Laterality | null> = ["LEFT", "RIGHT", "BOTH", null];
  for (const site of sites.values()) {
    site.sides.sort(
      (a, b) => order.indexOf(a.laterality) - order.indexOf(b.laterality),
    );
  }
  // A stable sort: equal totals keep the order they were first met in.
  return [...sites.values()].sort(
    (a, b) => b.procedures + b.conditions - (a.procedures + a.conditions),
  );
}

/**
 * Whether one record sits at the picked site and side.
 *
 * The site compares whole, after folding: the choice came from the list above,
 * so "knee" must not also pick "kneecap". A picked LEFT or RIGHT includes a
 * record on BOTH sides, because a condition in both knees is in the left knee
 * too. A record whose side was never stated is left out once a side is picked:
 * it may be either, and showing it under both would claim what nobody wrote.
 */
export function matchesSite(
  item: Pick<SiteItem, "bodySite" | "laterality">,
  site: string,
  laterality: Laterality | undefined,
): boolean {
  const shown = shownSite(item.bodySite);
  if (!shown) return false;
  if (normalizeSearchText(shown) !== normalizeSearchText(site)) return false;
  if (!laterality) return true;
  if (item.laterality === laterality) return true;
  return laterality !== "BOTH" && item.laterality === "BOTH";
}

/** Decrypt a condition's site fail-soft, like the illness DTO does. */
function decryptSite(value: Uint8Array | null): string | null {
  if (!value || value.byteLength === 0) return null;
  try {
    return decryptFromBytes(value);
  } catch (err) {
    getEvent()?.addWarning(
      `illness body site decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/** Withhold a link's label and date when the caller may not read its section. */
function redactFamily(
  rows: { id: string; label: string; date: string | null }[],
  open: boolean,
): EncounterLinkDTO[] {
  if (open) return rows.map((row) => ({ ...row, redacted: false }));
  return rows.map((row) => ({
    id: row.id,
    label: null,
    date: null,
    redacted: true,
  }));
}

/**
 * Read, decrypt, group and (when a site is named) select.
 *
 * `conditionsReadable` is the caller's grant AND the record's illness module:
 * when it is false the condition table is not read at all, so nothing about a
 * condition can reach the answer by accident.
 */
export async function loadBodySites(
  tx: Prisma.TransactionClient,
  userId: string,
  query: BodySiteQuery,
  options: {
    visible: (domain: ShareDomain) => boolean;
    conditionsReadable: boolean;
  },
): Promise<BodySiteListDTO> {
  const [encounterRows, conditionRows] = await Promise.all([
    tx.encounter.findMany({
      where: { userId, deletedAt: null, bodySiteEncrypted: { not: null } },
      orderBy: { occurredAt: "desc" },
      take: MAX_ROWS_PER_KIND,
      include: ENCOUNTER_INCLUDE,
    }),
    options.conditionsReadable
      ? tx.illnessEpisode.findMany({
          where: { userId, deletedAt: null, bodySiteEncrypted: { not: null } },
          orderBy: { onsetAt: "desc" },
          take: MAX_ROWS_PER_KIND,
        })
      : Promise.resolve([]),
  ]);

  const visits = encounterRows.map((row) => toEncounterDTO(row));
  const conditions = conditionRows.map((row) => ({
    row,
    bodySite: decryptSite(row.bodySiteEncrypted),
  }));

  const sites = groupSites([
    ...visits.map((dto) => ({
      kind: "procedure" as const,
      bodySite: dto.bodySite,
      laterality: dto.laterality,
    })),
    ...conditions.map(({ row, bodySite }) => ({
      kind: "condition" as const,
      bodySite,
      laterality: row.laterality,
    })),
  ]);

  if (!query.site) return { sites };
  const site = query.site;
  const side = query.laterality;

  const pickedVisits = visits.filter((dto) => matchesSite(dto, site, side));
  const pickedConditions = conditions.filter(({ row, bodySite }) =>
    matchesSite({ bodySite, laterality: row.laterality }, site, side),
  );

  const visitLinks = await loadEncounterLinksForMany(
    tx,
    userId,
    pickedVisits.map((dto) => dto.id),
    options.visible,
  );

  let conditionDTOs: BodySiteConditionDTO[] | null = null;
  if (options.conditionsReadable) {
    const ids = pickedConditions.map(({ row }) => row.id);
    const [documents, encounters] = await Promise.all([
      listTargetsBySource(tx, {
        userId,
        sourceKind: "conditionEpisode",
        sourceIds: ids,
        targetKind: "document",
      }),
      listTargetsBySource(tx, {
        userId,
        sourceKind: "conditionEpisode",
        sourceIds: ids,
        targetKind: "encounter",
      }),
    ]);
    conditionDTOs = pickedConditions.map(({ row, bodySite }) => ({
      id: row.id,
      label: row.label,
      type: row.type,
      lifecycle: row.lifecycle,
      onsetAt: row.onsetAt.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      bodySite,
      laterality: row.laterality,
      links: {
        documents: redactFamily(
          documents.get(row.id) ?? [],
          options.visible("documents"),
        ),
        visits: redactFamily(
          encounters.get(row.id) ?? [],
          options.visible("profile"),
        ),
      },
    }));
  }

  // The site as the list shows it, so a request typed in another case still
  // gets the record's own spelling back.
  const shown =
    sites.find(
      (entry) =>
        normalizeSearchText(entry.bodySite) === normalizeSearchText(site),
    )?.bodySite ?? site;

  return {
    sites,
    selection: {
      bodySite: shown,
      laterality: side ?? null,
      visits: pickedVisits.map((dto) => ({
        ...dto,
        links: visitLinks.get(dto.id),
      })),
      conditions: conditionDTOs,
    },
  };
}
