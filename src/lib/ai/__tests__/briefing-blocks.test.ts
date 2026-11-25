/**
 * The shared reader of the briefing blocks (#1499). The server gates every
 * generation with it and every reader of a stored payload renders through
 * it, so these cases are what "the card can show it" means on both ends.
 */
import { describe, expect, it } from "vitest";

import {
  briefingRequiredFor,
  gateBriefingBlocks,
  previousRenderableBriefing,
  readDailyBriefing,
  readTrendAnnotations,
} from "../briefing-blocks";
import { dailyBriefingSchema } from "../schema";

const FINDING = {
  tone: "info",
  headline: "Weight steady",
  detail: "Within your usual range.",
  delta: null,
  sourceWindow: "30d",
  sourceMetric: "weight",
};

const SIGNAL = {
  sourceMetric: "weight",
  tone: "good",
  headline: "Weight steady",
  nudge: "Keep weighing in.",
  delta: null,
};

const BRIEFING = {
  paragraph: "Your weight held steady.",
  signalsOfDay: [SIGNAL],
  keyFindings: [FINDING],
};

function valid(candidate: unknown) {
  const read = readDailyBriefing(candidate);
  if (read.state !== "valid") {
    throw new Error(`expected valid, got ${JSON.stringify(read)}`);
  }
  // Whatever the reader repairs, its output is what the schema accepts.
  expect(dailyBriefingSchema.safeParse(read.briefing).success).toBe(true);
  return read;
}

describe("readDailyBriefing", () => {
  it("passes a well-formed briefing through unchanged", () => {
    const read = valid(BRIEFING);
    expect(read.briefing).toEqual(BRIEFING);
    expect(read.repairs).toEqual([]);
  });

  it("reads null and undefined as absent", () => {
    expect(readDailyBriefing(null)).toEqual({ state: "absent" });
    expect(readDailyBriefing(undefined)).toEqual({ state: "absent" });
  });

  it("fills a missing delta with null", () => {
    const { delta: _signalDelta, ...signal } = SIGNAL;
    const { delta: _findingDelta, ...finding } = FINDING;
    const read = valid({
      ...BRIEFING,
      signalsOfDay: [signal],
      keyFindings: [finding],
    });
    expect(read.briefing.signalsOfDay?.[0]?.delta).toBeNull();
    expect(read.briefing.keyFindings[0]?.delta).toBeNull();
    expect(read.repairs).toEqual(
      expect.arrayContaining(["signals-delta-filled", "findings-delta-filled"]),
    );
  });

  it("drops a row with a metric the enum does not know and keeps the rest", () => {
    const read = valid({
      ...BRIEFING,
      signalsOfDay: [{ ...SIGNAL, sourceMetric: "glucose" }, SIGNAL],
    });
    expect(read.briefing.signalsOfDay).toEqual([SIGNAL]);
    expect(read.repairs).toContain("signals-dropped");
  });

  it("keeps the first rows of a list over its cap", () => {
    const read = valid({
      ...BRIEFING,
      signalsOfDay: [SIGNAL, SIGNAL, SIGNAL, SIGNAL],
      keyFindings: Array.from({ length: 6 }, () => FINDING),
    });
    expect(read.briefing.signalsOfDay).toHaveLength(3);
    expect(read.briefing.keyFindings).toHaveLength(5);
    expect(read.repairs).toEqual(
      expect.arrayContaining(["signals-capped", "findings-capped"]),
    );
  });

  it("reads a missing keyFindings list as empty", () => {
    const read = valid({ paragraph: "Quiet day." });
    expect(read.briefing.keyFindings).toEqual([]);
    expect(read.repairs).toContain("findings-defaulted");
  });

  it("keeps a key the schema does not know", () => {
    const read = valid({ ...BRIEFING, opener: "Morning." });
    expect(read.briefing).toMatchObject({ opener: "Morning." });
  });

  it("refuses what it cannot repair", () => {
    for (const candidate of [
      "a paragraph",
      [BRIEFING],
      { ...BRIEFING, paragraph: "" },
      { ...BRIEFING, paragraph: undefined },
      { ...BRIEFING, keyFindings: "steady" },
      { ...BRIEFING, signalsOfDay: { weight: SIGNAL } },
    ]) {
      expect(readDailyBriefing(candidate).state).toBe("invalid");
    }
  });
});

describe("readTrendAnnotations", () => {
  it("keeps the annotations that pass and drops the ones that do not", () => {
    expect(
      readTrendAnnotations({
        weight: "Flat.",
        bp: "",
        mood: "x".repeat(201),
        sleep: 7,
        unknown: "Ignored.",
      }),
    ).toEqual({ weight: "Flat." });
  });

  it("is null when nothing usable is left", () => {
    expect(readTrendAnnotations(null)).toBeNull();
    expect(readTrendAnnotations(["Flat."])).toBeNull();
    expect(readTrendAnnotations({ bp: "" })).toBeNull();
  });
});

describe("gateBriefingBlocks", () => {
  it("hands back the briefing as the card renders it", () => {
    const { delta: _delta, ...signal } = SIGNAL;
    const gated = gateBriefingBlocks(
      { summary: "s", dailyBriefing: { ...BRIEFING, signalsOfDay: [signal] } },
      { briefingRequired: true },
    );
    expect(gated).toMatchObject({
      ok: true,
      insights: { summary: "s", dailyBriefing: BRIEFING },
    });
  });

  it("refuses an unreadable briefing whether or not one was required", () => {
    for (const briefingRequired of [true, false]) {
      expect(
        gateBriefingBlocks(
          { dailyBriefing: { keyFindings: [] } },
          { briefingRequired },
        ).ok,
      ).toBe(false);
    }
  });

  it("refuses an absent briefing only when one was required", () => {
    expect(gateBriefingBlocks({}, { briefingRequired: false }).ok).toBe(true);
    expect(gateBriefingBlocks({}, { briefingRequired: true }).ok).toBe(false);
  });

  it("requires a briefing exactly when the snapshot had signals", () => {
    expect(briefingRequiredFor(null)).toBe(false);
    expect(briefingRequiredFor([])).toBe(false);
    expect(briefingRequiredFor([{}])).toBe(true);
  });
});

describe("previousRenderableBriefing", () => {
  it("stands in only with a briefing that renders", () => {
    expect(
      previousRenderableBriefing(JSON.stringify({ dailyBriefing: BRIEFING })),
    ).toEqual(BRIEFING);
    expect(
      previousRenderableBriefing(
        JSON.stringify({ dailyBriefing: { keyFindings: [] } }),
      ),
    ).toBeNull();
    expect(previousRenderableBriefing("not json")).toBeNull();
    expect(previousRenderableBriefing(null)).toBeNull();
  });
});
