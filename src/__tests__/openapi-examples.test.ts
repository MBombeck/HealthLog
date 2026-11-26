/**
 * The response examples in `docs/api/openapi.yaml` are what the server sends.
 *
 * A client pins its decoder to these bytes, so an example that drifted from
 * the code would pin the wrong contract on both ends at once. Each one is
 * rebuilt here by the server's own builder from the input written beside it
 * (`src/lib/openapi/examples.ts`), parsed by the schema it is published
 * under, and found in the generated document.
 */
import { describe, expect, it } from "vitest";

import { labValuesFromText } from "@/lib/documents/local-lab-values";
import { buildDailyTotalBaseline } from "@/lib/insights/derived/same-time-baseline";
import type { CumulativeDayTotal } from "@/lib/measurements/cumulative-day-totals";
import {
  blendReadinessComponents,
  readinessFreshness,
} from "@/lib/insights/derived/readiness";
import { deriveCoverage } from "@/lib/insights/derived/coverage";
import { bandForScoreKind } from "@/lib/analytics/score/shared";
import {
  inboundLabValuesExample,
  LAB_VALUES_EXAMPLE_TEXT,
  READINESS_EXAMPLE_INPUT,
  readinessFreshExample,
  readinessStaleExample,
  SAME_TIME_DAILY_TOTAL_EXAMPLE_INPUT as INPUT,
  sameTimeBaselineDailyTotalExample,
} from "@/lib/openapi/examples";
import { openApiPaths } from "@/lib/openapi/routes";
import { inboundDocumentDetail } from "@/lib/openapi/routes/documents";
import {
  derivedMetricResponse,
  readinessValue,
} from "@/lib/openapi/routes/insights/schemas";

describe("published response examples", () => {
  it("the daily_total example is what buildDailyTotalBaseline returns", () => {
    const totals: CumulativeDayTotal[] = INPUT.history.map((total, i) => {
      const dateKey = `2026-11-${String(INPUT.historyFirstDay + i).padStart(2, "0")}`;
      return {
        dateKey,
        total,
        source: INPUT.source,
        lastUpdatedAt: new Date(`${dateKey}${INPUT.historyUpdatedAt}`),
      };
    });
    totals.push({
      dateKey: INPUT.dateKey,
      total: INPUT.today.total,
      source: INPUT.source,
      lastUpdatedAt: new Date(INPUT.today.updatedAt),
    });
    const built = buildDailyTotalBaseline({
      type: INPUT.type,
      timezone: INPUT.timezone,
      dateKey: INPUT.dateKey,
      totals,
      computedAt: INPUT.computedAt,
      unit: INPUT.unit,
    });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") return;
    const { data } = sameTimeBaselineDailyTotalExample;
    expect(data.value).toEqual(built.value);
    expect(data.coverage).toEqual(built.coverage);
    expect(data.confidence).toEqual(built.confidence);
    expect(data.provenance).toEqual(built.provenance);
    expect(derivedMetricResponse.safeParse(data).success).toBe(true);
  });

  it("the lab-values example is what labValuesFromText reads", () => {
    const read = labValuesFromText(LAB_VALUES_EXAMPLE_TEXT, { ocr: true });
    const { data } = inboundLabValuesExample;
    expect(data.providerType).toBe(read.providerType);
    expect(data.reportDate).toBe(read.reportDate);
    expect(data.extractionIncomplete).toBe(read.incomplete);
    expect(data.facts).toHaveLength(read.facts.length);
    data.facts.forEach((fact, i) => {
      const staged = read.facts[i];
      expect(fact.factType).toBe(staged.factType);
      expect(fact.confidence).toBe(staged.confidence);
      expect(fact.needsReview).toBe(staged.needsReview);
      expect(fact.data).toEqual(staged.data);
      expect(fact.provenance).toEqual(staged.provenance);
    });
    expect(data.facts.some((f) => f.needsReview)).toBe(true);
    expect(
      inboundDocumentDetail.strict().safeParse(data).error?.issues ?? [],
    ).toEqual([]);
  });

  it("the READINESS examples are what the blend, the band and the freshness rule give", () => {
    const cases = [
      [READINESS_EXAMPLE_INPUT.fresh, readinessFreshExample, true],
      [READINESS_EXAMPLE_INPUT.stale, readinessStaleExample, false],
    ] as const;
    for (const [input, example, fresh] of cases) {
      const { score, components } = blendReadinessComponents({
        ...input.raw,
      });
      const { data } = example;
      const freshness = readinessFreshness({
        vitalDays: [...input.vitalDays],
        sleepNight: input.sleepNight,
        todayKey: READINESS_EXAMPLE_INPUT.todayKey,
      });
      expect(data.value.fresh).toBe(freshness.fresh);
      expect(data.value.fresh).toBe(fresh);
      // A stale readiness names the stored value of its day, never the live
      // blend, and carries no breakdown.
      const shown =
        "stored" in input ? input.stored : { score, day: freshness.asOfDay };
      expect(data.value.score).toBe(shown.score);
      expect(data.value.asOfDay).toBe(shown.day);
      expect(data.value.band).toBe(bandForScoreKind("readiness", shown.score));
      expect(data.value.components).toEqual(
        fresh
          ? components
          : components.map((c) => ({ key: c.key, value: null, weight: 0 })),
      );
      const missing = components
        .filter((c) => c.value === null)
        .map((c) => c.key);
      const derived = deriveCoverage({
        requiredInputs: components.length,
        presentInputs: components.length - missing.length,
        historyDays: data.coverage.historyDays,
        missing,
        fullHistoryDays: data.provenance.windowDays,
      });
      expect(data.coverage).toEqual(derived.coverage);
      expect(data.confidence).toEqual(derived.confidence);
      expect(
        readinessValue.strict().safeParse(data.value).error?.issues ?? [],
      ).toEqual([]);
      expect(derivedMetricResponse.safeParse(data).success).toBe(true);
    }
  });

  it("both examples are published on their routes", () => {
    const derived = openApiPaths["/api/insights/derived"]?.get?.responses?.[
      "200"
    ] as { content: Record<string, { examples?: Record<string, unknown> }> };
    expect(
      derived.content["application/json"].examples?.sameTimeBaselineDailyTotal,
    ).toBeDefined();
    expect(
      derived.content["application/json"].examples?.readinessFresh,
    ).toBeDefined();
    expect(
      derived.content["application/json"].examples?.readinessStale,
    ).toBeDefined();
    const lab = openApiPaths["/api/documents/inbound/{id}/lab-values"]?.post
      ?.responses?.["200"] as {
      content: Record<string, { examples?: Record<string, unknown> }>;
    };
    expect(
      lab.content["application/json"].examples?.scannedLabReport,
    ).toBeDefined();
  });
});
