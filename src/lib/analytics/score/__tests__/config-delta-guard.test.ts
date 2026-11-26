/**
 * The per-user recipe boundary, at the two places it exists.
 *
 * The end-to-end proof that a settings change is never narrated as a
 * health event lives in `config-change-is-not-a-health-event.test.ts`,
 * over the real snapshot and digest. This file covers what that one
 * cannot reach without a fixture per case: the boundary arithmetic's
 * edges and the notice key's two dimensions.
 *
 * Each guard here has a counter-case beside it. A boundary that
 * suppressed everything would pass every "no false drop" assertion ever
 * written and silence every honest week as well, which is the same
 * defect wearing the opposite sign.
 */
import { describe, expect, it } from "vitest";

import { buildOk, deriveCoverage } from "@/lib/insights/derived/coverage";
import type { Derived } from "@/lib/insights/derived/types";
import { healthScoreNoticeItemKey } from "@/lib/daily/priority-item-key";
import { isDismissibleItemKey } from "@/lib/daily/priority-item";
import { dismissPriorityItemSchema } from "@/lib/validations/daily";

import { attachScoreDelta, crossesConfigBoundary } from "../composite";
import {
  resolveHealthScoreConfig,
  healthScoreConfigFromSelection,
  scoreConfigBoundary,
  UNCONFIGURED_SCORE_BOUNDARY,
} from "../config";
import type {
  CompositeValue,
  PillarValue,
  ScorePillarId,
  ScorePillarResult,
} from "../types";
import { SCORE_VERSION } from "../types";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-20T12:00:00.000Z");

const DOMAIN_BY_PILLAR: Record<ScorePillarId, ScorePillarResult["domain"]> = {
  BLOOD_PRESSURE: "cardiometabolic",
  GLYCAEMIA: "cardiometabolic",
  ACTIVITY: "activity",
  SLEEP: "sleep",
  ADIPOSITY: "adiposity",
  WELLBEING: "wellbeing",
  LIPIDS: "cardiometabolic",
};

function pillar(id: ScorePillarId, score: number): ScorePillarResult {
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: 28,
    missing: [],
    fullHistoryDays: 28,
  });
  const value: PillarValue = {
    score,
    observed: {
      value: score,
      unit: "score",
      label: `${score}`,
      asOf: NOW.toISOString(),
      sources: ["MANUAL"],
    },
    reference: {
      kind: "guideline-band",
      low: 0,
      high: 100,
      label: "band",
      source: "Test 2026",
    },
    noiseFloor: 1,
    deltaEligible: true,
    deltaIdentity: id,
  };
  return {
    id,
    domain: DOMAIN_BY_PILLAR[id],
    result: buildOk({
      value,
      coverage,
      confidence,
      provenance: {
        inputs: [id],
        source: "live",
        windowDays: 28,
        computedAt: NOW.toISOString(),
      },
    }),
  };
}

/** A composite standing at `score`, computed as of `asOf`. */
function composite(score: number, asOf: Date): Derived<CompositeValue> {
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 3,
    presentInputs: 3,
    historyDays: 28,
    missing: [],
    fullHistoryDays: 28,
  });
  return buildOk<CompositeValue>({
    value: {
      score,
      band: "green",
      numberBand: "green",
      bandSetter: null,
      composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      configured: false,
      noiseFloor: 1,
      scoreVersion: SCORE_VERSION,
    },
    coverage,
    confidence,
    provenance: {
      inputs: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      source: "live",
      windowDays: 28,
      computedAt: asOf.toISOString(),
    },
  });
}

const CURRENT_PILLARS = [
  pillar("BLOOD_PRESSURE", 60),
  pillar("ACTIVITY", 60),
  pillar("SLEEP", 60),
];
const EARLIER_PILLARS = [
  pillar("BLOOD_PRESSURE", 80),
  pillar("ACTIVITY", 80),
  pillar("SLEEP", 80),
];

/** A twenty-point fall, well clear of the noise floor. */
function fallingDelta(changedAt: Date | null) {
  return attachScoreDelta(
    composite(60, NOW),
    composite(80, new Date(NOW.getTime() - 7 * DAY_MS)),
    composite(80, new Date(NOW.getTime() - 14 * DAY_MS)),
    NOW,
    {
      version: changedAt === null ? 0 : 2,
      changedAt: changedAt?.toISOString() ?? null,
    },
    CURRENT_PILLARS,
    EARLIER_PILLARS,
  );
}

