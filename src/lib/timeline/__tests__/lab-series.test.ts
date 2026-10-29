/**
 * Lab markers as lines on the timeline (#1299): the shape of one marker's
 * line, and the `values` entries that name one.
 *
 * A lab line is its readings, one point each, never a mean; a reading in a
 * unit that converts is drawn converted, one that does not is counted and
 * left out; each point is judged against its own window and the band behind
 * the line is the marker's own range. All data invented.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  TIMELINE_LAB_SERIES_MAX,
  timelineLabMarkerId,
} from "@/lib/day/contract";

import { parseSeriesKeys } from "../load-timeline";
import {
  shapeLabSeries,
  type LabLineMarker,
  type LabLineRow,
} from "../lab-series";

const FERRITIN: LabLineMarker = {
  id: "bm1",
  name: "Ferritin",
  unit: "ng/mL",
  lowerBound: 30,
  upperBound: 400,
  panel: "Iron",
  analyteKey: "ferritin",
};

const GLUCOSE: LabLineMarker = {
  id: "bm2",
  name: "Fasting glucose",
  unit: "mg/dL",
  lowerBound: 70,
  upperBound: 99,
  panel: null,
  analyteKey: "fasting-glucose",
};

function row(over: Partial<LabLineRow> & Pick<LabLineRow, "id">): LabLineRow {
  return {
    analyte: "Ferritin",
    panel: null,
    value: 100,
    unit: "ng/mL",
    sourceValue: null,
    sourceUnit: null,
    referenceLow: null,
    referenceHigh: null,
    sourceReferenceLow: null,
    sourceReferenceHigh: null,
    sourceReferenceText: null,
    biomarkerId: "bm1",
    takenAt: new Date("2025-03-10T07:30:00.000Z"),
    report: null,
    ...over,
  };
}

const WINDOW = { from: "2025-01-01", to: "2025-12-31", tz: "Europe/Berlin" };

describe("a lab marker's line", () => {
  it("is its readings, one point each, oldest first, never a mean", () => {
    const line = shapeLabSeries(
      FERRITIN,
      [
        row({ id: "r3", value: 52, takenAt: new Date("2025-11-02T08:00:00Z") }),
        row({ id: "r1", value: 41, takenAt: new Date("2025-02-03T08:00:00Z") }),
        // Two draws on one day stay two points.
        row({
          id: "r2a",
          value: 44,
          takenAt: new Date("2025-02-20T07:00:00Z"),
        }),
        row({
          id: "r2b",
          value: 46,
          takenAt: new Date("2025-02-20T15:00:00Z"),
        }),
      ],
      WINDOW,
    );
    expect(line.key).toBe("lab:bm1");
    expect(line.unit).toBe("ng/mL");
    expect(line.points.map((p) => [p.id, p.date, p.value])).toEqual([
      ["r1", "2025-02-03", 41],
      ["r2a", "2025-02-20", 44],
      ["r2b", "2025-02-20", 46],
      ["r3", "2025-11-02", 52],
    ]);
    expect(line.excluded).toBe(0);
  });

  it("dates a reading by the record's local day, as the day view lists it", () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Berlin.
    const line = shapeLabSeries(
      FERRITIN,
      [
        row({ id: "late", takenAt: new Date("2024-12-31T23:30:00Z") }),
        row({ id: "out", takenAt: new Date("2025-12-31T23:30:00Z") }),
      ],
      WINDOW,
    );
    expect(line.points.map((p) => [p.id, p.date])).toEqual([
      ["late", "2025-01-01"],
    ]);
  });

  it("judges each reading against its own printed window, else the marker's", () => {
    const line = shapeLabSeries(
      FERRITIN,
      [
        row({ id: "low", value: 12 }),
        row({
          id: "printed",
          value: 420,
          takenAt: new Date("2025-04-01T08:00:00Z"),
          sourceReferenceLow: 20,
          sourceReferenceHigh: 500,
        }),
        row({
          id: "high",
          value: 450,
          takenAt: new Date("2025-05-01T08:00:00Z"),
        }),
      ],
      WINDOW,
    );
    expect(
      line.points.map((p) => [
        p.id,
        p.rangeStatus,
        p.referenceLow,
        p.referenceHigh,
      ]),
    ).toEqual([
      ["low", "below", 30, 400],
      // In range against the window its own report printed.
      ["printed", "in-range", 20, 500],
      ["high", "above", 30, 400],
    ]);
    // The band behind the line is the marker's own range.
    expect(line.band).toEqual({ low: 30, high: 400 });
  });

  it("falls back to the newest reading's window when the marker has no range", () => {
    const line = shapeLabSeries(
      { ...FERRITIN, lowerBound: null, upperBound: null },
      [
        row({ id: "a", sourceReferenceLow: 10, sourceReferenceHigh: 300 }),
        row({
          id: "b",
          takenAt: new Date("2025-06-01T08:00:00Z"),
          sourceReferenceLow: 15,
          sourceReferenceHigh: 150,
        }),
      ],
      WINDOW,
    );
    expect(line.band).toEqual({ low: 15, high: 150 });
    const bare = shapeLabSeries(
      { ...FERRITIN, lowerBound: null, upperBound: null },
      [row({ id: "a" })],
      WINDOW,
    );
    expect(bare.band).toBeNull();
    expect(bare.points[0].rangeStatus).toBe("unknown");
  });

  it("converts a reading in another unit that converts, window and all", () => {
    const line = shapeLabSeries(
      GLUCOSE,
      [
        row({
          id: "mmol",
          analyte: "Fasting glucose",
          biomarkerId: "bm2",
          value: 5.5,
          unit: "mmol/L",
          sourceReferenceLow: 3.9,
          sourceReferenceHigh: 5.5,
        }),
        // The same unit spelled another way is the same unit.
        row({
          id: "spelled",
          analyte: "Fasting glucose",
          biomarkerId: "bm2",
          value: 92,
          unit: "mg/dl",
          takenAt: new Date("2025-06-01T08:00:00Z"),
        }),
      ],
      WINDOW,
    );
    const [mmol, spelled] = line.points;
    expect(mmol.value).toBeCloseTo(99.09, 1);
    // The figure as stored sets the precision the converted one shows with.
    expect(mmol.sourceValue).toBe(5.5);
    expect(mmol.referenceLow).toBeCloseTo(70.26, 1);
    expect(mmol.referenceHigh).toBeCloseTo(99.09, 1);
    expect(mmol.rangeStatus).toBe("in-range");
    expect(spelled).toMatchObject({ value: 92, sourceValue: null });
    expect(line.excluded).toBe(0);
  });

  it("leaves out and counts a reading whose unit does not convert", () => {
    // Ferritin has no molar conversion: pmol/L is never drawn on a ng/mL scale.
    const line = shapeLabSeries(
      FERRITIN,
      [
        row({ id: "ok", value: 80 }),
        row({
          id: "molar",
          value: 180,
          unit: "pmol/L",
          takenAt: new Date("2025-06-01T08:00:00Z"),
        }),
      ],
      WINDOW,
    );
    expect(line.points.map((p) => p.id)).toEqual(["ok"]);
    expect(line.excluded).toBe(1);
  });

  it("links the report a reading was read from", () => {
    const line = shapeLabSeries(
      FERRITIN,
      [
        row({ id: "doc", report: { id: "d1", title: "Lab report March" } }),
        row({ id: "none", takenAt: new Date("2025-04-01T08:00:00Z") }),
      ],
      WINDOW,
    );
    expect(line.points[0].report).toEqual({
      id: "d1",
      title: "Lab report March",
      href: "/documents?doc=d1",
    });
    expect(line.points[1].report).toBeNull();
  });

  it("has no points, and says so, when the window holds no reading", () => {
    const line = shapeLabSeries(FERRITIN, [], WINDOW);
    expect(line.points).toEqual([]);
    expect(line.excluded).toBe(0);
    expect(line.band).toEqual({ low: 30, high: 400 });
  });
});

describe("a lab marker in `values`", () => {
  it("is named `lab:<biomarkerId>`, nothing else", () => {
    expect(timelineLabMarkerId("lab:ckx1abc")).toBe("ckx1abc");
    expect(timelineLabMarkerId("WEIGHT")).toBeNull();
    expect(timelineLabMarkerId("lab:")).toBeNull();
    expect(timelineLabMarkerId("lab:a,b")).toBeNull();
    expect(timelineLabMarkerId("lab:../x")).toBeNull();
  });

  it("rides beside measurement names, and an unknown name still refuses", () => {
    expect(parseSeriesKeys("WEIGHT,lab:bm1,lab:bm1,MOOD")).toEqual([
      "WEIGHT",
      "lab:bm1",
      "MOOD",
    ]);
    expect(parseSeriesKeys("lab:bm1,NOPE")).toBeNull();
    expect(parseSeriesKeys("lab:../etc")).toBeNull();
  });

  it("is capped, because marker ids are not a closed set", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `lab:m${i}`).join(",");
    expect(parseSeriesKeys(many(TIMELINE_LAB_SERIES_MAX))).toHaveLength(
      TIMELINE_LAB_SERIES_MAX,
    );
    expect(parseSeriesKeys(many(TIMELINE_LAB_SERIES_MAX + 1))).toBeNull();
  });
});
