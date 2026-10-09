/**
 * v1.20.0 (F1) — Coach retrieval tool executor: dispatch, grounding, and the
 * gate-preservation contract. The executor must NEVER throw and must return a
 * structured `{ present: false }` for an absent domain — the hallucination
 * audit asserts the model can always tell "no data" from "data".
 */
import { DEFAULT_UNIT_PREFERENCES } from "@/lib/measurements/display-transform";
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { CoachSnapshotResult } from "@/lib/ai/coach/snapshot";

const buildCoachSnapshot =
  vi.fn<(userId: string, scope?: unknown) => Promise<CoachSnapshotResult>>();

vi.mock("@/lib/ai/coach/snapshot", () => ({
  buildCoachSnapshot: (userId: string, scope?: unknown) =>
    buildCoachSnapshot(userId, scope),
}));

// v1.33.0 (#648) — an empty window read is no longer reported as absence until
// the availability probe has confirmed the record is empty. Stub the probe's
// reads to "nothing stored", which is what these dispatch assertions mean by an
// absent section; `coach-availability-window-honesty.test.ts` owns the other
// three states.
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { groupBy: () => Promise.resolve([]) },
    workout: { aggregate: () => Promise.resolve(emptyAggregate()) },
    moodEntry: { aggregate: () => Promise.resolve(emptyAggregate()) },
    medicationIntakeEvent: {
      aggregate: () => Promise.resolve(emptyAggregate()),
    },
    labResult: { aggregate: () => Promise.resolve(emptyAggregate()) },
  },
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: () => Promise.resolve("UTC"),
}));

function emptyAggregate() {
  return {
    _count: { _all: 0 },
    _min: {
      startedAt: null,
      moodLoggedAt: null,
      scheduledFor: null,
      takenAt: null,
    },
    _max: {
      startedAt: null,
      moodLoggedAt: null,
      scheduledFor: null,
      takenAt: null,
    },
  };
}

const readCoachCorrelations = vi.fn();
vi.mock("@/lib/ai/coach/tools/correlations-read", () => ({
  readCoachCorrelations: (userId: string, locale: string) =>
    readCoachCorrelations(userId, locale),
}));

// The executor asks for the account's language before it asks for a narrated
// correlation, so the sentences it hands the model are not silently English.
const resolveLocaleForUser = vi.fn(async (_userId: string) => "de");
vi.mock("@/lib/i18n/user-locale", () => ({
  resolveLocaleForUser: (userId: string) => resolveLocaleForUser(userId),
}));

// v1.21.0 (NEW-B B-2) — the illness-recovery tool augments its snapshot blocks
// with the computed retrospective scores. Mock the read-only engine wrapper so
// the executor test stays a pure dispatch test.
const buildIllnessScores = vi.fn();
vi.mock("@/lib/ai/coach/illness-snapshot", () => ({
  buildIllnessScores: (userId: string) => buildIllnessScores(userId),
}));

import { executeCoachTool } from "@/lib/ai/coach/tools/executor";

function snapshot(
  sections: Record<string, unknown>,
  referenceGrounding: string | null = null,
): CoachSnapshotResult {
  return {
    snapshotJson: JSON.stringify(sections),
    sections,
    provenance: { windows: [], metrics: [] },
    referenceGrounding,
    units: DEFAULT_UNIT_PREFERENCES,
  };
}

