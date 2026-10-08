import { describe, expect, it } from "vitest";

import { keepNonOverlapping } from "../import";
import { mapHealthConnectSleepStage } from "../sleep-stage-map";

describe("mapHealthConnectSleepStage", () => {
  it("maps the classified stages", () => {
    expect(mapHealthConnectSleepStage(1, true)).toEqual({ stage: "AWAKE" });
    expect(mapHealthConnectSleepStage(2, true)).toEqual({ stage: "ASLEEP" });
    expect(mapHealthConnectSleepStage(4, true)).toEqual({ stage: "CORE" });
    expect(mapHealthConnectSleepStage(5, true)).toEqual({ stage: "DEEP" });
    expect(mapHealthConnectSleepStage(6, true)).toEqual({ stage: "REM" });
    expect(mapHealthConnectSleepStage(7, true)).toEqual({ stage: "AWAKE" });
  });

  it("leaves out time out of bed", () => {
    expect(mapHealthConnectSleepStage(3, true)).toEqual({ skip: "out_of_bed" });
    expect(mapHealthConnectSleepStage(3, false)).toEqual({
      skip: "out_of_bed",
    });
  });

  it("counts an unknown stage as sleep only in a session without real stages", () => {
    expect(mapHealthConnectSleepStage(0, false)).toEqual({ stage: "ASLEEP" });
    expect(mapHealthConnectSleepStage(0, true)).toEqual({
      skip: "unknown_stage",
    });
  });

  it("leaves out a stage number it does not know", () => {
    expect(mapHealthConnectSleepStage(42, true)).toEqual({
      skip: "unmapped_stage",
    });
  });
});

describe("keepNonOverlapping", () => {
  it("keeps the better-ranked of two overlapping sessions and every lone one", () => {
    const sessions = [
      { id: "a", start: 0, end: 100, rank: 1 },
      { id: "b", start: 50, end: 150, rank: 0 },
      { id: "c", start: 200, end: 300, rank: 5 },
    ];
    expect(
      keepNonOverlapping(sessions, (s) => s.rank).map((s) => s.id),
    ).toEqual(["b", "c"]);
  });

  it("treats sessions that only touch as separate", () => {
    const sessions = [
      { start: 0, end: 100, rank: 0 },
      { start: 100, end: 200, rank: 1 },
    ];
    expect(keepNonOverlapping(sessions, (s) => s.rank)).toHaveLength(2);
  });
});
