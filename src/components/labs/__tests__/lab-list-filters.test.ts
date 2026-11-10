import { describe, expect, it } from "vitest";

import {
  buildMarkerCategoryMap,
  filterMarkerRows,
  labListFiltersToSearch,
  labReadingDayKey,
  parseLabListSearchParams,
  sortMarkerRows,
  type LabListFilters,
} from "../lab-list-filters";
import type { MarkerRow } from "../lab-list-rows";
import type { LabOverviewCategoryDto, LabResultDto } from "../types";

function mockReading(over: Partial<LabResultDto>): LabResultDto {
  return {
    id: "r1",
    biomarkerId: "b1",
    panel: null,
    analyte: "Ferritin",
    value: 80,
    valueText: null,
    unit: "ng/mL",
    converted: false,
    sourceValue: null,
    sourceUnit: null,
    referenceLow: 30,
    referenceHigh: 400,
    catalogReferenceLow: 30,
    catalogReferenceHigh: 400,
    sourceReferenceLow: null,
    sourceReferenceHigh: null,
    sourceReferenceText: null,
    printedReferenceText: null,
    referenceOrigin: "catalog",
    referenceDivergesFromCatalog: false,
    takenAt: "2026-09-01T12:00:00.000Z",
    source: "MANUAL",
    hasNote: false,
    rangeStatus: "in-range",
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    ...over,
  };
}

function mockMarkerRow(over: Partial<MarkerRow>): MarkerRow {
  return {
    key: "bm:1",
    biomarkerId: "1",
    analyte: "Ferritin",
    panel: "Iron Studies",
    unit: "ng/mL",
    count: 2,
    trend: [70, 80],
    latest: mockReading({
      biomarkerId: "1",
      analyte: "Ferritin",
      panel: "Iron Studies",
      rangeStatus: "in-range",
      takenAt: "2026-09-01T12:00:00.000Z",
    }),
    ...over,
  };
}

describe("parseLabListSearchParams & labListFiltersToSearch", () => {
  it("parses empty search params into empty filters", () => {
    expect(parseLabListSearchParams(new URLSearchParams())).toEqual({});
  });

  it("parses valid facets", () => {
    const params = new URLSearchParams(
      "q=iron&status=abnormal&category=cat_iron&from=2026-01-01&to=2026-12-31",
    );
    expect(parseLabListSearchParams(params)).toEqual<LabListFilters>({
      q: "iron",
      status: "abnormal",
      category: "cat_iron",
      fromDay: "2026-01-01",
      toDay: "2026-12-31",
    });
  });

  it("drops invalid status and invalid dates", () => {
    const params = new URLSearchParams(
      "status=invalid&category=ALL&from=not-a-date&to=invalid",
    );
    expect(parseLabListSearchParams(params)).toEqual({});
  });

  it("rejects non-existent calendar dates like 2026-02-30", () => {
    const params = new URLSearchParams("from=2026-02-30&to=2026-04-31");
    expect(parseLabListSearchParams(params)).toEqual({});
  });

  it("parses category param and ignores category=ALL", () => {
    expect(
      parseLabListSearchParams(new URLSearchParams("category=cat_valid")),
    ).toEqual({
      category: "cat_valid",
    });
    expect(
      parseLabListSearchParams(new URLSearchParams("category=ALL")),
    ).toEqual({});
  });

  it("ignores a sort param: the list follows the saved sort only", () => {
    expect(
      parseLabListSearchParams(new URLSearchParams("sort=alphaAsc")),
    ).toEqual({});
  });

  it("roundtrips valid filters to search string", () => {
    const filters: LabListFilters = {
      q: "cholesterol",
      status: "above",
      category: "lipids",
      fromDay: "2026-05-01",
      toDay: "2026-05-31",
    };
    const search = labListFiltersToSearch(filters);
    const parsed = parseLabListSearchParams(new URLSearchParams(search));
    expect(parsed).toEqual(filters);
  });
});

