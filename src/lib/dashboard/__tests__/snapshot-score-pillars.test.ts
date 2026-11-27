/**
 * The health-score pillar block on the dashboard snapshot: one slim row per
 * pillar, worded the way the Insights panel words it, in the response
 * language, and the published example is what the builder returns.
 */
import { describe, expect, it } from "vitest";
import { snapshotScorePillars } from "@/lib/dashboard/snapshot-health-score";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { locales } from "@/lib/i18n/config";
import type { ScorePillarResult } from "@/lib/analytics/score/types";
import { SCORE_PILLAR_DOMAINS } from "@/lib/analytics/score/types";
import {
  SCORE_PILLAR_REASON_KEYS,
  scorePillarReasonKey,
} from "@/lib/score-config/labels";
import {
  dashboardScorePillarsExample,
  SCORE_PILLARS_EXAMPLE_INPUT,
} from "@/lib/openapi/examples";
import { dashboardScorePillar } from "@/lib/openapi/routes/insights/schemas";
import { compositeWeights } from "@/lib/analytics/score/composite";

const provenance = {
  inputs: [],
  source: "DAY" as const,
  windowDays: 90,
  computedAt: "2026-11-25T07:00:00.000Z",
};
const coverage = {
  requiredInputs: 1,
  presentInputs: 1,
  historyDays: 90,
  missing: [],
};

/** The composite's weights for the example: the two pillars that counted. */
const WEIGHTS = compositeWeights(
  SCORE_PILLARS_EXAMPLE_INPUT.filter((entry) => "score" in entry).map(
    (entry) => entry.id,
  ),
);

function pillarResults(): ScorePillarResult[] {
  return SCORE_PILLARS_EXAMPLE_INPUT.map((entry) => ({
    id: entry.id,
    domain: SCORE_PILLAR_DOMAINS[entry.id],
    result:
      "score" in entry
        ? ({
            status: "ok",
            value: { score: entry.score },
            coverage,
            confidence: { score: 90, band: "high" },
            provenance,
          } as unknown as ScorePillarResult["result"])
        : {
            status: "insufficient",
            coverage: { ...coverage, presentInputs: 0 },
            provenance,
            reason: entry.reason,
          },
  }));
}

describe("snapshot score pillars", () => {
  it("the published example is what the builder returns, and parses", () => {
    const built = snapshotScorePillars(pillarResults(), WEIGHTS, "en");
    expect(built).toEqual(dashboardScorePillarsExample);
    for (const row of dashboardScorePillarsExample) {
      expect(
        dashboardScorePillar.strict().safeParse(row).error?.issues ?? [],
      ).toEqual([]);
    }
  });

  it("words every pillar and reason in every shipped language", () => {
    for (const locale of locales) {
      for (const row of snapshotScorePillars(
        pillarResults(),
        WEIGHTS,
        locale,
      )) {
        expect(row.label).not.toMatch(/^insights\./);
        if (row.reason !== null) expect(row.reason).not.toMatch(/^insights\./);
      }
    }
    const de = snapshotScorePillars(pillarResults(), WEIGHTS, "de");
    expect(de[2]).toMatchObject({ value: null, reason: "Nicht erfasst" });
  });

  it("every known reason has a sentence, and an unknown one says 'not eligible'", () => {
    const t = getServerTranslator("en").t;
    const keys = Object.keys(SCORE_PILLAR_REASON_KEYS);
    expect(keys.length).toBeGreaterThan(0);
    for (const reason of keys) {
      const key = scorePillarReasonKey(reason);
      expect(t(key)).not.toBe(key);
    }
    expect(t(scorePillarReasonKey("something_new"))).toBe(
      "This pillar is not currently eligible",
    );
  });
});
