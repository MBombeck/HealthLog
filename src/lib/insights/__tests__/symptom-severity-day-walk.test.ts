/**
 * The episode-span zero-fill covers exactly the local days from onset to
 * resolution. It used to walk in fixed 24-hour steps: a walk that started in
 * the last local hour before a 23-hour (spring-forward) day stepped over that
 * day, and one whose onset clock time was earlier than the resolution's added
 * the day after the episode as a healthy zero.
 */
import { describe, it, expect } from "vitest";
import { buildSymptomSeverityDailySeries } from "@/lib/insights/correlation-series-builders";

describe("symptom severity zero-fill by local day", () => {
  const tz = "Europe/Berlin";
  // Spring forward: Sunday 2026-03-29 has 23 local hours.
  const run = (startIso: string) =>
    buildSymptomSeverityDailySeries({
      dayLogs: [],
      episodes: [
        {
          onsetAt: new Date(startIso),
          resolvedAt: new Date("2026-03-31T10:00:00Z"),
        },
      ],
      tz,
      windowStart: new Date("2026-03-01T00:00:00Z"),
      windowEnd: new Date("2026-04-05T00:00:00Z"),
      role: "outcome",
    }).points.map((p) => p.day);

  it("an onset at 12:00 local covers every day", () => {
    expect(run("2026-03-28T11:00:00Z")).toEqual([
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
    ]);
  });

  it("an onset at 23:30 local before the spring-forward day keeps that day", () => {
    // 23:30 CET = 22:30Z
    expect(run("2026-03-28T22:30:00Z")).toEqual([
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
    ]);
  });

  it("an onset earlier in the day than the resolution adds no day after it", () => {
    const days = buildSymptomSeverityDailySeries({
      dayLogs: [],
      episodes: [
        {
          onsetAt: new Date("2026-06-01T06:00:00Z"),
          resolvedAt: new Date("2026-06-04T10:00:00Z"),
        },
      ],
      tz,
      windowStart: new Date("2026-05-01T00:00:00Z"),
      windowEnd: new Date("2026-06-20T00:00:00Z"),
      role: "outcome",
    }).points.map((p) => p.day);
    expect(days).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
    ]);
  });
});
