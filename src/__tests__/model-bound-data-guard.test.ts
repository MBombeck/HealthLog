/**
 * The mental-wellbeing page promises that questionnaire answers and scores
 * never reach the Coach, another AI feature or a connected AI assistant.
 * This file binds that sentence to the one classification that keeps it
 * (`src/lib/ai/model-bound-data.ts`) and to the exits that apply it.
 *
 * The end-to-end proof against a real record, every MCP read and every
 * Coach read included, is `tests/integration/questionnaires-stay-out-of-models.test.ts`.
 */
import { describe, expect, it } from "vitest";

import en from "../../messages/en.json";
import {
  isModelVisibleMeasurementType,
  MODEL_EXCLUDED_MEASUREMENT_TYPES,
  MODEL_EXCLUDED_SECTIONS,
  withoutModelBoundExclusions,
} from "@/lib/ai/model-bound-data";
import { isModelVisibleSection } from "@/lib/day/model-projection";
import {
  INSTRUMENT_MEASUREMENT_TYPE,
  INSTRUMENT_ORDER,
} from "@/lib/mental-health/instruments";
import { getSignal } from "@/lib/signals/registry";

import { readSource, readSourceFolder } from "./helpers/source-files";

describe("the questionnaire promise", () => {
  it("is still the sentence this guard holds", () => {
    // Changing the sentence means re-reading what it promises against the
    // classification below.
    expect(en.mentalHealth.privacyNote).toMatch(
      /Answers and scores never reach the AI Coach, any other AI feature or an AI assistant you connected\./,
    );
  });

  it("covers every instrument on the page, by its section and its score", () => {
    expect(isModelVisibleSection("assessments")).toBe(false);
    expect(MODEL_EXCLUDED_SECTIONS.has("assessments")).toBe(true);
    for (const instrument of INSTRUMENT_ORDER) {
      const type = INSTRUMENT_MEASUREMENT_TYPE[instrument];
      expect(isModelVisibleMeasurementType(type), type).toBe(false);
      // The signal registry says the same for every surface it governs.
      const signal = getSignal(type);
      expect(signal, type).toBeDefined();
      expect(signal!.surfaces.coachSnapshot, type).toBe(false);
      expect(signal!.surfaces.mcp, type).toBe(false);
      expect(signal!.surfaces.correlationEligible, type).toBe(false);
    }
    expect(MODEL_EXCLUDED_MEASUREMENT_TYPES.size).toBe(INSTRUMENT_ORDER.length);
  });
});

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
