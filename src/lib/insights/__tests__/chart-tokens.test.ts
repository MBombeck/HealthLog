import { describe, expect, it } from "vitest";

import { MeasurementType } from "@/generated/prisma/client";
import {
  ALLOWED_CHART_TOKENS,
  parseChartTokens,
  stripChartTokens,
  tokenToMetric,
} from "../chart-tokens";

describe("parseChartTokens", () => {
  it("extracts a single allowlisted token", () => {
    expect(
      parseChartTokens("Dein BP ist top metric:BLOOD_PRESSURE_SYS"),
    ).toEqual(["metric:BLOOD_PRESSURE_SYS"]);
  });

  it("drops tokens that are not on the allowlist", () => {
    expect(parseChartTokens("metric:NUKE will not render")).toEqual([]);
  });

  it("strips trailing junk via the regex character class", () => {
    // The greedy [A-Z_]+ class stops at the apostrophe, so the surviving
    // token is just `metric:WEIGHT` and the rest stays inert text.
    expect(parseChartTokens("metric:WEIGHT' onclick='alert(1)'")).toEqual([
      "metric:WEIGHT",
    ]);
  });

  it("returns multiple tokens preserving order", () => {
    expect(
      parseChartTokens(
        "metric:WEIGHT and metric:PULSE and a fake metric:NUKE here",
      ),
    ).toEqual(["metric:WEIGHT", "metric:PULSE"]);
  });

  it("returns [] for empty input", () => {
    expect(parseChartTokens("")).toEqual([]);
    expect(parseChartTokens("no tokens here")).toEqual([]);
  });
});

describe("stripChartTokens", () => {
  it("removes a token and collapses surrounding whitespace", () => {
    expect(stripChartTokens("BP top metric:BLOOD_PRESSURE_SYS now")).toBe(
      "BP top now",
    );
  });

  it("removes hallucinated tokens too — they are still well-formed", () => {
    expect(stripChartTokens("metric:NUKE try this")).toBe("try this");
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripChartTokens(" metric:WEIGHT ")).toBe("");
  });
});

describe("tokenToMetric", () => {
  it("strips the `metric:` prefix", () => {
    expect(tokenToMetric("metric:WEIGHT")).toBe("WEIGHT");
    expect(tokenToMetric("metric:BLOOD_PRESSURE_SYS")).toBe(
      "BLOOD_PRESSURE_SYS",
    );
  });
});

describe("ALLOWED_CHART_TOKENS — drift guard", () => {
  it("has unique entries", () => {
    expect(new Set(ALLOWED_CHART_TOKENS).size).toBe(
      ALLOWED_CHART_TOKENS.length,
    );
  });

  it("covers every MeasurementType enum value", () => {
    // If a future schema migration adds a new MeasurementType, this test
    // fails until the new `metric:<TYPE>` is also added to the allowlist.
    // (`NOTE` is excluded if it ever appears — currently the schema has none.)
    const enumTokens = (Object.values(MeasurementType) as string[])
      .filter((value) => value !== "NOTE")
      .map((value) => `metric:${value}`);

    for (const token of enumTokens) {
      expect(ALLOWED_CHART_TOKENS, `missing ${token}`).toContain(token);
    }
  });

  it("excludes mood and compliance tokens until dedicated charts ship", () => {
    // `<HealthChart>` validates `type` against `measurementTypeEnum`, so
    // emitting `metric:MOOD` or `metric:COMPLIANCE` would render an empty
    // panel. Keep them out of the allowlist until a real MoodChart /
    // ComplianceChart is wired into the renderer.
    expect(ALLOWED_CHART_TOKENS).not.toContain("metric:MOOD");
    expect(ALLOWED_CHART_TOKENS).not.toContain("metric:COMPLIANCE");
  });
});
