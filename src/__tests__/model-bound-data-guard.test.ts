/**
 * The one classification of what never reaches a model
 * (`src/lib/ai/model-bound-data.ts`): its filter, and the exits that apply
 * it. The sentence it keeps true, and the instruments it covers, are held
 * with every other privacy promise in `privacy-promise-guard.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { withoutModelBoundExclusions } from "@/lib/ai/model-bound-data";

import { readSource, readSourceFolder } from "./helpers/source-files";

describe("withoutModelBoundExclusions", () => {
  it("drops a reading, a section item, a keyed entry and a bare type", () => {
    const at = new Date("2026-01-02T03:04:05Z");
    const { value, dropped } = withoutModelBoundExclusions({
      present: true,
      values: [
        { type: "WEIGHT", value: 80 },
        { type: "PHQ9_SCORE", value: 17 },
      ],
      events: [
        { section: "mood", title: "good" },
        { section: "assessments", title: "PHQ9", meta: "17 modSevere" },
      ],
      byType: { WEIGHT: 1, WHO5_SCORE: 2 },
      types: ["WEIGHT", "SCI_SCORE"],
      at,
    });
    expect(dropped).toBe(4);
    expect(value).toEqual({
      present: true,
      values: [{ type: "WEIGHT", value: 80 }],
      events: [{ section: "mood", title: "good" }],
      byType: { WEIGHT: 1 },
      types: ["WEIGHT"],
      at,
    });
  });

  it("answers undefined when the payload itself is an excluded entry", () => {
    expect(
      withoutModelBoundExclusions({ measurementType: "GAD7_SCORE", value: 3 })
        .value,
    ).toBeUndefined();
  });

  it("leaves a payload without excluded kinds untouched", () => {
    const payload = { present: true, data: [{ type: "PULSE", value: 60 }] };
    const { value, dropped } = withoutModelBoundExclusions(payload);
    expect(dropped).toBe(0);
    expect(value).toEqual(payload);
  });
});

describe("the exits apply it", () => {
  it("every MCP read tool, resource and template passes the filter", () => {
    const server = readSource("src/lib/mcp/server.ts", "createMcpServer");
    expect(server).toMatch(/withoutModelBoundExclusions\(/);
    // Read tools, resources and templates: three call sites of the exit.
    expect(server.match(/forExternalTool\(/g)?.length).toBeGreaterThanOrEqual(
      4,
    );
    expect(server).toMatch(/registerTool\(tool, \{ reads: true \}\)/);
  });

  it("every Coach tool result passes the filter", () => {
    const executor = readSource(
      "src/lib/ai/coach/tools/executor.ts",
      "executeCoachTool",
    );
    expect(executor).toMatch(/withoutModelBoundExclusions\(/);
    expect(executor).toMatch(/return forModel\(name, result\)/);
  });

  it("an all-types read on a model path names the exclusion", () => {
    // A reader that iterates every measurement type for a model prompt picks
    // up the questionnaire totals unless it filters them. The model paths are
    // the AI, insights, MCP, daily and job modules.
    const ALL_TYPES =
      /measurementTypeEnum\.options|Object\.(values|keys)\(\s*MeasurementType\b/;
    const roots: Array<[string, number]> = [
      ["src/lib/ai", 250],
      ["src/lib/insights", 140],
      ["src/lib/mcp", 40],
      ["src/lib/daily", 12],
      ["src/lib/jobs", 200],
    ];
    const hits = new Map<string, string>();
    for (const [dir, floor] of roots) {
      for (const [rel, text] of readSourceFolder(dir, {
        floor,
        include: (path) => !path.includes("__tests__"),
      })) {
        if (ALL_TYPES.test(text)) hits.set(`${dir}/${rel}`, text);
      }
    }
    // The matcher found the one reader known today; an empty set would mean
    // the matcher went blind, not that the readers went away.
    expect([...hits.keys()]).toContain("src/lib/insights/general-status.ts");
    for (const [path, text] of hits) {
      expect(text, path).toMatch(/isModelVisibleMeasurementType\(/);
    }
  });
});