describe("the recipe boundary", () => {
  it("suppresses a fall the person's own settings change straddles", () => {
    const report = fallingDelta(new Date(NOW.getTime() - 3 * DAY_MS));
    expect(report.delta).toBeNull();
    expect(report.deltaReason).toBe("config_changed");
  });

  it("stays out of the way when the recipe has not moved in the window", () => {
    // The counter-case. A guard that suppressed here would hide every
    // genuine decline an account with a recipe ever has.
    const report = fallingDelta(new Date(NOW.getTime() - 30 * DAY_MS));
    expect(report.deltaReason).toBeNull();
    expect(report.delta).toBe(-20);
  });

  it("stays out of the way for an account that never chose", () => {
    const report = fallingDelta(null);
    expect(report.deltaReason).toBeNull();
    expect(report.delta).toBe(-20);
  });

  it("names the act rather than its consequence when both would fire", () => {
    // A change that also moved the composition trips two rules at once.
    // The order matters to the sentence a person reads: "the included
    // pillars changed" describes what happened to the number and leaves
    // out who did it, which is the whole confusion this guard exists to
    // remove.
    const narrower = buildOk<CompositeValue>({
      value: {
        score: 60,
        band: "green",
        numberBand: "green",
        bandSetter: null,
        composition: ["BLOOD_PRESSURE", "ACTIVITY"],
        configured: false,
        noiseFloor: 1,
        scoreVersion: SCORE_VERSION,
      },
      coverage: {
        requiredInputs: 3,
        presentInputs: 2,
        historyDays: 28,
        missing: [],
      },
      confidence: { score: 80, band: "high" },
      provenance: {
        inputs: ["BLOOD_PRESSURE", "ACTIVITY"],
        source: "live",
        windowDays: 28,
        computedAt: NOW.toISOString(),
      },
    });

    const report = attachScoreDelta(
      narrower,
      composite(80, new Date(NOW.getTime() - 7 * DAY_MS)),
      composite(80, new Date(NOW.getTime() - 14 * DAY_MS)),
      NOW,
      {
        version: 2,
        changedAt: new Date(NOW.getTime() - 3 * DAY_MS).toISOString(),
      },
      CURRENT_PILLARS,
      EARLIER_PILLARS,
    );

    expect(report.deltaReason).toBe("config_changed");
  });

  it("suppresses at the boundary instant and not one moment past it", () => {
    const previousAt = new Date(NOW.getTime() - 7 * DAY_MS);
    const boundary = (changedAt: Date) =>
      crossesConfigBoundary(
        { version: 1, changedAt: changedAt.toISOString() },
        previousAt,
        NOW,
      );

    // A change on the previous window's own instant is not inside the
    // window: that window was scored under it.
    expect(boundary(previousAt)).toBe(false);
    expect(boundary(new Date(previousAt.getTime() + 1))).toBe(true);
    expect(boundary(NOW)).toBe(true);
    // A change stamped after the current window is a clock that ran
    // ahead, not a comparison to break.
    expect(boundary(new Date(NOW.getTime() + 1))).toBe(false);
  });

  it("refuses to read a boundary it cannot parse, rather than suppressing forever", () => {
    expect(
      crossesConfigBoundary(
        { version: 4, changedAt: "not a date" },
        new Date(NOW.getTime() - 7 * DAY_MS),
        NOW,
      ),
    ).toBe(false);
    expect(
      crossesConfigBoundary(
        { version: 4, changedAt: null },
        new Date(NOW.getTime() - 7 * DAY_MS),
        NOW,
      ),
    ).toBe(false);
  });

  it("never resolves a recipe version without the date the guard reads", () => {
    // The invariant the boundary rests on. `crossesConfigBoundary` asks
    // only about the date, which is safe exactly because a resolved
    // config never carries a version without one — an authored recipe
    // always has both, and a never-authored one has neither. If a
    // resolver path ever produced a version with no date, the guard
    // would wave that account's recipe change straight through.
    const blobs: unknown[] = [
      null,
      undefined,
      "not an object",
      {},
      { excludedPillars: [] },
      { excludedPillars: ["SLEEP"] },
      { excludedPillars: ["SLEEP"], version: 2 },
      { excludedPillars: ["nonsense"], version: 9 },
      { excludedPillars: [], changedAt: "2026-08-01T00:00:00.000Z" },
      { version: 4, changedAt: "2026-08-01T00:00:00.000Z" },
    ];

    for (const blob of blobs) {
      const resolved = resolveHealthScoreConfig(blob);
      expect(
        resolved.version >= 1 || resolved.changedAt === null,
        `version without a change date for ${JSON.stringify(blob)}`,
      ).toBe(true);
    }
  });

  it("carries the resolver's own answer, not a second reading of the blob", () => {
    const changedAt = new Date(NOW.getTime() - 2 * DAY_MS);
    const stored = healthScoreConfigFromSelection({
      selection: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
      version: 7,
      changedAt,
    });

    expect(scoreConfigBoundary(resolveHealthScoreConfig(stored))).toEqual({
      version: 7,
      changedAt: changedAt.toISOString(),
    });
    expect(scoreConfigBoundary(resolveHealthScoreConfig(null))).toEqual(
      UNCONFIGURED_SCORE_BOUNDARY,
    );
  });
});

describe("the notice key", () => {
  it("moves when the method moves and when the recipe moves", () => {
    const base = healthScoreNoticeItemKey(2, 3);
    expect(healthScoreNoticeItemKey(3, 3)).not.toBe(base);
    expect(healthScoreNoticeItemKey(2, 4)).not.toBe(base);
    // …and only then. The same pair is the same acknowledgement, so the
    // notice is raised once and dismissed once per recipe version.
    expect(healthScoreNoticeItemKey(2, 3)).toBe(base);
  });

  it("leaves a never-configured account's existing key exactly as it was", () => {
    // Lengthening this key for everybody would orphan every dismissal
    // already in the ledger and re-raise the method notice for the whole
    // install base on upgrade.
    expect(healthScoreNoticeItemKey(2, 0)).toBe("health_score_algorithm:2");
  });

  it("stays a key the dismiss route already accepts", () => {
    // The whole reason for folding the recipe version into this key
    // rather than minting a second notice system: dismissal, the ledger
    // prefix and the score-cache eviction all key on the prefix and need
    // no change to carry the new notice.
    const key = healthScoreNoticeItemKey(2, 5);
    expect(key.startsWith("health_score_algorithm:")).toBe(true);
    expect(isDismissibleItemKey(key)).toBe(true);
    expect(dismissPriorityItemSchema.safeParse({ itemKey: key }).success).toBe(
      true,
    );
  });
});
