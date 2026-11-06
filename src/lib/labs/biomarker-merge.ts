/**
 * Merge markers into one (D1223): "Alk.P" and "Alkaline Phosphatase" become
 * one marker with one history.
 *
 * The plan and the write are one function, so a dry run answers exactly what
 * the merge would do: it reads the same rows, converts the same values and
 * returns the same numbers, and only the write step is skipped.
 *
 * What a merge does, in one transaction:
 *   - every reading of every source moves to the target. A reading in a unit
 *     other than the target's is converted with the target's analyte
 *     (`convertLabValue`), together with the windows stamped on it; the value
 *     and unit the report printed stay in `sourceValue` / `sourceUnit` (a
 *     reading that was already converted keeps its original pair). The
 *     reading's own `analyte` stays the name that was printed.
 *   - a pair of units the registry cannot convert refuses the WHOLE merge;
 *     nothing moves, not even the sources that would convert;
 *   - medication efficacy targets follow their marker;
 *   - each source's name and its aliases become aliases of the target
 *     (`MERGE`), unless the target's name or another marker already answers
 *     to that spelling;
 *   - one `biomarker_merges` row per source, and the rows that already pointed
 *     at a source now point at the target, so an id merged twice still finds
 *     where it went;
 *   - a target without a panel takes the first panel a source carries, in
 *     the order the sources were given (the dry run reports it too);
 *   - the sources are deleted.
 *
 * There is no undo. The ledger keeps what a later split would need to know
 * (which marker, which name, how many readings).
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { foldForMatch } from "@/lib/i18n/fold-for-match";

import { matchAnalyteKey } from "./analyte-match";
import {
  BIOMARKER_ALIAS_MAX_LENGTH,
  aliasNamesByMarker,
} from "./biomarker-aliases";
import { serialiseBiomarker, type BiomarkerDto } from "./biomarker-dto";
import {
  convertLabRange,
  convertLabValue,
  type ConversionRefusal,
} from "./unit-conversion/convert";
import { sameLabUnit } from "./unit-normalise";

export type MergeConversion = "none" | "converted" | "refused";

export interface MergeSourceSummary {
  id: string;
  name: string;
  unit: string;
  readingCount: number;
  conversion: MergeConversion;
  refusal: ConversionRefusal | null;
}

export interface BiomarkerMergeResult {
  dryRun: boolean;
  target: BiomarkerDto;
  sources: MergeSourceSummary[];
  movedReadings: number;
  convertedReadings: number;
  aliasesAdded: string[];
  /** The panel the target takes over from a source, or null (dry run too). */
  adoptedPanel: string | null;
  mergeId: string | null;
}

export type BiomarkerMergeOutcome =
  | { kind: "ok"; result: BiomarkerMergeResult }
  | { kind: "notFound"; ids: string[] }
  | {
      kind: "unitMismatch";
      sources: Array<{
        id: string;
        unit: string;
        targetUnit: string;
        reason: ConversionRefusal;
      }>;
    };

interface ReadingUpdate {
  id: string;
  value: number;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  sourceReferenceLow: number | null;
  sourceReferenceHigh: number | null;
  sourceValue: number;
  sourceUnit: string;
}

/** Thrown inside the transaction to roll it back with the refusal. */
class MergeRefused extends Error {
  constructor(readonly outcome: BiomarkerMergeOutcome) {
    super("merge refused");
  }
}

