import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
} from "@/lib/insights/derived/coverage";
import type {
  Derived,
  DerivedCoverage,
  DerivedProvenance,
  DerivedProvenanceSource,
} from "@/lib/insights/derived/types";

import type { PillarValue, ScoreBand, ScorePillarId } from "./types";
import { READING_SPREAD, standardDeviation } from "@/lib/stats/spread";

export const DAY_MS = 86_400_000;

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Green from here up. Yellow from {@link SCORE_YELLOW_FLOOR} up. */
export const SCORE_GREEN_FLOOR = 70;

/** Below this is red. */
const SCORE_YELLOW_FLOOR = 50;

/**
 * The band a 0-100 score falls in, from the number alone.
 *
 * v1.35.1 — green starts at 70, not 75. The app carries three scores and
 * had two conventions: Readiness and the sleep score both call 70 green
 * (`bandForScore` in `src/lib/insights/derived/readiness.ts` and
 * `src/lib/insights/derived/sleep-score.ts`), and the Health Score alone
 * sat at 75. One app cannot mean two things by a green dot, so the
 * outlier moved. The yellow floor stays at 50 deliberately: raising the
 * bar for a reward and lowering the bar for a warning are different
 * decisions, and only the first one was asked for.
 *
 * This is a METHOD change, so `SCORE_VERSION` moved with it. Stored days
 * keep the band they were actually shown under, and the notice key
 * carries the version, so each account is told once that the method
 * moved.
 *
 * NOT the whole band rule. `computeComposite` takes the worse of this
 * band and the worst counted pillar's band, so a composite carrying a red
 * pillar stays red however high the mean sits. That rule is untouched;
 * only the mean-side thresholds moved.
 */
export function scoreBand(score: number): ScoreBand {
  if (score >= SCORE_GREEN_FLOOR) return "green";
  if (score >= SCORE_YELLOW_FLOOR) return "yellow";
  return "red";
}

/**
 * Score proximity to an inclusive published band without minting another
 * clinical threshold. Values inside score 100; outside, the ratio to the
 * nearest published edge declines smoothly and remains bounded.
 */
export function scoreReferenceBand(
  value: number,
  low: number | null,
  high: number | null,
): number {
  if (!Number.isFinite(value)) return 0;
  if (low != null && value < low) {
    return low > 0 ? clampScore((value / low) * 100) : 0;
  }
  if (high != null && value > high) {
    return value > 0 ? clampScore((high / value) * 100) : 0;
  }
  return 100;
}

export function readingSpread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  return standardDeviation(values, READING_SPREAD) ?? 0;
}

export function uniqueSources(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function daysBetween(oldest: Date | null, latest: Date | null): number {
  if (!oldest || !latest) return 0;
  return Math.max(
    1,
    Math.floor((latest.getTime() - oldest.getTime()) / DAY_MS) + 1,
  );
}

export function withinWindow(
  at: Date,
  asOf: Date,
  windowDays: number,
): boolean {
  const time = at.getTime();
  return time <= asOf.getTime() && time >= asOf.getTime() - windowDays * DAY_MS;
}

export function provenance(args: {
  inputs: string[];
  source: DerivedProvenanceSource;
  windowDays: number;
  asOf: Date;
}): DerivedProvenance {
  return {
    inputs: args.inputs,
    source: args.source,
    windowDays: args.windowDays,
    computedAt: args.asOf.toISOString(),
  };
}

export function insufficientPillar(args: {
  id: ScorePillarId;
  source: DerivedProvenanceSource;
  asOf: Date;
  windowDays: number;
  requiredInputs: number;
  presentInputs: number;
  historyDays: number;
  missing: string[];
  reason: string;
}): Derived<PillarValue> {
  const { coverage } = deriveCoverage({
    requiredInputs: args.requiredInputs,
    presentInputs: args.presentInputs,
    historyDays: args.historyDays,
    missing: args.missing,
    fullHistoryDays: args.windowDays,
  });
  return buildInsufficient<PillarValue>({
    coverage,
    provenance: provenance({
      inputs: [args.id],
      source: args.source,
      windowDays: args.windowDays,
      asOf: args.asOf,
    }),
    reason: args.reason,
  });
}

export function failedPillar(args: {
  id: ScorePillarId;
  asOf: Date;
  windowDays: number;
}): Derived<PillarValue> {
  return insufficientPillar({
    ...args,
    source: "none",
    requiredInputs: 1,
    presentInputs: 0,
    historyDays: 0,
    missing: [args.id],
    reason: "read_failed",
  });
}

export function okPillar(args: {
  id: ScorePillarId;
  source: DerivedProvenanceSource;
  asOf: Date;
  windowDays: number;
  coverage: DerivedCoverage;
  value: PillarValue;
}): Derived<PillarValue> {
  const { confidence } = deriveCoverage({
    ...args.coverage,
    fullHistoryDays: args.windowDays,
  });
  return buildOk({
    value: args.value,
    coverage: args.coverage,
    confidence,
    provenance: provenance({
      inputs: [args.id],
      source: args.source,
      windowDays: args.windowDays,
      asOf: args.asOf,
    }),
  });
}

export function coverage(args: {
  requiredInputs: number;
  presentInputs: number;
  historyDays: number;
  missing?: string[];
}): DerivedCoverage {
  return {
    requiredInputs: args.requiredInputs,
    presentInputs: Math.min(args.presentInputs, args.requiredInputs),
    historyDays: Math.max(0, args.historyDays),
    missing: args.missing ?? [],
  };
}