describe("executeCoachTool", () => {
  beforeEach(() => {
    buildCoachSnapshot.mockReset();
    readCoachCorrelations.mockReset();
    buildIllnessScores.mockReset();
    buildIllnessScores.mockResolvedValue(null);
  });

  it("returns the matching section for get_metric_series when present", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot(
        { bloodPressure: { aggregate: { avgSys30: 128 } } },
        "REFERENCE GROUNDING\nBP systolic 128 …",
      ),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "bp" }),
    });
    expect(result.present).toBe(true);
    expect(result.data).toMatchObject({
      metric: "bp",
      section: { aggregate: { avgSys30: 128 } },
    });
    expect(result.grounding).toContain("REFERENCE GROUNDING");
  });

  it("returns { present: false } (never throws) when the section is absent", async () => {
    buildCoachSnapshot.mockResolvedValue(snapshot({}));
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "hrv" }),
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_data");
    expect(result.data).toBeUndefined();
  });

  it("points get_metric_series(glucose) at the dedicated tool", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "glucose" }),
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("use_get_glucose_panel");
    // Must not even read the snapshot for a wrong-tool call.
    expect(buildCoachSnapshot).not.toHaveBeenCalled();
  });

  it("rejects invalid arguments with a grounded miss, not a throw", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "not_a_metric" }),
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("invalid_arguments");
  });

  it("rejects malformed JSON arguments with a grounded miss", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: "{not json",
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("invalid_arguments");
  });

  it("rejects an unknown tool name without throwing", async () => {
    const result = await executeCoachTool({
      userId: "u1",
      name: "drop_table_users",
      rawArguments: "{}",
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("unknown_tool");
    expect(buildCoachSnapshot).not.toHaveBeenCalled();
  });

  it("degrades a snapshot-builder throw to { present: false }", async () => {
    buildCoachSnapshot.mockRejectedValue(new Error("db down"));
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_glucose_panel",
      rawArguments: "{}",
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("retrieval_failed");
  });

  it("combines sleep nights + rhythm sections", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({
        sleep: { timeline: { recent: [] } },
        sleepRhythm: { sleepDebt: 120, chronotype: "intermediate" },
      }),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_sleep",
      rawArguments: "{}",
    });
    expect(result.present).toBe(true);
    expect(result.data).toMatchObject({
      nights: { timeline: { recent: [] } },
      rhythm: { sleepDebt: 120 },
    });
  });

  it("surfaces glp1 from weeklyContext on get_medication_compliance", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({
        compliance: { rate: 0.92 },
        weeklyContext: { glp1: { drug: "—", dose: "—" } },
      }),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_medication_compliance",
      rawArguments: "{}",
    });
    expect(result.present).toBe(true);
    expect(result.data).toMatchObject({
      compliance: { rate: 0.92 },
      glp1: { drug: "—" },
    });
  });

  it("filters labs by analyte and reports analyte_not_found", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({
        labs: { recent: [{ name: "LDL", value: "120" }] },
      }),
    );
    const hit = await executeCoachTool({
      userId: "u1",
      name: "get_labs",
      rawArguments: JSON.stringify({ analyte: "ldl" }),
    });
    expect(hit.present).toBe(true);
    expect(hit.data).toMatchObject({ recent: [{ name: "LDL" }] });

    const miss = await executeCoachTool({
      userId: "u1",
      name: "get_labs",
      rawArguments: JSON.stringify({ analyte: "glucose" }),
    });
    expect(miss.present).toBe(false);
    expect(miss.reason).toBe("analyte_not_found");
  });

  // v1.21.0 (NEW-A) — labs must reach the Coach with their value AND unit so it
  // can cite the reading, not just name the biomarker. The snapshot labs block
  // already carries { analyte, value, unit, rangeStatus, … }; the tool passes
  // it through verbatim. This guards that the value + unit survive the tool.
  it("get_labs carries each reading's value and unit (citation guarantee)", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({
        labs: {
          recent: [
            {
              analyte: "LDL",
              value: 120,
              unit: "mg/dL",
              rangeStatus: "above",
              referenceLow: null,
              referenceHigh: 116,
              takenAt: "2026-06-01T00:00:00.000Z",
            },
          ],
        },
      }),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_labs",
      rawArguments: "{}",
    });
    expect(result.present).toBe(true);
    const data = result.data as {
      recent: Array<{ value: number; unit: string; rangeStatus: string }>;
    };
    expect(data.recent[0]).toMatchObject({
      analyte: "LDL",
      value: 120,
      unit: "mg/dL",
      rangeStatus: "above",
    });
  });

  it("returns the workouts section for get_workouts when present", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({ workouts: { recent: [{ sport: "RUN" }], totalInWindow: 3 } }),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_workouts",
      rawArguments: JSON.stringify({ window: "last30days" }),
    });
    expect(result.present).toBe(true);
    expect(result.data).toMatchObject({ totalInWindow: 3 });
  });

  it("returns { present: false } for get_workouts when no block", async () => {
    buildCoachSnapshot.mockResolvedValue(snapshot({}));
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_workouts",
      rawArguments: "{}",
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_data");
  });

  it("returns the cycle section for get_cycle when present", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({ cycle: { phase: "luteal", dayOfCycle: 21 } }),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_cycle",
      rawArguments: "{}",
    });
    expect(result.present).toBe(true);
    expect(result.data).toMatchObject({ phase: "luteal" });
  });

  it("returns { present: false } for get_cycle when cycle tracking is off", async () => {
    // A non-cycle account produces no cycle block (gated in the builder).
    buildCoachSnapshot.mockResolvedValue(snapshot({}));
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_cycle",
      rawArguments: "{}",
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_data");
  });

  it("surfaces discovered drivers + coincident flag for get_correlations", async () => {
    readCoachCorrelations.mockResolvedValue({
      present: true,
      drivers: [
        {
          behaviour: "time in daylight",
          outcome: "sleep duration",
          direction: "higher",
          lagDays: 1,
          n: 42,
          r: 0.31,
          note: "Higher time in daylight tends to go with higher next-day sleep duration in your data. It is a pattern to watch, not a cause.",
        },
      ],
      coincident: {
        fired: false,
        contributing: [],
        day: "2026-06-02",
        illnessExplained: false,
      },
      pairsTested: 18,
      windowDays: 180,
    });
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_correlations",
      rawArguments: "{}",
    });
    expect(result.present).toBe(true);
    expect(result.data).toMatchObject({
      drivers: [{ behaviour: "time in daylight", n: 42 }],
      pairsTested: 18,
    });
    // The account's language reached the reader — the notes are finished
    // sentences, and an MCP client shows some of them as they stand.
    expect(readCoachCorrelations).toHaveBeenCalledWith("u1", "de");
  });

  it("returns a clean { present: false } for get_correlations on no pattern", async () => {
    readCoachCorrelations.mockResolvedValue({
      present: false,
      reason: "no_significant_pattern",
    });
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_correlations",
      rawArguments: "{}",
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_significant_pattern");
  });

  it("never passes userId as a tool argument (read from session only)", async () => {
    buildCoachSnapshot.mockResolvedValue(snapshot({}));
    // A crafted argument trying to smuggle a userId must be rejected by the
    // strict schema, never forwarded to the read.
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "bp", userId: "victim" }),
    });
    expect(result.present).toBe(false);
    expect(result.reason).toBe("invalid_arguments");
  });

  // v1.21.0 (NEW-B B-2) — get_illness_recovery now carries the computed
  // retrospective scores the illness card shows (recovery-gap, gap-driver,
  // nadir, pre-onset, red flags), not just labels + composites.
  it("get_illness_recovery surfaces the computed illness scores", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({ illness: { restMode: true, active: [], recentResolved: [] } }),
    );
    buildIllnessScores.mockResolvedValue({
      episodeLabel: "flu",
      episodeType: "INFECTION",
      state: "resolved",
      recoveryGapDays: 4,
      gapDriverType: "RESTING_HEART_RATE",
      nadir: [
        {
          type: "HEART_RATE_VARIABILITY",
          day: "2026-06-10",
          deviationSd: -2.4,
          direction: "below",
        },
      ],
      preOnset: [],
      redFlags: [
        {
          type: "BODY_TEMPERATURE",
          reason: "sustained_fever",
          worstValue: 38.9,
          days: 3,
        },
      ],
    });
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_illness_recovery",
      rawArguments: "{}",
    });
    expect(result.present).toBe(true);
    const data = result.data as { illnessScores?: Record<string, unknown> };
    expect(data.illnessScores).toMatchObject({
      recoveryGapDays: 4,
      gapDriverType: "RESTING_HEART_RATE",
    });
    expect(data.illnessScores?.redFlags).toHaveLength(1);
    expect(data.illnessScores?.nadir).toHaveLength(1);
  });

  it("get_illness_recovery is present on scores alone (no derived blocks)", async () => {
    // No illness/derived/strain/trajectory section, but the engine returned
    // scores → the tool must still report present and carry them.
    buildCoachSnapshot.mockResolvedValue(snapshot({}));
    buildIllnessScores.mockResolvedValue({
      episodeLabel: "cold",
      episodeType: "INFECTION",
      state: "active",
      recoveryGapDays: null,
      gapDriverType: null,
      nadir: [],
      preOnset: [],
      redFlags: [],
    });
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_illness_recovery",
      rawArguments: "{}",
    });
    expect(result.present).toBe(true);
    expect(
      (result.data as { illnessScores?: unknown }).illnessScores,
    ).toBeTruthy();
  });
});