describe("filterMarkerRows", () => {
  const row1 = mockMarkerRow({
    key: "bm:1",
    analyte: "Ferritin",
    panel: "Iron Studies",
    latest: mockReading({
      rangeStatus: "in-range",
      takenAt: "2026-08-01T10:00:00.000Z",
    }),
  });
  const row2 = mockMarkerRow({
    key: "bm:2",
    analyte: "Iron",
    panel: "Iron Studies",
    latest: mockReading({
      rangeStatus: "below",
      takenAt: "2026-07-15T10:00:00.000Z",
    }),
  });
  const row3 = mockMarkerRow({
    key: "bm:3",
    analyte: "Total Cholesterol",
    panel: "Lipid Panel",
    latest: mockReading({
      rangeStatus: "above",
      takenAt: "2026-09-10T10:00:00.000Z",
    }),
  });
  const rows = [row1, row2, row3];

  it("filters by query matching analyte or panel", () => {
    expect(filterMarkerRows(rows, { q: "cholest" })).toEqual([row3]);
    expect(filterMarkerRows(rows, { q: "Iron" })).toEqual([row1, row2]);
  });

  it("filters by status: abnormal (below or above)", () => {
    expect(filterMarkerRows(rows, { status: "abnormal" })).toEqual([
      row2,
      row3,
    ]);
  });

  it("filters by status: in-range", () => {
    expect(filterMarkerRows(rows, { status: "in-range" })).toEqual([row1]);
  });

  it("filters by status: below", () => {
    expect(filterMarkerRows(rows, { status: "below" })).toEqual([row2]);
  });

  it("filters by category using categoryOf lookup", () => {
    const categoryOf = (key: string) =>
      key === "bm:1" || key === "bm:2" ? "iron_panel" : "lipid_panel";
    expect(
      filterMarkerRows(rows, { category: "lipid_panel" }, categoryOf),
    ).toEqual([row3]);
  });

  it("fails closed when filtering by category without categoryOf", () => {
    expect(filterMarkerRows(rows, { category: "iron_panel" })).toEqual([]);
  });

  it("filters by date bounds on latest takenAt", () => {
    expect(filterMarkerRows(rows, { fromDay: "2026-08-01" })).toEqual([
      row1,
      row3,
    ]);
    expect(filterMarkerRows(rows, { toDay: "2026-07-31" })).toEqual([row2]);
    expect(
      filterMarkerRows(rows, {
        fromDay: "2026-07-01",
        toDay: "2026-08-15",
      }),
    ).toEqual([row1, row2]);
  });

  it("matches local day bounds using labReadingDayKey (handling timezone shifts)", () => {
    // 2026-08-31T22:30:00.000Z in UTC is 2026-08-31.
    // In Europe/Warsaw (UTC+2 in summer / CEST), it is 2026-09-01 00:30.
    // In America/New_York (UTC-4 in summer / EDT), it is 2026-08-31 18:30.
    const lateRow = mockMarkerRow({
      key: "bm:late",
      latest: mockReading({
        takenAt: "2026-08-31T22:30:00.000Z",
      }),
    });

    const dayKeyWarsaw = (takenAt: string) =>
      labReadingDayKey(takenAt, "Europe/Warsaw");
    const dayKeyNy = (takenAt: string) =>
      labReadingDayKey(takenAt, "America/New_York");

    // Warsaw (local date 2026-09-01): matches from 2026-09-01, excluded by to 2026-08-31
    expect(
      filterMarkerRows(
        [lateRow],
        { fromDay: "2026-09-01" },
        undefined,
        dayKeyWarsaw,
      ),
    ).toEqual([lateRow]);
    expect(
      filterMarkerRows(
        [lateRow],
        { toDay: "2026-08-31" },
        undefined,
        dayKeyWarsaw,
      ),
    ).toEqual([]);

    // New York (local date 2026-08-31): excluded by from 2026-09-01, matches to 2026-08-31
    expect(
      filterMarkerRows(
        [lateRow],
        { fromDay: "2026-09-01" },
        undefined,
        dayKeyNy,
      ),
    ).toEqual([]);
    expect(
      filterMarkerRows(
        [lateRow],
        { toDay: "2026-08-31" },
        undefined,
        dayKeyNy,
      ),
    ).toEqual([lateRow]);
  });
});