export async function mergeBiomarkers(input: {
  userId: string;
  targetId: string;
  sourceIds: readonly string[];
  dryRun: boolean;
}): Promise<BiomarkerMergeOutcome> {
  try {
    return await prisma.$transaction(
      (tx) => runMerge(tx, input),
      // A source with a long history updates row by row where it converts.
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (err) {
    if (err instanceof MergeRefused) return err.outcome;
    throw err;
  }
}

async function runMerge(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    targetId: string;
    sourceIds: readonly string[];
    dryRun: boolean;
  },
): Promise<BiomarkerMergeOutcome> {
  const { userId, targetId, sourceIds, dryRun } = input;

  const markers = await tx.biomarker.findMany({
    where: { userId, id: { in: [targetId, ...sourceIds] } },
  });
  const byId = new Map(markers.map((m) => [m.id, m]));
  const missing = [targetId, ...sourceIds].filter((id) => !byId.has(id));
  if (missing.length > 0) return { kind: "notFound", ids: missing };
  const target = byId.get(targetId)!;
  const sources = sourceIds.map((id) => byId.get(id)!);

  // The target's analyte, derived the way every write path derives it, so a
  // stale stored key cannot pick the wrong factor.
  const analyteKey = matchAnalyteKey({ name: target.name, unit: target.unit });

  const readings = await tx.labResult.findMany({
    where: { userId, biomarkerId: { in: [...sourceIds] } },
    select: {
      id: true,
      biomarkerId: true,
      value: true,
      unit: true,
      referenceLow: true,
      referenceHigh: true,
      sourceReferenceLow: true,
      sourceReferenceHigh: true,
      sourceValue: true,
      sourceUnit: true,
      deletedAt: true,
    },
  });

  const summaries: MergeSourceSummary[] = [];
  const updates: ReadingUpdate[] = [];
  let movedReadings = 0;
  // Counted like `readingCount`: the live readings a person sees. A tombstoned
  // reading moves and converts with them, so an undo brings it back right.
  let convertedLive = 0;
  for (const source of sources) {
    const own = readings.filter((r) => r.biomarkerId === source.id);
    let converted = 0;
    let refusal: ConversionRefusal | null = null;
    for (const reading of own) {
      // A qualitative reading, or one already in the target's unit, moves as
      // it is.
      if (reading.value === null || sameLabUnit(reading.unit, target.unit)) {
        continue;
      }
      const value = convertLabValue({
        analyteKey,
        value: reading.value,
        from: reading.unit,
        to: target.unit,
      });
      const stamped = convertLabRange({
        analyteKey,
        low: reading.referenceLow,
        high: reading.referenceHigh,
        from: reading.unit,
        to: target.unit,
      });
      const printed = convertLabRange({
        analyteKey,
        low: reading.sourceReferenceLow,
        high: reading.sourceReferenceHigh,
        from: reading.unit,
        to: target.unit,
      });
      if (!value.ok || !stamped.ok || !printed.ok) {
        refusal ??= !value.ok
          ? value.reason
          : !stamped.ok
            ? stamped.reason
            : !printed.ok
              ? printed.reason
              : "unknown_unit";
        continue;
      }
      converted += 1;
      if (reading.deletedAt === null) convertedLive += 1;
      updates.push({
        id: reading.id,
        value: value.value,
        unit: target.unit,
        referenceLow: stamped.low,
        referenceHigh: stamped.high,
        sourceReferenceLow: printed.low,
        sourceReferenceHigh: printed.high,
        // A reading converted on its way in keeps what the report printed.
        sourceValue: reading.sourceValue ?? reading.value,
        sourceUnit: reading.sourceUnit ?? reading.unit.trim(),
      });
    }
    const live = own.filter((r) => r.deletedAt === null).length;
    movedReadings += live;
    summaries.push({
      id: source.id,
      name: source.name,
      unit: source.unit,
      readingCount: live,
      conversion: refusal ? "refused" : converted > 0 ? "converted" : "none",
      refusal,
    });
  }
  const convertedReadings = convertedLive;

  const { sourceAliases, added } = await planMergeAliases(tx, {
    userId,
    target,
    sources,
  });
  const aliasesAdded = [...added.values()];
  // A target without a panel takes the first one a source carries, in the
  // order the sources were given, so the merged marker keeps its category.
  const adoptedPanel =
    target.panel === null
      ? (sources.find((source) => source.panel !== null)?.panel ?? null)
      : null;

  const refused = summaries.filter((s) => s.conversion === "refused");
  if (!dryRun && refused.length > 0) {
    throw new MergeRefused({
      kind: "unitMismatch",
      sources: refused.map((s) => ({
        id: s.id,
        unit: s.unit,
        targetUnit: target.unit,
        reason: s.refusal ?? "unknown_unit",
      })),
    });
  }

  let mergeId: string | null = null;
  if (!dryRun) {
    for (const update of updates) {
      await tx.labResult.update({
        where: { id: update.id },
        data: {
          biomarkerId: targetId,
          value: update.value,
          unit: update.unit,
          referenceLow: update.referenceLow,
          referenceHigh: update.referenceHigh,
          sourceReferenceLow: update.sourceReferenceLow,
          sourceReferenceHigh: update.sourceReferenceHigh,
          sourceValue: update.sourceValue,
          sourceUnit: update.sourceUnit,
        },
      });
    }
    await tx.labResult.updateMany({
      where: { userId, biomarkerId: { in: [...sourceIds] } },
      data: { biomarkerId: targetId },
    });
    await tx.medicationEfficacyTarget.updateMany({
      where: { biomarkerId: { in: [...sourceIds] } },
      data: { biomarkerId: targetId },
    });
    // The sources' own alias rows go with the sources; the spellings that
    // survive are written again on the target below.
    await tx.biomarkerAlias.deleteMany({
      where: { userId, id: { in: sourceAliases.map((a) => a.id) } },
    });
    if (added.size > 0) {
      await tx.biomarkerAlias.createMany({
        data: [...added].map(([nameFolded, name]) => ({
          userId,
          biomarkerId: targetId,
          name,
          nameFolded,
          source: "MERGE",
        })),
      });
    }
    await tx.biomarkerMerge.updateMany({
      where: { userId, targetBiomarkerId: { in: [...sourceIds] } },
      data: { targetBiomarkerId: targetId },
    });
    const now = new Date();
    for (const summary of summaries) {
      const row = await tx.biomarkerMerge.create({
        data: {
          userId,
          targetBiomarkerId: targetId,
          sourceBiomarkerId: summary.id,
          sourceName: summary.name.slice(0, BIOMARKER_ALIAS_MAX_LENGTH),
          readingCount: summary.readingCount,
          mergedAt: now,
        },
        select: { id: true },
      });
      mergeId ??= row.id;
    }
    if (adoptedPanel !== null) {
      await tx.biomarker.update({
        where: { id: targetId },
        data: { panel: adoptedPanel },
      });
    }
    await tx.biomarker.deleteMany({
      where: { userId, id: { in: [...sourceIds] } },
    });
  }

  const after = dryRun
    ? target
    : await tx.biomarker.findUniqueOrThrow({ where: { id: targetId } });
  const aliases = await aliasNamesByMarker(tx, userId, [after]);

  return {
    kind: "ok",
    result: {
      dryRun,
      target: serialiseBiomarker(after, aliases.get(after.id) ?? []),
      sources: summaries,
      movedReadings,
      convertedReadings,
      aliasesAdded,
      adoptedPanel,
      mergeId,
    },
  };
}

/**
 * The spellings the target gains: each source's name and its aliases, once
 * each, except what the target's name already is or another marker (not a
 * source) already answers to.
 */
async function planMergeAliases(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    target: { id: string; name: string };
    sources: ReadonlyArray<{ id: string; name: string }>;
  },
): Promise<{
  sourceAliases: Array<{ id: string; name: string; nameFolded: string }>;
  added: Map<string, string>;
}> {
  const { userId, target, sources } = input;
  const targetId = target.id;
  const sourceIds = sources.map((source) => source.id);
  const sourceAliases = await tx.biomarkerAlias.findMany({
    where: { userId, biomarkerId: { in: [...sourceIds] } },
    select: { id: true, name: true, nameFolded: true },
  });
  const otherAliases = await tx.biomarkerAlias.findMany({
    where: { userId, biomarkerId: { notIn: [...sourceIds] } },
    select: { biomarkerId: true, nameFolded: true },
  });
  const blocked = new Set(
    otherAliases
      .filter((a) => a.biomarkerId !== targetId)
      .map((a) => a.nameFolded),
  );
  const targetAliasFolds = new Set(
    otherAliases
      .filter((a) => a.biomarkerId === targetId)
      .map((a) => a.nameFolded),
  );
  const otherMarkerFolds = new Set(
    (
      await tx.biomarker.findMany({
        where: { userId, id: { notIn: [targetId, ...sourceIds] } },
        select: { name: true },
      })
    ).map((m) => foldForMatch(m.name)),
  );
  const targetFold = foldForMatch(target.name);
  const added = new Map<string, string>();
  const consider = (name: string) => {
    const folded = foldForMatch(name).slice(0, BIOMARKER_ALIAS_MAX_LENGTH);
    if (!folded || folded === targetFold) return;
    if (targetAliasFolds.has(folded) || added.has(folded)) return;
    if (blocked.has(folded) || otherMarkerFolds.has(folded)) return;
    added.set(folded, name.trim().slice(0, BIOMARKER_ALIAS_MAX_LENGTH));
  };
  for (const source of sources) consider(source.name);
  for (const alias of sourceAliases) consider(alias.name);

  return { sourceAliases, added };
}

/**
 * Where a merged marker went: the target of the newest merge that removed
 * `id`, or null. Chains resolve because a merge re-points the rows that named
 * its sources.
 */
export async function mergedInto(
  userId: string,
  id: string,
): Promise<string | null> {
  const row = await prisma.biomarkerMerge.findFirst({
    where: { userId, sourceBiomarkerId: id },
    orderBy: { mergedAt: "desc" },
    select: { targetBiomarkerId: true },
  });
  return row?.targetBiomarkerId ?? null;
}