// v1.21.0 (D5-1) — ONE snapshot per turn. When the route threads the shared
// full-source scope (the inventory's probe scope) and the tool's window
// matches, the tool must read under the SHARED scope key so every per-tool read
// lands the inventory's already-built 60s LRU entry — rather than rebuilding a
// distinct single-source snapshot per tool.
describe("executeCoachTool — shared snapshot scope (D5-1)", () => {
  beforeEach(() => {
    buildCoachSnapshot.mockReset();
  });

  const sharedScope = {
    sources: ["bp", "hrv", "sleep", "glucose"] as never,
    window: "last30days" as const,
  };

  it("reads under the shared scope when the tool window matches", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({ bloodPressure: { aggregate: { avgSys30: 128 } } }),
    );
    const result = await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "bp" }),
      fallbackWindow: "last30days",
      sharedScope,
    });
    expect(result.present).toBe(true);
    // The read used the SHARED scope object, not a narrow single-source scope —
    // so a second tool with the same shared scope hits the same cache key.
    expect(buildCoachSnapshot).toHaveBeenCalledWith("u1", sharedScope);
  });

  it("two tools in a turn read under the SAME scope key (one build)", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({
        bloodPressure: { aggregate: {} },
        heartRateVariability: { aggregate: {} },
      }),
    );
    await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "bp" }),
      fallbackWindow: "last30days",
      sharedScope,
    });
    await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      rawArguments: JSON.stringify({ metric: "hrv" }),
      fallbackWindow: "last30days",
      sharedScope,
    });
    // Both reads used the identical shared scope object → identical cache key.
    const scopes = buildCoachSnapshot.mock.calls.map((c) => c[1]);
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).toBe(sharedScope);
    expect(scopes[1]).toBe(sharedScope);
  });

  it("falls back to a narrow scope when the tool overrides the window", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({ bloodPressure: { aggregate: {} } }),
    );
    await executeCoachTool({
      userId: "u1",
      name: "get_metric_series",
      // The model overrides the window → a distinct, correct build.
      rawArguments: JSON.stringify({ metric: "bp", window: "last7days" }),
      fallbackWindow: "last30days",
      sharedScope,
    });
    expect(buildCoachSnapshot).toHaveBeenCalledWith("u1", {
      sources: ["bp"],
      window: "last7days",
    });
  });
});
