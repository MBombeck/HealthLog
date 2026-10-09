import { createHash } from "node:crypto";

import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";

export const PATTERN_FAMILIES = {
  discoveryRetrospective: "DISCOVERY_RETROSPECTIVE",
  discoveryRecent: "DISCOVERY_RECENT",
  fixed: "FIXED",
  moodTagCrosstab: "MOOD_TAG_CROSSTAB",
  moodFactorCrosstab: "MOOD_FACTOR_CROSSTAB",
} as const;

export type PatternFamily =
  (typeof PATTERN_FAMILIES)[keyof typeof PATTERN_FAMILIES];

export interface AcceptedPatternEvidence {
  factorKey: string;
  outcomeKey: string;
  lagDays: number;
  sampleSize: number;
  effectSize: number;
  pValue: number;
  qValue?: number | null;
}

export interface PatternDecision {
  patternId: string;
  canonicalKey: string;
  dismissed: boolean;
}

/** Stable identity derived only from the user-independent pair definition. */
export function canonicalPatternKey(
  factorKey: string,
  outcomeKey: string,
  lagDays: number,
): string {
  const source = JSON.stringify([factorKey, outcomeKey, lagDays]);
  return `p1:${createHash("sha256").update(source).digest("hex")}`;
}

function evidenceHash(evidence: AcceptedPatternEvidence): string {
  const source = JSON.stringify({
    factorKey: evidence.factorKey,
    outcomeKey: evidence.outcomeKey,
    lagDays: evidence.lagDays,
    sampleSize: evidence.sampleSize,
    effectSize: evidence.effectSize,
    pValue: evidence.pValue,
    qValue: evidence.qValue ?? null,
  });
  return createHash("sha256").update(source).digest("hex");
}

/**
 * A dismissal survives normal sampling noise. It is released only when the
 * effect reverses direction, moves by at least 0.10, or the accepted sample
 * grows by at least 25% (with a ten-observation floor).
 */
export function isMaterialEvidenceChange(args: {
  currentEffectSize: number;
  currentSampleSize: number;
  dismissedEffectSize: number;
  dismissedSampleSize: number;
}): boolean {
  const signChanged =
    Math.sign(args.currentEffectSize) !== Math.sign(args.dismissedEffectSize);
  const effectMoved =
    Math.abs(args.currentEffectSize - args.dismissedEffectSize) >= 0.1;
  const sampleGrowth = Math.max(10, Math.ceil(args.dismissedSampleSize * 0.25));
  const sampleDeepened =
    args.currentSampleSize >= args.dismissedSampleSize + sampleGrowth;
  return signChanged || effectMoved || sampleDeepened;
}

/**
 * Whether this run releases a dismissal.
 *
 * Two things have to hold. The evidence must have MOVED since the dismissal,
 * which is what `dismissedEvidenceHash` records — the only part of the
 * snapshot that covers the whole evidence tuple rather than two of its
 * numbers — and the move must be material by the thresholds above, so an
 * ordinary sampling wobble does not undo a dismissal the user made on
 * purpose.
 *
 * The hash also answers the case the two scalars cannot. A snapshot that
 * carries a hash but no effect size and no sample size — a restore from a
 * partial backup — used to be frozen dismissed forever, because the gate had
 * no number to compare and fell through to `false` on every future run. A
 * hash that no longer matches is still proof the evidence moved, so it
 * releases the dismissal rather than holding it against a snapshot nobody
 * can evaluate.
 */
export function shouldReleaseDismissal(args: {
  dismissedAt: Date | null;
  dismissedEvidenceHash: string | null;
  dismissedEffectSize: number | null;
  dismissedSampleSize: number | null;
  currentEvidenceHash: string;
  currentEffectSize: number;
  currentSampleSize: number;
}): boolean {
  if (args.dismissedAt == null) return false;

  // Byte-identical to what was dismissed: nothing has changed, so there is
  // nothing to reconsider and no threshold worth evaluating.
  if (args.dismissedEvidenceHash === args.currentEvidenceHash) return false;

  if (args.dismissedEffectSize != null && args.dismissedSampleSize != null) {
    return isMaterialEvidenceChange({
      currentEffectSize: args.currentEffectSize,
      currentSampleSize: args.currentSampleSize,
      dismissedEffectSize: args.dismissedEffectSize,
      dismissedSampleSize: args.dismissedSampleSize,
    });
  }

  return args.dismissedEvidenceHash != null;
}

/**
 * Persist one accepted family run, retire findings no longer accepted, and
 * return the server's presentation decision for every accepted finding.
 */
