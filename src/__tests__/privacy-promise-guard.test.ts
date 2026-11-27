/**
 * Every sentence in the app that promises some data stays away from the
 * Coach, the briefings or another AI feature is bound here to the rule that
 * keeps it.
 *
 * The mental-wellbeing page said "never reach the AI Coach" while the day
 * read handed every questionnaire to the Coach: the sentence and the
 * behaviour came from two places and nothing tied them together. So the
 * English bundle is scanned for that kind of sentence, every hit must be
 * registered below, and every registered sentence carries a check against
 * the code that makes it true. A new promise without a check fails the scan;
 * a check whose sentence was reworded away fails the registry.
 *
 * Most checks call the rule itself (`isModelVisibleSection`, the model-bound
 * health score, the Coach exclusions, the lookback floor). Two point at the
 * test that already exercises the rule on its prompt path, by the exact test
 * title, so deleting or renaming that test fails here.
 */
import { describe, expect, it } from "vitest";

import en from "../../messages/en.json";
import {
  isModelVisibleMeasurementType,
  MODEL_EXCLUDED_MEASUREMENT_TYPES,
  MODEL_EXCLUDED_SCORE_PILLARS,
  MODEL_EXCLUDED_SECTIONS,
} from "@/lib/ai/model-bound-data";
import { reachFloor } from "@/lib/ai/coach/history-reach";
import { dayExclusionsFor } from "@/lib/ai/coach/tools/day-read";
import {
  countsModelExcludedPillar,
  modelBoundComposite,
} from "@/lib/analytics/score/model-bound";
import { SCORE_PILLAR_IDS } from "@/lib/analytics/score/types";
import { isModelVisibleSection } from "@/lib/day/model-projection";
import { buildEvidence } from "@/lib/jobs/reaction-line-evidence";
import {
  INSTRUMENT_MEASUREMENT_TYPE,
  INSTRUMENT_ORDER,
} from "@/lib/mental-health/instruments";
import { getSignal } from "@/lib/signals/registry";
import { coachExcludeMetricEnum } from "@/lib/validations/coach-prefs";

import { readSource, readSourceFolder } from "./helpers/source-files";

/** A sentence that tells the person some data stays away from a model. */
const AI_SUBJECT = /\b(Coach|AI|models?|assistants?|briefings?)\b/;
const PROMISE =
  /\b(never (?:reach|see|read|go|get)e?s?|no AI feature|go(?:es)? to no AI|(?:will not|won't|does not|doesn't|no longer) (?:see|read|reach|get)s?|reads? nothing|stays? out of|kept (?:out of|from))\b/i;

function leaves(
  node: unknown,
  path: string,
  out: Array<[string, string]>,
): Array<[string, string]> {
  if (typeof node === "string") {
    out.push([path, node]);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      leaves(value, path ? `${path}.${key}` : key, out);
    }
  }
  return out;
}

function promiseKeys(): string[] {
  const keys = new Set<string>();
  for (const [key, text] of leaves(en, "", [])) {
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      if (AI_SUBJECT.test(sentence) && PROMISE.test(sentence)) keys.add(key);
    }
  }
  return [...keys].sort();
}

/** A test, by file and exact title, that exercises the rule on its path. */
function provenBy(file: string, title: string): void {
  const source = readSource(file, "describe(");
  expect(source, `${file} lost "${title}"`).toContain(`it("${title}"`);
}