describe("sortMarkerRows", () => {
  const rowA = mockMarkerRow({ key: "bm:1", biomarkerId: "1", analyte: "B12" });
  const rowB = mockMarkerRow({ key: "bm:2", biomarkerId: "2", analyte: "CRP" });
  const rowC = mockMarkerRow({
    key: "bm:3",
    biomarkerId: "3",
    analyte: "Alanine",
  });
  const rows = [rowA, rowB, rowC];

  it("sorts alphaAsc", () => {
    const sorted = sortMarkerRows(rows, "alphaAsc");
    expect(sorted.map((r) => r.analyte)).toEqual(["Alanine", "B12", "CRP"]);
  });

  it("sorts alphaDesc", () => {
    const sorted = sortMarkerRows(rows, "alphaDesc");
    expect(sorted.map((r) => r.analyte)).toEqual(["CRP", "B12", "Alanine"]);
  });

  it("sorts recentAsc (reverses input)", () => {
    const sorted = sortMarkerRows(rows, "recentAsc");
    expect(sorted).toEqual([rowC, rowB, rowA]);
  });

  it("sorts manual", () => {
    const sorted = sortMarkerRows(rows, "manual", ["2", "1", "3"]);
    expect(sorted.map((r) => r.key)).toEqual(["bm:2", "bm:1", "bm:3"]);
  });

  it("handles sort=manual without manualOrder gracefully", () => {
    expect(sortMarkerRows(rows, "manual", [])).toEqual(rows);
    expect(sortMarkerRows(rows, "manual", undefined)).toEqual(rows);
  });
});

describe("labReadingDayKey", () => {
  it("keeps noon UTC anchors on their stated date across all timezones", () => {
    const noonInstant = "2026-09-01T12:00:00.000Z";
    expect(labReadingDayKey(noonInstant, "UTC")).toBe("2026-09-01");
    expect(labReadingDayKey(noonInstant, "America/New_York")).toBe("2026-09-01");
    expect(labReadingDayKey(noonInstant, "Pacific/Kiritimati")).toBe("2026-09-01");
  });

  it("documents exact-noon date-anchor ambiguity vs true instant timestamps", () => {
    // Because the data model does not have an explicit `dateOnly` boolean flag,
    // exact 12:00:00.000Z is treated as a date anchor by convention to align with
    // `useLabDate` / `date-only.ts`. In Pacific/Kiritimati (UTC+14), 12:00 UTC would be
    // 02:00 on the NEXT calendar day if treated as an instant; but as an anchor it stays 2026-09-01.
    const noonAnchor = "2026-09-01T12:00:00.000Z";
    expect(labReadingDayKey(noonAnchor, "Pacific/Kiritimati")).toBe("2026-09-01");

    // Any non-noon instant (even 1 second off noon) is recognized as a true instant with time
    // and correctly shifts to the local date in the user's timezone:
    const nonNoonInstant = "2026-09-01T12:00:01.000Z";
    expect(labReadingDayKey(nonNoonInstant, "Pacific/Kiritimati")).toBe("2026-09-02");
    expect(labReadingDayKey(nonNoonInstant, "UTC")).toBe("2026-09-01");
  });

  it("formats timestamps with times in the user's timezone", () => {
    // 2026-09-01 00:30 UTC+2 (Warsaw) = 2026-08-31 22:30 UTC
    const eveningUtc = "2026-08-31T22:30:00.000Z";
    expect(labReadingDayKey(eveningUtc, "UTC")).toBe("2026-08-31");
    expect(labReadingDayKey(eveningUtc, "Europe/Warsaw")).toBe("2026-09-01");
    expect(labReadingDayKey(eveningUtc, "America/New_York")).toBe("2026-08-31");
  });
});

describe("buildMarkerCategoryMap", () => {
  it("builds map from categories", () => {
    const categories: LabOverviewCategoryDto[] = [
      {
        key: "cat1",
        label: "Category 1",
        markerKeys: ["bm:1", "bm:2"],
        counts: { inRange: 2, below: 0, above: 0, unknown: 0 },
        status: "in-range",
      },
      {
        key: "cat2",
        label: "Category 2",
        markerKeys: ["bm:3"],
        counts: { inRange: 0, below: 1, above: 0, unknown: 0 },
        status: "below",
      },
    ];
    const map = buildMarkerCategoryMap(categories);
    expect(map.get("bm:1")).toBe("cat1");
    expect(map.get("bm:2")).toBe("cat1");
    expect(map.get("bm:3")).toBe("cat2");
    expect(map.get("bm:4")).toBeUndefined();
  });
});
