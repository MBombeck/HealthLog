import { describe, it, expect } from "vitest";

import {
  LAID_OUT_STAGE_ORDER,
  reconstructContiguousSleepTimeline,
} from "../reconstruct-timeline";
import { hasStageTimeline } from "../stage-timeline";

describe("reconstructContiguousSleepTimeline", () => {
  const onset = Date.parse("2026-06-09T21:00:00.000Z");
  const end = Date.parse("2026-06-10T05:00:00.000Z");

  it("lays stages contiguously from onset, each ending at its own instant", () => {
    const rows = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [
        { durationMs: 60 * 60_000, stage: "CORE", fieldTag: "sleep_core" },
        { durationMs: 30 * 60_000, stage: "DEEP", fieldTag: "sleep_deep" },
        { durationMs: 90 * 60_000, stage: "REM", fieldTag: "sleep_rem" },
      ],
      externalIdFor: (tag) => `night:seg:${tag}`,
    });
    const core = rows.find((r) => r.sleepStage === "CORE")!;
    const deep = rows.find((r) => r.sleepStage === "DEEP")!;
    const rem = rows.find((r) => r.sleepStage === "REM")!;
    expect(core.value).toBe(60);
    expect(core.measuredAt.getTime()).toBe(onset + 60 * 60_000);
    expect(deep.measuredAt.getTime()).toBe(onset + 90 * 60_000);
    expect(rem.measuredAt.getTime()).toBe(onset + 180 * 60_000);
    // Distinct instants → ordered hypnogram, not a shared right edge.
    expect(new Set(rows.map((r) => r.measuredAt.getTime())).size).toBe(3);
  });

  it("flags every laid segment reconstructed and keys a stage-tagged externalId", () => {
    const rows = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [
        { durationMs: 15 * 60_000, stage: "AWAKE", fieldTag: "sleep_awake" },
        { durationMs: 60 * 60_000, stage: "CORE", fieldTag: "sleep_core" },
      ],
      externalIdFor: (tag) => `night:seg:${tag}`,
    });
    expect(rows.every((r) => r.reconstructed === true)).toBe(true);
    expect(rows[0].externalId).toBe("night:seg:sleep_awake");
    expect(rows[1].externalId).toBe("night:seg:sleep_core");
  });

  it("skips non-positive, null, undefined and non-finite durations", () => {
    const rows = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [
        { durationMs: 0, stage: "AWAKE", fieldTag: "sleep_awake" },
        { durationMs: null, stage: "CORE", fieldTag: "sleep_core" },
        { durationMs: undefined, stage: "DEEP", fieldTag: "sleep_deep" },
        { durationMs: Number.NaN, stage: "REM", fieldTag: "sleep_rem" },
        { durationMs: 30 * 60_000, stage: "CORE", fieldTag: "sleep_core" },
      ],
      externalIdFor: (tag) => `night:seg:${tag}`,
    });
    expect(rows).toHaveLength(1);
    // The laid stage keys on its tag alone — skipped stages cannot influence
    // the id of any other stage (no positional index to renumber).
    expect(rows[0].externalId).toBe("night:seg:sleep_core");
    expect(rows[0].measuredAt.getTime()).toBe(onset + 30 * 60_000);
  });

  it("keeps stable externalIds when a re-score flips a stage 0↔positive", () => {
    // First scoring: no awake time. Re-score: WHOOP/Polar now report a
    // positive AWAKE block. Under the retired positional index the re-score
    // renumbered CORE/DEEP (0→1, 1→2), minting fresh externalIds the upsert
    // then INSERTED next to the old rows — the night double-counted. The
    // stage-tagged key must be identical across both scorings.
    const stages = (awakeMs: number) =>
      [
        { durationMs: awakeMs, stage: "AWAKE", fieldTag: "sleep_awake" },
        { durationMs: 60 * 60_000, stage: "CORE", fieldTag: "sleep_core" },
        { durationMs: 30 * 60_000, stage: "DEEP", fieldTag: "sleep_deep" },
      ] as const;
    const externalIdFor = (tag: string) => `night:seg:${tag}`;

    const first = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: stages(0),
      externalIdFor,
    });
    const rescored = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: stages(15 * 60_000),
      externalIdFor,
    });

    const idsOf = (rows: typeof first, stage: string) =>
      rows.find((r) => r.sleepStage === stage)?.externalId;
    // CORE and DEEP keep their ids — the awake flip cannot renumber them.
    expect(idsOf(rescored, "CORE")).toBe(idsOf(first, "CORE"));
    expect(idsOf(rescored, "DEEP")).toBe(idsOf(first, "DEEP"));
    expect(idsOf(rescored, "AWAKE")).toBe("night:seg:sleep_awake");
  });

  it("appends a single IN_BED envelope at the given END instant", () => {
    const rows = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [
        { durationMs: 60 * 60_000, stage: "CORE", fieldTag: "sleep_core" },
      ],
      inBed: {
        durationMs: end - onset,
        measuredAt: new Date(end),
        fieldTag: "sleep_in_bed",
      },
      externalIdFor: (tag) => `night:seg:${tag}`,
    });
    const inBed = rows.find((r) => r.sleepStage === "IN_BED")!;
    expect(inBed.measuredAt.getTime()).toBe(end);
    expect(inBed.value).toBe(480); // 8 h
    // IN_BED is an envelope, not a placed segment — no reconstructed flag / id.
    expect(inBed.reconstructed).toBeUndefined();
    expect(inBed.externalId).toBeUndefined();
  });

  it("omits IN_BED when its duration is missing or non-positive", () => {
    const rows = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [
        { durationMs: 60 * 60_000, stage: "CORE", fieldTag: "sleep_core" },
      ],
      inBed: {
        durationMs: 0,
        measuredAt: new Date(end),
        fieldTag: "sleep_in_bed",
      },
      externalIdFor: (tag) => `night:seg:${tag}`,
    });
    expect(rows.find((r) => r.sleepStage === "IN_BED")).toBeUndefined();
  });

  it("lays stages in the one order the night reader recognises, whatever the caller's order", () => {
    // The reader tells a laid-out night from a measured one by this order
    // (`hasStageTimeline`); a vendor listing its stages differently must not
    // produce a layout the reader would take for measured timing.
    const rows = reconstructContiguousSleepTimeline({
      startMs: onset,
      stages: [
        { durationMs: 90 * 60_000, stage: "REM", fieldTag: "sleep_rem" },
        { durationMs: 60 * 60_000, stage: "CORE", fieldTag: "sleep_core" },
        { durationMs: 10 * 60_000, stage: "AWAKE", fieldTag: "sleep_awake" },
        { durationMs: 30 * 60_000, stage: "DEEP", fieldTag: "sleep_deep" },
      ],
      externalIdFor: (tag) => `night:seg:${tag}`,
    });
    expect(rows.map((r) => r.sleepStage)).toEqual([...LAID_OUT_STAGE_ORDER]);
    const segments = rows.map((r) => ({
      stage: r.sleepStage,
      start: new Date(r.measuredAt.getTime() - r.value * 60_000),
      end: r.measuredAt,
    }));
    expect(hasStageTimeline(segments)).toBe(false);
  });
});