/** Every promise sentence and the check that keeps it true. */
const PROMISES: Record<string, () => void> = {
  // Answers, totals, and the health score's wellbeing pillar, which is the
  // questionnaires under another name.
  // The end-to-end proof against a real record, every MCP read and every
  // Coach read included, is
  // `tests/integration/questionnaires-stay-out-of-models.test.ts`.
  "mentalHealth.privacyNote": () => {
    // Changing the sentence means re-reading what it promises against the
    // classification below.
    expect(en.mentalHealth.privacyNote).toMatch(
      /Answers and scores never reach the AI Coach, any other AI feature or an AI assistant you connected\./,
    );
    expect(isModelVisibleSection("assessments")).toBe(false);
    expect(MODEL_EXCLUDED_SECTIONS.has("assessments")).toBe(true);
    for (const type of Object.values(INSTRUMENT_MEASUREMENT_TYPE)) {
      expect(isModelVisibleMeasurementType(type), type).toBe(false);
    }
    // Every instrument on the page, and the signal registry says the same
    // for every surface it governs.
    for (const instrument of INSTRUMENT_ORDER) {
      const type = INSTRUMENT_MEASUREMENT_TYPE[instrument];
      expect(isModelVisibleMeasurementType(type), type).toBe(false);
      const signal = getSignal(type);
      expect(signal, type).toBeDefined();
      expect(signal!.surfaces.coachSnapshot, type).toBe(false);
      expect(signal!.surfaces.mcp, type).toBe(false);
      expect(signal!.surfaces.correlationEligible, type).toBe(false);
    }
    expect(MODEL_EXCLUDED_MEASUREMENT_TYPES.size).toBe(INSTRUMENT_ORDER.length);
    expect(MODEL_EXCLUDED_SCORE_PILLARS.has("WELLBEING")).toBe(true);
    expect(
      modelBoundComposite({
        composite: 55,
        composition: ["SLEEP", "WELLBEING"],
        pillarScores: { SLEEP: 80, WELLBEING: 30 },
      }),
    ).toBe(80);
    expect(
      modelBoundComposite({
        composite: 30,
        composition: ["WELLBEING"],
        pillarScores: { WELLBEING: 30 },
      }),
    ).toBeNull();
  },
  "lifeEvents.privacy": () => {
    expect(isModelVisibleSection("lifeEvents")).toBe(false);
  },
  // Every exclusion token takes something out of the day the Coach reads.
  "insights.coach.settingsExcludeHint": () => {
    const allTypes = ["WEIGHT", "PULSE", "BLOOD_PRESSURE_SYSTOLIC", "STEPS"];
    for (const token of coachExcludeMetricEnum.options) {
      const out = dayExclusionsFor(new Set([token]), allTypes);
      expect(
        out.sections.size + out.types.size + (out.scores?.size ?? 0),
        token,
      ).toBeGreaterThan(0);
    }
  },
  "insights.coach.lookback.detailDays": () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(
      reachFloor({ window: "last90days", days: 90 }, now)?.toISOString(),
    ).toBe("2026-03-03T00:00:00.000Z");
  },
  "insights.coach.lookback.detailMonths": () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(
      reachFloor({ window: "lastYear", days: 365 }, now)?.toISOString(),
    ).toBe("2025-06-01T00:00:00.000Z");
  },
  // No model path reads a stored route.
  "settings.privacy.workoutRoutes.detail": () => {
    const ROUTE_READ = /\.workoutRoute\b|\broute:\s*(?:true|\{)/;
    const roots: Array<[string, number]> = [
      ["src/lib/ai", 250],
      ["src/lib/insights", 140],
      ["src/lib/mcp", 40],
    ];
    let walked = 0;
    for (const [dir, floor] of roots) {
      for (const [rel, text] of readSourceFolder(dir, {
        floor,
        include: (path) => !path.includes("__tests__"),
      })) {
        walked += 1;
        expect(ROUTE_READ.test(text), `${dir}/${rel}`).toBe(false);
      }
    }
    expect(walked).toBeGreaterThanOrEqual(430);
    // The workout note a model writes reads its evidence from these.
    for (const [file, anchor] of [
      ["src/lib/jobs/workout-insight-generate.ts", "workoutInsight"],
      ["src/lib/workouts/insight-evidence.ts", "export"],
    ] as const) {
      expect(ROUTE_READ.test(readSource(file, anchor)), file).toBe(false);
    }
  },
  "records.life.ai.hint": () =>
    provenBy(
      "src/lib/ai/coach/__tests__/profile-ai-section-gating.test.ts",
      "never decrypts a section without its switch",
    ),
  "records.life.auditC.legacyHint": () =>
    provenBy(
      "src/lib/ai/coach/__tests__/profile-ai-section-gating.test.ts",
      "drops the old alcohol pattern once an AUDIT-C entry exists",
    ),
};

describe("privacy promises in the app's words", () => {
  it("registers every promise sentence the English bundle holds", () => {
    const found = promiseKeys();
    // The scan found the sentences known today; an empty set would mean the
    // matcher went blind, not that the promises went away.
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found).toEqual(Object.keys(PROMISES).sort());
  });

  for (const [key, holds] of Object.entries(PROMISES)) {
    it(`keeps "${key}" true`, () => {
      holds();
    });
  }
});

