/**
 * Person-defined symptoms as lines on the timeline (#981): the day value,
 * the bucket mean over logged days, and the `values` entries that name one.
 *
 * A day's value is its highest intensity; a bucket's point is the mean of
 * its logged days' values, with the number of those days; a day without an
 * entry is not a zero. The day is the record's local day, so a late-evening
 * entry and an entry on a clock-change day land where the person lived them.
 * All data invented.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  capTimelineSeriesKeys,
  TIMELINE_LAB_SERIES_MAX,
  TIMELINE_SYMPTOM_SERIES_MAX,
  timelineSymptomDefinitionId,
  timelineSymptomKey,
} from "@/lib/day/contract";

import { parseSeriesKeys } from "../load-timeline";
import {
  foldSymptomSeries,
  symptomDayPeaks,
  type SymptomOccurrence,
} from "../symptom-series";

const at = (iso: string, intensity: number): SymptomOccurrence => ({
  occurredAt: new Date(iso),
  intensity,
});

const BERLIN = { from: "2026-10-01", to: "2026-11-30", tz: "Europe/Berlin" };

describe("symptomDayPeaks", () => {
  it("takes the highest intensity of each local day", () => {
    const peaks = symptomDayPeaks(
      [
        at("2026-10-05T07:00:00.000Z", 3),
        at("2026-10-05T15:00:00.000Z", 7),
        at("2026-10-05T18:00:00.000Z", 5),
        at("2026-10-06T09:00:00.000Z", 0),
      ],
      BERLIN,
    );
    expect([...peaks]).toEqual([
      ["2026-10-05", 7],
      ["2026-10-06", 0],
    ]);
  });

  it("puts a late-evening entry on the local day, not the UTC one", () => {
    // 22:30 UTC on 25 Oct is 23:30 in Berlin, an hour after the clocks went
    // back; 23:30 UTC is already 26 Oct there.
    const peaks = symptomDayPeaks(
      [at("2026-10-25T22:30:00.000Z", 4), at("2026-10-25T23:30:00.000Z", 6)],
      BERLIN,
    );
    expect([...peaks]).toEqual([
      ["2026-10-25", 4],
      ["2026-10-26", 6],
    ]);
    // West of UTC the cut runs the other way: 03:30 UTC on 9 March is still
    // 8 March in New York, the evening the clocks went forward.
    const ny = symptomDayPeaks([at("2026-03-09T03:30:00.000Z", 8)], {
      from: "2026-03-01",
      to: "2026-03-31",
      tz: "America/New_York",
    });
    expect([...ny]).toEqual([["2026-03-08", 8]]);
  });

  it("holds a 23-hour clock-change day whole", () => {
    // 29 March 2026 in Berlin runs from 23:00 UTC on the 28th to 22:00 UTC.
    const peaks = symptomDayPeaks(
      [
        at("2026-03-28T23:05:00.000Z", 2),
        at("2026-03-29T21:55:00.000Z", 5),
        at("2026-03-29T22:05:00.000Z", 9),
      ],
      { from: "2026-03-01", to: "2026-03-31", tz: "Europe/Berlin" },
    );
    expect([...peaks]).toEqual([
      ["2026-03-29", 5],
      ["2026-03-30", 9],
    ]);
  });

  it("leaves out entries outside the window", () => {
    const peaks = symptomDayPeaks(
      [at("2026-09-30T12:00:00.000Z", 9), at("2026-12-01T12:00:00.000Z", 9)],
      BERLIN,
    );
    expect(peaks.size).toBe(0);
  });
});

describe("foldSymptomSeries", () => {
  it("averages the day peaks over the logged days only, never counting a silent day as zero", () => {
    const points = foldSymptomSeries(
      [
        // Week of 5 Oct: two logged days, peaks 7 and 4.
        at("2026-10-05T07:00:00.000Z", 3),
        at("2026-10-05T15:00:00.000Z", 7),
        at("2026-10-08T15:00:00.000Z", 4),
        // Week of 19 Oct: one day.
        at("2026-10-21T10:00:00.000Z", 2),
      ],
      BERLIN,
      "week",
    );
    expect(points).toEqual([
      { t: "2026-10-05", mean: 5.5, count: 2 },
      { t: "2026-10-19", mean: 2, count: 1 },
    ]);
  });

  it("sends no point for a bucket without an entry", () => {
    const points = foldSymptomSeries(
      [at("2026-10-02T10:00:00.000Z", 6), at("2026-11-20T10:00:00.000Z", 3)],
      BERLIN,
      "week",
    );
    expect(points.map((p) => p.t)).toEqual(["2026-09-28", "2026-11-16"]);
  });

  it("buckets a late-evening entry by its local day, across a week boundary and the clock change", () => {
    // Sunday 25 Oct 23:30 in Berlin closes the week of 19 Oct; half an hour
    // later it is Monday and the next week.
    const points = foldSymptomSeries(
      [at("2026-10-25T22:30:00.000Z", 4), at("2026-10-25T23:30:00.000Z", 6)],
      BERLIN,
      "week",
    );
    expect(points).toEqual([
      { t: "2026-10-19", mean: 4, count: 1 },
      { t: "2026-10-26", mean: 6, count: 1 },
    ]);
  });

  it("follows the month, quarter and day buckets", () => {
    const rows = [
      at("2026-10-05T10:00:00.000Z", 8),
      at("2026-10-05T12:00:00.000Z", 2),
      at("2026-10-06T10:00:00.000Z", 3),
      at("2026-11-02T10:00:00.000Z", 4),
    ];
    expect(foldSymptomSeries(rows, BERLIN, "month")).toEqual([
      { t: "2026-10-01", mean: 5.5, count: 2 },
      { t: "2026-11-01", mean: 4, count: 1 },
    ]);
    expect(foldSymptomSeries(rows, BERLIN, "quarter")).toEqual([
      { t: "2026-10-01", mean: 5, count: 3 },
    ]);
    expect(foldSymptomSeries(rows, BERLIN, "day")).toEqual([
      { t: "2026-10-05", mean: 8, count: 1 },
      { t: "2026-10-06", mean: 3, count: 1 },
      { t: "2026-11-02", mean: 4, count: 1 },
    ]);
  });

  it("keeps a logged zero as a value", () => {
    expect(
      foldSymptomSeries([at("2026-10-05T10:00:00.000Z", 0)], BERLIN, "month"),
    ).toEqual([{ t: "2026-10-01", mean: 0, count: 1 }]);
  });
});

describe("symptom keys in `values`", () => {
  it("round-trips a definition id and refuses a malformed one", () => {
    expect(timelineSymptomKey("sd1")).toBe("symptom:sd1");
    expect(timelineSymptomDefinitionId("symptom:sd1")).toBe("sd1");
    expect(timelineSymptomDefinitionId("symptom:")).toBeNull();
    expect(timelineSymptomDefinitionId("symptom:../x")).toBeNull();
    expect(timelineSymptomDefinitionId("lab:sd1")).toBeNull();
  });

  it("rides beside measurement names and lab markers, and a malformed one refuses", () => {
    expect(
      parseSeriesKeys("WEIGHT,symptom:sd1,lab:bm1,symptom:sd1,MOOD"),
    ).toEqual(["WEIGHT", "symptom:sd1", "lab:bm1", "MOOD"]);
    expect(parseSeriesKeys("symptom:../etc")).toBeNull();
  });

  it("caps symptoms and lab markers each on their own", () => {
    const symptoms = Array.from(
      { length: TIMELINE_SYMPTOM_SERIES_MAX + 3 },
      (_, i) => `symptom:s${i}`,
    );
    const labs = Array.from(
      { length: TIMELINE_LAB_SERIES_MAX + 2 },
      (_, i) => `lab:m${i}`,
    );
    const capped = capTimelineSeriesKeys(["WEIGHT", ...symptoms, ...labs]);
    expect(capped.filter((k) => k.startsWith("symptom:"))).toEqual(
      symptoms.slice(0, TIMELINE_SYMPTOM_SERIES_MAX),
    );
    expect(capped.filter((k) => k.startsWith("lab:"))).toEqual(
      labs.slice(0, TIMELINE_LAB_SERIES_MAX),
    );
    expect(capped[0]).toBe("WEIGHT");
  });
});
