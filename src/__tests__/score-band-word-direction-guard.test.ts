/**
 * Every HealthLog score's band and the word under it, by direction.
 *
 * The rings at the head of Insights read readiness 87 "good", sleep 77
 * "good" and a health score of 81 "low": the health score's band took the
 * worse of its own band and its worst pillar's, so one red pillar turned
 * the word under an 81 into "low". Since 1.50 the health score bands on its
 * number like every other score and names that pillar beside it.
 *
 * Pinned here for every kind in `SCORE_BAND_DIRECTION`: the band the server
 * computes, the word a surface shows for it (from `scoreBandWordKey`, the
 * one map every surface takes its word from), and the composite itself, so
 * a high score over a red pillar cannot read "low" again. A kind added to
 * the direction table without a row here fails the exhaustiveness case.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildOk, deriveCoverage } from "@/lib/insights/derived/coverage";
import { computeComposite } from "@/lib/analytics/score/composite";
import {
  SCORE_BAND_DIRECTION,
  bandForScoreKind,
  type HealthLogScoreKind,
} from "@/lib/analytics/score/shared";
import type {
  ScorePillarId,
  ScorePillarResult,
} from "@/lib/analytics/score/types";
import { scoreBandWordKey } from "@/components/insights/derived/band-tokens";
import {
  healthScoreSetter,
  healthScoreSetterLine,
  worseScoreBand,
} from "@/lib/score-config/labels";

const EN = JSON.parse(
  readFileSync(join(process.cwd(), "messages/en.json"), "utf8"),
) as Record<string, unknown>;

function en(key: string, params: Record<string, string | number> = {}) {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      EN,
    );
  if (typeof value !== "string") throw new Error(`missing en key ${key}`);
  return value.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params[name] ?? `{${name}}`),
  );
}

type Row = [HealthLogScoreKind, number, "green" | "yellow" | "red", string];

const CASES: Row[] = [
  ["health", 81, "green", "good"],
  ["health", 60, "yellow", "fair"],
  ["health", 45, "red", "low"],
  ["readiness", 87, "green", "good"],
  ["readiness", 49, "red", "low"],
  ["sleep", 77, "green", "good"],
  ["sleep", 55, "yellow", "fair"],
  ["sleep", 40, "red", "low"],
  ["recovery", 72, "green", "good"],
  ["recovery", 30, "red", "low"],
  ["stress", 80, "red", "high"],
  ["stress", 40, "yellow", "moderate"],
  ["stress", 20, "green", "low"],
  ["strain", 80, "red", "high"],
  ["strain", 25, "green", "low"],
  ["strain", 45, "yellow", "moderate"],
];

describe("score band direction and word", () => {
  for (const [kind, score, band, word] of CASES) {
    it(`${kind} ${score} is ${band}, "${word}"`, () => {
      const actual = bandForScoreKind(kind, score);
      expect(actual).toBe(band);
      expect(en(scoreBandWordKey(kind, actual))).toBe(word);
    });
  }

  it("covers every score kind in both directions it can read", () => {
    const kinds = Object.keys(SCORE_BAND_DIRECTION) as HealthLogScoreKind[];
    // Six kinds today: health, readiness, sleep, recovery, stress, strain.
    expect(kinds.length).toBeGreaterThanOrEqual(6);
    for (const kind of kinds) {
      const bands = new Set(
        CASES.filter(([k]) => k === kind).map(([, , band]) => band),
      );
      expect(bands.has("green"), `${kind} green row`).toBe(true);
      expect(bands.has("red"), `${kind} red row`).toBe(true);
    }
  });

  it("never calls a heavy load low or a high higher-better score low", () => {
    for (const kind of Object.keys(
      SCORE_BAND_DIRECTION,
    ) as HealthLogScoreKind[]) {
      const word = en(scoreBandWordKey(kind, bandForScoreKind(kind, 90)));
      expect(word, kind).toBe(
        SCORE_BAND_DIRECTION[kind] === "lower-better" ? "high" : "good",
      );
    }
  });
});

const NOW = new Date("2026-11-26T12:00:00.000Z");

function pillar(id: ScorePillarId, score: number): ScorePillarResult {
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: 28,
    missing: [],
    fullHistoryDays: 28,
  });
  return {
    id,
    domain:
      id === "BLOOD_PRESSURE" || id === "GLYCAEMIA" || id === "LIPIDS"
        ? "cardiometabolic"
        : id === "ACTIVITY"
          ? "activity"
          : id === "SLEEP"
            ? "sleep"
            : id === "ADIPOSITY"
              ? "adiposity"
              : "wellbeing",
    result: buildOk({
      value: {
        score,
        observed: {
          label: `${score}`,
          value: score,
          unit: "score",
          asOf: NOW.toISOString(),
          sources: ["MANUAL"],
        },
        reference: {
          kind: "guideline-band",
          low: 0,
          high: 100,
          label: "test reference",
          source: "Test 2026",
        },
        noiseFloor: 1,
        deltaEligible: true,
        deltaIdentity: id,
      },
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

describe("the health score over a red pillar", () => {
  // The shape on the screen that read "81 low": activity at 34, the rest
  // well inside their ranges.
  const pillars = [
    pillar("BLOOD_PRESSURE", 84),
    pillar("GLYCAEMIA", 100),
    pillar("ACTIVITY", 34),
    pillar("SLEEP", 72),
    pillar("ADIPOSITY", 100),
    pillar("WELLBEING", 76),
    pillar("LIPIDS", 100),
  ];
  const composite = computeComposite({
    pillars,
    availablePillars: pillars.map((p) => p.id),
    asOf: NOW,
    configured: false,
  });

  it("reads 81, green, good, and names the red pillar beside it", () => {
    expect(composite.status).toBe("ok");
    if (composite.status !== "ok") return;
    expect(composite.value.score).toBe(81);
    expect(composite.value.band).toBe("green");
    expect(en(scoreBandWordKey("health", composite.value.band))).toBe("good");
    expect(composite.value.bandSetter).toBe("ACTIVITY");
    expect(healthScoreSetterLine({ composite, pillars }, en)).toBe(
      "Activity: outside the reference range",
    );
  });

  it("hands every surface the setter's band, so a sentence takes the worse", () => {
    expect(healthScoreSetter({ composite, pillars }, en)).toEqual({
      id: "ACTIVITY",
      band: "red",
      line: "Activity: outside the reference range",
    });
    expect(worseScoreBand("green", "red")).toBe("red");
    expect(worseScoreBand("red", "yellow")).toBe("red");
    expect(worseScoreBand("green", null)).toBe("green");
  });

  it("says nothing beside the score when no pillar sits below its band", () => {
    const even = [pillar("ACTIVITY", 80), pillar("SLEEP", 90)];
    const result = computeComposite({
      pillars: even,
      availablePillars: even.map((p) => p.id),
      asOf: NOW,
      configured: false,
    });
    expect(
      healthScoreSetterLine({ composite: result, pillars: even }, en),
    ).toBe(null);
  });
});
