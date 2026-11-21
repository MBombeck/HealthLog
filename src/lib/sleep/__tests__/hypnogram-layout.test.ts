import { describe, expect, it } from "vitest";

import {
  hasHypnogramTrack,
  hypnogramLayout,
  hypnogramTicks,
  shiftNightKey,
} from "../hypnogram-layout";

const seg = (stage: string | null, start: string, end: string) => ({
  stage,
  start,
  end,
});

describe("hypnogramLayout", () => {
  it("gives only the present stages a lane, Awake on top and Deep at the base", () => {
    const layout = hypnogramLayout([
      seg("CORE", "2026-06-01T23:10:00Z", "2026-06-02T00:00:00Z"),
      seg("DEEP", "2026-06-02T00:00:00Z", "2026-06-02T00:40:00Z"),
      seg("AWAKE", "2026-06-02T00:40:00Z", "2026-06-02T00:45:00Z"),
      seg("REM", "2026-06-02T00:45:00Z", "2026-06-02T01:15:00Z"),
    ]);
    expect(layout.lanes).toEqual(["AWAKE", "REM", "CORE", "DEEP"]);
    const laneOf = Object.fromEntries(
      layout.spans.map((s) => [s.stage, s.lane]),
    );
    expect(laneOf).toEqual({ AWAKE: 3, REM: 2, CORE: 1, DEEP: 0 });
  });

  it("drops unknown stages, empty spans and broken instants, and sorts by start", () => {
    const layout = hypnogramLayout([
      seg("REM", "2026-06-02T02:00:00Z", "2026-06-02T02:30:00Z"),
      seg("NAP", "2026-06-02T01:00:00Z", "2026-06-02T01:30:00Z"),
      seg(null, "2026-06-02T01:00:00Z", "2026-06-02T01:30:00Z"),
      seg("CORE", "2026-06-02T01:00:00Z", "2026-06-02T01:00:00Z"),
      seg("DEEP", "not a date", "2026-06-02T01:30:00Z"),
      seg("CORE", "2026-06-02T01:00:00Z", "2026-06-02T02:00:00Z"),
    ]);
    expect(layout.spans.map((s) => s.stage)).toEqual(["CORE", "REM"]);
  });
});

describe("hasHypnogramTrack", () => {
  const layout = hypnogramLayout([
    seg("CORE", "2026-06-01T23:00:00Z", "2026-06-02T01:00:00Z"),
    seg("DEEP", "2026-06-02T01:00:00Z", "2026-06-02T02:00:00Z"),
  ]);

  it("draws a measured night", () => {
    expect(hasHypnogramTrack(layout, false)).toBe(true);
  });

  it("never draws a synthesised night, whose order was never measured", () => {
    expect(hasHypnogramTrack(layout, true)).toBe(false);
  });

  it("does not draw segments that all start on one instant", () => {
    const flat = hypnogramLayout([
      seg("CORE", "2026-06-01T23:00:00Z", "2026-06-02T01:00:00Z"),
      seg("DEEP", "2026-06-01T23:00:00Z", "2026-06-02T00:00:00Z"),
    ]);
    expect(hasHypnogramTrack(flat, false)).toBe(false);
  });
});

describe("hypnogramTicks", () => {
  const ms = (iso: string) => Date.parse(iso);

  it("labels whole hours of the zone the night is read in", () => {
    // 23:14 to 06:02 in Berlin (UTC+2 in June): a seven-hour night, two-hour
    // step, so 00:00, 02:00, 04:00 and 06:00 local.
    const ticks = hypnogramTicks(
      ms("2026-06-01T21:14:00Z"),
      ms("2026-06-02T04:02:00Z"),
      "Europe/Berlin",
    );
    expect(ticks.map((t) => new Date(t).toISOString())).toEqual([
      "2026-06-01T22:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
      "2026-06-02T02:00:00.000Z",
      "2026-06-02T04:00:00.000Z",
    ]);
  });

  it("keeps whole local hours in a half-hour zone", () => {
    const ticks = hypnogramTicks(
      ms("2026-06-01T17:00:00Z"),
      ms("2026-06-02T00:40:00Z"),
      "Asia/Kolkata",
    );
    // 22:30 to 06:10 local → 00:00, 02:00, 04:00, 06:00 IST.
    expect(ticks.map((t) => new Date(t).toISOString())).toEqual([
      "2026-06-01T18:30:00.000Z",
      "2026-06-01T20:30:00.000Z",
      "2026-06-01T22:30:00.000Z",
      "2026-06-02T00:30:00.000Z",
    ]);
  });

  it("labels real wall-clock hours across the autumn DST change", () => {
    // 25 Oct 2026, Berlin falls back at 03:00 CEST → 02:00 CET.
    const ticks = hypnogramTicks(
      ms("2026-10-24T21:30:00Z"),
      ms("2026-10-25T05:30:00Z"),
      "Europe/Berlin",
    );
    const local = ticks.map((t) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
      }).format(t),
    );
    for (const label of local) expect(label.endsWith(":00")).toBe(true);
    for (const label of local) {
      expect(Number(label.slice(0, 2)) % 2).toBe(0);
    }
  });

  it("returns nothing for an empty or inverted night", () => {
    expect(hypnogramTicks(10, 10, "UTC")).toEqual([]);
    expect(hypnogramTicks(20, 10, "UTC")).toEqual([]);
  });
});

describe("shiftNightKey", () => {
  it("steps a wake day across month and year ends", () => {
    expect(shiftNightKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftNightKey("2026-12-31", 1)).toBe("2027-01-01");
  });
});