describe("the health score that reaches a model", () => {
  it("counts no excluded pillar, whatever the composition", () => {
    for (const id of SCORE_PILLAR_IDS) {
      expect(countsModelExcludedPillar([id]), id).toBe(
        MODEL_EXCLUDED_SCORE_PILLARS.has(id),
      );
    }
  });

  it("is the stored composite when no excluded pillar counted", () => {
    expect(
      modelBoundComposite({
        composite: 71,
        composition: ["BLOOD_PRESSURE", "SLEEP"],
        pillarScores: { BLOOD_PRESSURE: 70, SLEEP: 72 },
      }),
    ).toBe(71);
  });

  it("refuses to guess when a counted pillar's score is missing", () => {
    expect(
      modelBoundComposite({
        composite: 60,
        composition: ["BLOOD_PRESSURE", "SLEEP", "WELLBEING"],
        pillarScores: { BLOOD_PRESSURE: 70, WELLBEING: 30 },
      }),
    ).toBeNull();
  });

  it("is read in its model-bound form on every exit to a model", () => {
    // The day the Coach and the MCP endpoint read.
    const dayRead = readSource(
      "src/lib/ai/coach/tools/day-read.ts",
      "readDayForTool",
    );
    expect(dayRead).toMatch(/modelBound: true/);
    const scores = readSource("src/lib/day/scores.ts", "healthScoreOf");
    expect(scores).toMatch(/modelBoundComposite\(/);
    // The arrival line holds the live composite without its pillars.
    const reaction = readSource(
      "src/lib/jobs/reaction-line-evidence.ts",
      "export function buildEvidence",
    );
    expect(reaction).toMatch(/!countsModelExcludedPillar\(/);
    expect(
      readSource("src/lib/jobs/reaction-line.ts", "buildEvidence("),
    ).toMatch(/from "@\/lib\/jobs\/reaction-line-evidence"/);
  });

  it("shows the morning's score from the digest and hands the morning to no model", () => {
    // The ring beside the morning sentence on `/` is the digest's score, the
    // wellbeing pillar included, so it belongs to the person's own view only.
    // The morning read carries no score of its own and reaches no model.
    provenBy(
      "src/__tests__/morning-model-free-guard.test.ts",
      "carries no health score of its own",
    );
    provenBy(
      "src/__tests__/morning-model-free-guard.test.ts",
      "never reaches the reaction-line evidence or the daily push",
    );
  });

  it("leaves the arrival line without a score the questionnaires count in", () => {
    const evidence = (composition?: string[]) =>
      buildEvidence("- A weight of 80 kg arrived.", {
        score: { value: 61, band: "yellow", delta: 2, composition },
        topSignal: null,
        briefingLead: null,
      });
    expect(evidence(["SLEEP", "ACTIVITY"])).toContain("Health score: 61");
    expect(evidence(["SLEEP", "WELLBEING"])).not.toContain("Health score");
    expect(evidence(undefined)).not.toContain("Health score");
  });

  it("has no other reader of the stored score on a path to a model", () => {
    // Every reader of the stored days, each with what it feeds. A new one
    // must say whether it reaches a model before it lands.
    const READERS: Record<string, string> = {
      "src/lib/analytics/score/reader.ts":
        "the composition note on the person's score card",
      "src/lib/day/scores.ts": "model-bound under `modelBound`",
      "src/lib/daily/load-digest.ts":
        "the person's digest; the arrival line filters its score",
      "src/lib/export/health-score-backup.ts": "the person's backup",
      "src/lib/insights/score-history.ts": "the person's history chart",
    };
    const found: string[] = [];
    for (const [dir, floor] of [
      ["src/lib", 1500],
      ["src/app", 500],
    ] as const) {
      for (const [rel, text] of readSourceFolder(dir, {
        floor,
        include: (path) =>
          !path.includes("__tests__") && !path.startsWith("generated/"),
      })) {
        if (/\.healthScoreRecord\.find/.test(text)) found.push(`${dir}/${rel}`);
      }
    }
    expect(found.sort()).toEqual(Object.keys(READERS).sort());
  });
});
