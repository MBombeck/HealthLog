/**
 * The person's Coach exclusions hold for `get_day` too.
 *
 * Every other Coach read narrows by `coachExclusions` (the snapshot, every
 * table tool, a stored table shown again). `get_day` reads through the day
 * loader, not the snapshot, and for its first release it ignored the
 * exclusions: a person who kept their mood or their medications from the
 * Coach had both sent to the model as soon as it asked for one day.
 *
 * This guard runs `get_day` through the real executor once per exclusion
 * token, with a loader that answers a day holding every section and a value
 * for every mapped measurement type, and checks three things per token:
 *
 *   - the loader was not asked for the sections the token covers
 *     (`DAY_EXCLUSIONS_BY_TOKEN`), so their rows are not even read;
 *   - none of the token's sections and none of its measurement types
 *     (`COACH_SOURCE_MEASUREMENT_TYPES`, every `SLEEP_*` type for `sleep`)
 *     reaches the model;
 *   - something the token does not cover still does, so the guard cannot go
 *     green by returning nothing.
 *
 * A token added to the exclusion enum without an entry in
 * `DAY_EXCLUSIONS_BY_TOKEN` does not compile; a token that covers nothing in
 * a day must be named in `NOTHING_IN_A_DAY` below with the reason.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DayResponse, DaySectionKey } from "@/lib/day/contract";
import { DAY_SCORE_KEYS, DAY_SECTION_KEYS } from "@/lib/day/contract";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import type { CoachScopeSource } from "@/lib/ai/coach/types";
import {
  coachExcludeMetricEnum,
  type CoachExcludeMetric,
} from "@/lib/validations/coach-prefs";

const state = vi.hoisted(() => ({
  excluded: new Set<string>(),
  askedFor: null as Set<string> | null,
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: async () => "UTC",
}));
vi.mock("@/lib/ai/coach/history-reach-read", () => ({
  readCoachExclusions: async () => state.excluded,
}));
vi.mock("@/lib/day/sections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/day/sections")>();
  return {
    ...actual,
    resolveDayAccess: async () => ({
      readable: new Set(DAY_SECTION_KEYS),
      moduleOff: [],
      modules: {},
    }),
  };
});
vi.mock("@/lib/day/load-day", () => ({
  loadDay: async (args: { access: { readable: Set<string> } }) => {
    state.askedFor = new Set(args.access.readable);
    return fullDay(args.access.readable);
  },
}));

import { executeCoachTool } from "@/lib/ai/coach/tools/executor";
import {
  DAY_EXCLUSIONS_BY_TOKEN,
  DAY_SCORE_EXCLUSIONS_BY_TOKEN,
} from "@/lib/ai/coach/tools/day-read";

/** Tokens that cover nothing a day holds, and why. */
const NOTHING_IN_A_DAY: Partial<Record<CoachExcludeMetric, string>> = {
  anthropometrics: "height, age and gender are not part of a day",
};

const ALL_TYPES = [
  ...new Set([
    ...Object.values(COACH_SOURCE_MEASUREMENT_TYPES).flat(),
    "SLEEP_SCORE",
    "SLEEP_EFFICIENCY",
  ]),
];

/** A day with an event in every section the loader was asked for. */
function fullDay(readable: Set<string>): DayResponse {
  const sections = DAY_SECTION_KEYS.filter((s) => readable.has(s));
  return {
    date: "2026-10-01",
    tz: "UTC",
    counts: { values: ALL_TYPES.length, entries: sections.length },
    running: [],
    values: ALL_TYPES.map((type) => ({
      type,
      value: 1,
      unit: "u",
      at: "2026-10-01T08:00:00.000Z",
      source: "MANUAL",
      band: null,
    })),
    events: sections.map((section) => ({
      at: null,
      kind: "symptom" as const,
      section: section as DaySectionKey,
      id: `e-${section}`,
      title: `title-of-${section}`,
      meta: null,
      note: null,
      docs: [],
      href: null,
    })),
    notable: ALL_TYPES.map((type) => ({
      kind: "firstValue" as const,
      type,
      params: {},
    })),
    scores: readable.has("scores")
      ? DAY_SCORE_KEYS.map((key) => ({
          key,
          value: 50,
          max: 100,
          source: "COMPUTED",
          band: null,
        }))
      : [],
    sections: {},
  };
}

function typesFor(token: CoachExcludeMetric): string[] {
  const types: string[] = [
    ...(COACH_SOURCE_MEASUREMENT_TYPES[token as CoachScopeSource] ?? []),
  ];
  if (token === "sleep") {
    types.push(...ALL_TYPES.filter((t) => t.startsWith("SLEEP_")));
  }
  return types;
}

async function getDay(): Promise<Record<string, unknown>> {
  const result = await executeCoachTool({
    userId: "u1",
    name: "get_day",
    rawArguments: JSON.stringify({ date: "2026-10-01" }),
    fallbackWindow: "allTime",
    reach: { window: "allTime", days: null },
  });
  expect(result.present).toBe(true);
  return result.data as Record<string, unknown>;
}

describe("get_day honours the person's Coach exclusions", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      now: new Date("2026-10-04T12:00:00Z"),
      toFake: ["Date"],
    });
    state.askedFor = null;
  });

  it("names every exclusion token: each covers something, or says why not", () => {
    for (const token of coachExcludeMetricEnum.options) {
      const covers =
        DAY_EXCLUSIONS_BY_TOKEN[token].length > 0 || typesFor(token).length > 0;
      expect(covers || NOTHING_IN_A_DAY[token] !== undefined, token).toBe(true);
    }
  });

  for (const token of coachExcludeMetricEnum.options) {
    it(`leaves out everything "${token}" covers`, async () => {
      state.excluded = new Set([token]);
      const data = await getDay();
      const text = JSON.stringify(data);

      for (const section of DAY_EXCLUSIONS_BY_TOKEN[token]) {
        expect(state.askedFor?.has(section), section).toBe(false);
        expect(text).not.toContain(`title-of-${section}`);
      }
      const values = data.values as Array<{ type: string }>;
      const notable = data.notable as Array<{ type: string | null }>;
      for (const type of typesFor(token)) {
        expect(values.map((v) => v.type)).not.toContain(type);
        expect(notable.map((n) => n.type)).not.toContain(type);
      }
      const scores = (data.scores as Array<{ score: string }>).map(
        (s) => s.score,
      );
      for (const score of DAY_SCORE_EXCLUSIONS_BY_TOKEN[token]) {
        expect(scores, score).not.toContain(score);
      }
      // What the token does not cover still arrives.
      expect(text).toContain("title-of-labs");
      expect(values.length).toBeGreaterThan(0);
      expect(scores.length).toBe(
        DAY_SCORE_KEYS.length - DAY_SCORE_EXCLUSIONS_BY_TOKEN[token].length,
      );
    });
  }

  it("reads everything when nothing is excluded", async () => {
    state.excluded = new Set();
    const data = await getDay();
    expect(JSON.stringify(data)).toContain("title-of-mood");
    expect((data.values as unknown[]).length).toBe(ALL_TYPES.length);
    expect((data.scores as unknown[]).length).toBe(DAY_SCORE_KEYS.length);
  });
});