export async function syncAcceptedPatterns(args: {
  userId: string;
  family: PatternFamily;
  accepted: AcceptedPatternEvidence[];
  computedAt?: Date;
}): Promise<Map<string, PatternDecision>> {
  const computedAt = args.computedAt ?? new Date();
  const prepared = args.accepted.map((evidence) => ({
    evidence,
    canonicalKey: canonicalPatternKey(
      evidence.factorKey,
      evidence.outcomeKey,
      evidence.lagDays,
    ),
    evidenceHash: evidenceHash(evidence),
  }));
  const keys = prepared.map((item) => item.canonicalKey);

  // The earlier-engine cutoff has to exist before the new engine writes its
  // first discovery pattern, or that pattern would count as an earlier one.
  if (DISCOVERY_FAMILIES.includes(args.family)) {
    await stampSeasonalEngineStart();
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.correlationPattern.findMany({
      where: { userId: args.userId, canonicalKey: { in: keys } },
    });
    const existingByKey = new Map(
      existing.map((row) => [row.canonicalKey, row]),
    );

    if (keys.length === 0) {
      await tx.correlationPattern.updateMany({
        where: { userId: args.userId, family: args.family, isCurrent: true },
        data: { isCurrent: false },
      });
    } else {
      await tx.correlationPattern.updateMany({
        where: {
          userId: args.userId,
          family: args.family,
          isCurrent: true,
          canonicalKey: { notIn: keys },
        },
        data: { isCurrent: false },
      });
    }

    const decisions = new Map<string, PatternDecision>();
    for (const item of prepared) {
      const prior = existingByKey.get(item.canonicalKey);
      const shouldResurface = shouldReleaseDismissal({
        dismissedAt: prior?.dismissedAt ?? null,
        dismissedEvidenceHash: prior?.dismissedEvidenceHash ?? null,
        dismissedEffectSize: prior?.dismissedEffectSize ?? null,
        dismissedSampleSize: prior?.dismissedSampleSize ?? null,
        currentEvidenceHash: item.evidenceHash,
        currentEffectSize: item.evidence.effectSize,
        currentSampleSize: item.evidence.sampleSize,
      });

      const row = await tx.correlationPattern.upsert({
        where: {
          userId_canonicalKey: {
            userId: args.userId,
            canonicalKey: item.canonicalKey,
          },
        },
        create: {
          userId: args.userId,
          canonicalKey: item.canonicalKey,
          family: args.family,
          factorKey: item.evidence.factorKey,
          outcomeKey: item.evidence.outcomeKey,
          lagDays: item.evidence.lagDays,
          sampleSize: item.evidence.sampleSize,
          effectSize: item.evidence.effectSize,
          pValue: item.evidence.pValue,
          qValue: item.evidence.qValue ?? null,
          evidenceHash: item.evidenceHash,
          isCurrent: true,
          lastComputedAt: computedAt,
        },
        update: {
          family: args.family,
          factorKey: item.evidence.factorKey,
          outcomeKey: item.evidence.outcomeKey,
          lagDays: item.evidence.lagDays,
          sampleSize: item.evidence.sampleSize,
          effectSize: item.evidence.effectSize,
          pValue: item.evidence.pValue,
          qValue: item.evidence.qValue ?? null,
          evidenceHash: item.evidenceHash,
          isCurrent: true,
          lastComputedAt: computedAt,
          ...(shouldResurface
            ? {
                dismissedAt: null,
                dismissedEvidenceHash: null,
                dismissedEffectSize: null,
                dismissedSampleSize: null,
              }
            : {}),
        },
      });

      decisions.set(item.canonicalKey, {
        patternId: row.id,
        canonicalKey: row.canonicalKey,
        dismissed: row.dismissedAt != null,
      });
    }
    return decisions;
  });
}

export function decisionForEvidence(
  decisions: Map<string, PatternDecision>,
  evidence: Pick<
    AcceptedPatternEvidence,
    "factorKey" | "outcomeKey" | "lagDays"
  >,
): PatternDecision | null {
  return (
    decisions.get(
      canonicalPatternKey(
        evidence.factorKey,
        evidence.outcomeKey,
        evidence.lagDays,
      ),
    ) ?? null
  );
}

/**
 * The discovery engine correlates seasonally adjusted residuals with an
 * effective-sample-size p-value since v1.42. Before it, two series that
 * merely shared the season or a long trend surfaced as a finding, so an
 * account with history usually sees fewer pairs afterwards.
 *
 * Where that change took effect is an instance fact, not a calendar date: an
 * instance keeps writing earlier-engine findings until it runs the new build.
 * The first discovery sync of the new engine stamps
 * `AppSettings.correlationSeasonalEngineSince`, before it writes anything, and
 * the cutoff below reads that stamp. Stamped once per instance; the process
 * remembers it so later syncs skip the write.
 */
const DISCOVERY_FAMILIES: readonly PatternFamily[] = [
  PATTERN_FAMILIES.discoveryRetrospective,
  PATTERN_FAMILIES.discoveryRecent,
];

let seasonalEngineStamped = false;

/**
 * Record that the seasonally adjusted engine is running here, unless already
 * recorded. Best effort: a failed stamp leaves the marker unset, which counts
 * every pattern as an earlier finding (the note shows once more than it
 * should), never the reverse.
 */
export async function stampSeasonalEngineStart(
  now: Date = new Date(),
): Promise<void> {
  if (seasonalEngineStamped) return;
  try {
    await prisma.appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", correlationSeasonalEngineSince: now },
      update: {},
    });
    await prisma.appSettings.updateMany({
      where: { id: "singleton", correlationSeasonalEngineSince: null },
      data: { correlationSeasonalEngineSince: now },
    });
    seasonalEngineStamped = true;
  } catch {
    getEvent()?.addWarning("correlation seasonal engine stamp failed");
  }
}

/** Test seam: forget that this process already stamped the marker. */
export function resetSeasonalEngineStampForTests(): void {
  seasonalEngineStamped = false;
}

/**
 * Whether the record held a discovery finding under the earlier engine: a
 * stored discovery pattern created before the instance's seasonal-engine
 * stamp, or any stored discovery pattern while there is no stamp yet. A
 * dismissed pattern counts, it was a finding. An account whose first finding
 * came from the new engine never qualifies, so the one-time explanation on
 * the correlation surface reaches only the people whose list actually
 * changed.
 */
export async function hadFindingsBeforeSeasonalAdjustment(
  userId: string,
): Promise<boolean> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { correlationSeasonalEngineSince: true },
  });
  const since = settings?.correlationSeasonalEngineSince ?? null;
  const row = await prisma.correlationPattern.findFirst({
    where: {
      userId,
      family: { in: [...DISCOVERY_FAMILIES] },
      ...(since ? { createdAt: { lt: since } } : {}),
    },
    select: { id: true },
  });
  return row !== null;
}
