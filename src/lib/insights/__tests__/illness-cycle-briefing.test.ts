import { describe, it, expect, vi, beforeEach } from "vitest";

const buildIllnessSnapshotBlock = vi.fn();
const buildCycleSnapshotBlock = vi.fn();
const isCycleAvailableForUser = vi.fn();

vi.mock("@/lib/ai/coach/illness-snapshot", () => ({
  buildIllnessSnapshotBlock: (...a: unknown[]) =>
    buildIllnessSnapshotBlock(...a),
}));
vi.mock("@/lib/ai/coach/cycle-snapshot", () => ({
  buildCycleSnapshotBlock: (...a: unknown[]) => buildCycleSnapshotBlock(...a),
}));
vi.mock("@/lib/cycle/gate", () => ({
  isCycleAvailableForUser: (...a: unknown[]) => isCycleAvailableForUser(...a),
}));

import {
  buildBriefingIllnessCycleContext,
  buildBriefingIllnessCyclePrompt,
} from "@/lib/insights/illness-cycle-briefing";

beforeEach(() => {
  vi.clearAllMocks();
  isCycleAvailableForUser.mockResolvedValue(false);
  buildIllnessSnapshotBlock.mockResolvedValue(null);
  buildCycleSnapshotBlock.mockResolvedValue(null);
});

describe("buildBriefingIllnessCycleContext", () => {
  it("returns null when neither module surfaces anything", async () => {
    const ctx = await buildBriefingIllnessCycleContext("u1", null, "UTC");
    expect(ctx).toBeNull();
    // Cycle disabled → cycle builder never queried.
    expect(buildCycleSnapshotBlock).not.toHaveBeenCalled();
  });

  it("skips the cycle builder when the module is off but keeps illness", async () => {
    buildIllnessSnapshotBlock.mockResolvedValue({
      restMode: true,
      active: [
        { label: "Flu", type: "ACUTE", lifecycle: "ACTIVE", onsetAt: "x" },
      ],
      recentResolved: [],
    });
    const ctx = await buildBriefingIllnessCycleContext("u1", null, "UTC");
    expect(ctx).not.toBeNull();
    expect(ctx?.illness?.restMode).toBe(true);
    expect(ctx?.cycle).toBeNull();
    expect(buildCycleSnapshotBlock).not.toHaveBeenCalled();
  });

  it("queries the cycle builder when the module is on", async () => {
    isCycleAvailableForUser.mockResolvedValue(true);
    buildCycleSnapshotBlock.mockResolvedValue({
      phase: "LUTEAL",
      dayOfCycle: 22,
      goal: "GENERAL",
      cyclesObserved: 3,
      nextEvent: null,
      phaseInsight: null,
    });
    const ctx = await buildBriefingIllnessCycleContext("u1", "FEMALE", "UTC");
    expect(ctx?.cycle?.phase).toBe("LUTEAL");
  });
});

describe("buildBriefingIllnessCyclePrompt", () => {
  it("emits a Rest Mode line for an active illness", () => {
    const out = buildBriefingIllnessCyclePrompt(
      {
        illness: {
          restMode: true,
          active: [
            { label: "Flu", type: "ACUTE", lifecycle: "ACTIVE", onsetAt: "x" },
          ],
          recentResolved: [],
        },
        cycle: null,
      },
      "en",
    );
    expect(out).toContain("Rest Mode");
    expect(out).toContain("Flu");
    expect(out).toContain("SYSTEM CONTEXT");
  });

  it("names a chronic-only condition as context, not Rest Mode (#1216)", () => {
    const out = buildBriefingIllnessCyclePrompt(
      {
        illness: {
          restMode: false,
          active: [
            {
              label: "Sleep apnoea",
              type: "CHRONIC",
              lifecycle: "CHRONIC_ONGOING",
              onsetAt: "x",
            },
          ],
          recentResolved: [],
        },
        cycle: null,
      },
      "en",
    );
    expect(out).toContain("Sleep apnoea");
    expect(out).toContain("chronic condition");
    expect(out).not.toContain("The user is in Rest Mode");
    expect(out).not.toContain("measure more often");
  });

  it("emits a cycle day/phase line", () => {
    const out = buildBriefingIllnessCyclePrompt(
      {
        illness: null,
        cycle: {
          phase: "FOLLICULAR",
          dayOfCycle: 5,
          goal: "GENERAL",
          cyclesObserved: 2,
          nextEvent: null,
          upcoming: [],
          phaseInsight: null,
        },
      },
      "en",
    );
    expect(out).toContain("day 5");
    expect(out).toContain("FOLLICULAR");
    expect(out).toContain("never causal");
  });

  it("returns the empty string when there is nothing to say", () => {
    const out = buildBriefingIllnessCyclePrompt(
      {
        illness: { restMode: false, active: [], recentResolved: [] },
        cycle: null,
      },
      "en",
    );
    expect(out).toBe("");
  });

  it("localises to German", () => {
    const out = buildBriefingIllnessCyclePrompt(
      {
        illness: null,
        cycle: {
          phase: "LUTEAL",
          dayOfCycle: 20,
          goal: "GENERAL",
          cyclesObserved: 4,
          nextEvent: null,
          upcoming: [],
          phaseInsight: null,
        },
      },
      "de",
    );
    expect(out).toContain("Zyklus");
    expect(out).toContain("Tag 20");
  });
});
