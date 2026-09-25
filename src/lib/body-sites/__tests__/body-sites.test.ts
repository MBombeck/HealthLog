/**
 * The pure halves of the body-site view: which spellings are one site, and
 * which records a picked site and side selects.
 *
 * Mutation checks (each run, each seen red):
 *   - compare `includes` instead of equality in `matchesSite` → "a site is
 *     matched whole" goes red ("knee" picks "kneecap");
 *   - drop the BOTH arm in `matchesSite` → "a picked side includes both
 *     sides" goes red;
 *   - key `groupSites` on the raw text → "one site across spellings and
 *     kinds" goes red.
 */
import { describe, expect, it } from "vitest";

import { groupSites, matchesSite, type SiteItem } from "@/lib/body-sites";

const item = (
  kind: SiteItem["kind"],
  bodySite: string | null,
  laterality: SiteItem["laterality"] = null,
): SiteItem => ({ kind, bodySite, laterality });

describe("groupSites", () => {
  it("one site across spellings and kinds, most records first", () => {
    const sites = groupSites([
      item("procedure", "Shoulder", "RIGHT"),
      item("procedure", "Knee", "LEFT"),
      item("condition", " knee ", "LEFT"),
      item("condition", "Knée", "BOTH"),
      item("condition", "KNEE"),
    ]);
    expect(sites.map((s) => s.bodySite)).toEqual(["Knee", "Shoulder"]);
    expect(sites[0]).toEqual({
      bodySite: "Knee",
      procedures: 1,
      conditions: 3,
      sides: [
        { laterality: "LEFT", count: 2 },
        { laterality: "BOTH", count: 1 },
        { laterality: null, count: 1 },
      ],
    });
  });

  it("a record with no site adds no site", () => {
    expect(
      groupSites([item("procedure", null), item("condition", "   ")]),
    ).toEqual([]);
  });
});

describe("matchesSite", () => {
  it("a site is matched whole, case and accents folded", () => {
    expect(matchesSite(item("condition", "Knée"), "knee", undefined)).toBe(
      true,
    );
    expect(matchesSite(item("condition", "Kneecap"), "knee", undefined)).toBe(
      false,
    );
    expect(matchesSite(item("condition", null), "knee", undefined)).toBe(false);
  });

  it("no side picked selects every side, stated or not", () => {
    for (const side of ["LEFT", "RIGHT", "BOTH", null] as const) {
      expect(
        matchesSite(item("procedure", "Knee", side), "Knee", undefined),
      ).toBe(true);
    }
  });

  it("a picked side includes both sides and leaves out an unstated one", () => {
    expect(matchesSite(item("condition", "Knee", "LEFT"), "Knee", "LEFT")).toBe(
      true,
    );
    expect(matchesSite(item("condition", "Knee", "BOTH"), "Knee", "LEFT")).toBe(
      true,
    );
    expect(
      matchesSite(item("condition", "Knee", "RIGHT"), "Knee", "LEFT"),
    ).toBe(false);
    expect(matchesSite(item("condition", "Knee", null), "Knee", "LEFT")).toBe(
      false,
    );
    // BOTH picks only records on both sides: a left knee is not both knees.
    expect(matchesSite(item("condition", "Knee", "LEFT"), "Knee", "BOTH")).toBe(
      false,
    );
  });
});
