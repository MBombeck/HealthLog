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
export const SCORE_YELLOW_FLOOR = 50;

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
 * Since 1.50 this is the whole band rule for the health score too: the
 * composite no longer takes the worse of this band and its worst pillar's.
 * A pillar in a worse band is named beside the score (`bandSetter`).
 */
export function scoreBand(score: number): ScoreBand {
  if (score >= SCORE_GREEN_FLOOR) return "green";
  if (score >= SCORE_YELLOW_FLOOR) return "yellow";
  return "red";
}

/**
 * Which way each HealthLog score reads. Readiness, the sleep score, the
 * health score and the computed recovery are better high; the two load
 * estimates, stress and strain, are heavier high.
 */
export const SCORE_BAND_DIRECTION = {
  health: "higher-better",
  readiness: "higher-better",
  sleep: "higher-better",
  recovery: "higher-better",
  stress: "lower-better",
  strain: "lower-better",
} as const;

export type HealthLogScoreKind = keyof typeof SCORE_BAND_DIRECTION;

/**
 * The one band rule for every 0..100 score, with direction (1.50).
 *
 * Every HealthLog score is banded by {@link scoreBand}; a lower-better score
 * is banded on `100 - score`, so a stress of 80 is red, never green. A
 * vendor's own number (`"vendor"`: a WHOOP recovery, an Oura or Garmin sleep
 * score) gets no HealthLog band at all and returns `null`; the vendor colours
 * its number by its own scale, and HealthLog does not restate it. The health
 * score follows this rule as it stands; its worst pillar is named beside
 * the band, never folded into it.
 */
export function bandForScoreKind(
  kind: HealthLogScoreKind,
  score: number,
): ScoreBand;
export function bandForScoreKind(kind: "vendor", score: number): null;
export function bandForScoreKind(
  kind: HealthLogScoreKind | "vendor",
  score: number,
): ScoreBand | null;
export function bandForScoreKind(
  kind: HealthLogScoreKind | "vendor",
  score: number,
): ScoreBand | null {
  if (kind === "vendor") return null;
  return scoreBand(
    SCORE_BAND_DIRECTION[kind] === "higher-better" ? score : 100 - score,
  );
}

/**
 * Yellow floor of the band a vendor's number still carries on the wire
 * until 1.51. See {@link legacyVendorWireBand}.
 */
const LEGACY_VENDOR_YELLOW_FLOOR = 40;

/**
 * The `band` a vendor's own number (a WHOOP recovery, a WHOOP day strain)
 * keeps on the wire in 1.50, so the iOS ring that shows it does not change
 * colour before it is rebuilt on the vendor's own thresholds in 1.51. It is
 * the ladder those rings have always shown (green from 70, yellow from 40,
 * direction honoured). No web surface paints it: there a vendor's number is
 * shown neutral (`bandForScoreKind("vendor")` is null). Retire it with the
 * ring rebuild.
 */
export function legacyVendorWireBand(
  score: number,
  direction: "higher-better" | "lower-better",
): ScoreBand {
  const good = direction === "higher-better" ? score : 100 - score;
  if (good >= SCORE_GREEN_FLOOR) return "green";
  if (good >= LEGACY_VENDOR_YELLOW_FLOOR) return "yellow";
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
