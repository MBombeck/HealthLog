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
  inboundLabValuesExample,
  LAB_VALUES_EXAMPLE_TEXT,
  SAME_TIME_DAILY_TOTAL_EXAMPLE_INPUT as INPUT,
  sameTimeBaselineDailyTotalExample,
} from "@/lib/openapi/examples";
import { openApiPaths } from "@/lib/openapi/routes";
import { inboundDocumentDetail } from "@/lib/openapi/routes/documents";
import { derivedMetricResponse } from "@/lib/openapi/routes/insights/schemas";

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

  it("both examples are published on their routes", () => {
    const derived = openApiPaths["/api/insights/derived"]?.get?.responses?.[
      "200"
    ] as { content: Record<string, { examples?: Record<string, unknown> }> };
    expect(
      derived.content["application/json"].examples?.sameTimeBaselineDailyTotal,
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
