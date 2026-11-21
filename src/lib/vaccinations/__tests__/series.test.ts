/**
 * The series derivation, case by case.
 *
 * Every fixture date is relative to now. A fixed calendar date in a test about
 * ordering rots the moment the window it sat inside slides past it, and this
 * repository has shipped that defect before: the dates here are "eleven years
 * ago" and "last month", never "2024-03-01".
 */
import { describe, expect, it } from "vitest";

import {
  deriveSeries,
  type SeriesInputRecord,
} from "@/lib/vaccinations/series";

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** `monthsAgo(132)` — eleven years back from whenever the suite runs. */
function monthsAgo(months: number): Date {
  return new Date(Date.now() - months * MONTH_MS);
}

function record(
  id: string,
  monthsBack: number,
  antigenSlug: string | null,
  extra: Partial<SeriesInputRecord> = {},
): SeriesInputRecord {
  return {
    id,
    occurredAt: monthsAgo(monthsBack),
    antigenSlug,
    doseNumber: null,
    seriesDoses: null,
    ...extra,
  };
}

describe("a monovalent dose counts into its own series", () => {
  it("places three tetanus doses at positions one, two and three", () => {
    const history = [
      record("t1", 300, "tetanus"),
      record("t2", 296, "tetanus"),
      record("t3", 288, "tetanus"),
    ];
    const series = deriveSeries(history);
    expect(series.get("t1")).toEqual([
      { antigen: "tetanus", position: 1, total: 3, booster: false },
    ]);
    expect(series.get("t2")).toEqual([
      { antigen: "tetanus", position: 2, total: 3, booster: false },
    ]);
    expect(series.get("t3")).toEqual([
      { antigen: "tetanus", position: 3, total: 3, booster: false },
    ]);
  });

  it("orders by date rather than by the order the query returned them", () => {
    // Deliberately handed to the function newest-first.
    const series = deriveSeries([
      record("newest", 12, "tetanus"),
      record("oldest", 240, "tetanus"),
    ]);
    expect(series.get("oldest")?.[0].position).toBe(1);
    expect(series.get("newest")?.[0].position).toBe(2);
  });
});

describe("a combination counts into every component series", () => {
  it("puts one Tdap dose at three different positions at once", () => {
    // The case the whole component axis exists for: two plain Td doses first,
    // so tetanus and diphtheria are already at two while pertussis is at none.
    const history = [
      record("td-1", 240, "td"),
      record("td-2", 120, "td"),
      record("tdap", 6, "tdap"),
    ];
    const series = deriveSeries(history);
    expect(series.get("tdap")).toEqual([
      { antigen: "tetanus", position: 3, total: 3, booster: false },
      { antigen: "diphtheria", position: 3, total: 3, booster: false },
      { antigen: "pertussis", position: 1, total: 3, booster: false },
    ]);
  });

  it("counts a six-antigen infant dose into all six", () => {
    const series = deriveSeries([record("hex", 400, "hexavalent")]);
    expect(series.get("hex")?.map((entry) => entry.antigen)).toEqual([
      "diphtheria",
      "tetanus",
      "pertussis",
      "polio",
      "hib",
      "hepatitis-b",
    ]);
    expect(
      series.get("hex")?.every((entry) => entry.position === 1),
      "the first dose of a combination is the first of each of its series",
    ).toBe(true);
  });

  it("lets a monovalent dose continue a series a combination started", () => {
    const series = deriveSeries([
      record("mmr", 400, "mmr"),
      record("measles-only", 396, "measles"),
    ]);
    expect(series.get("measles-only")).toEqual([
      { antigen: "measles", position: 2, total: 2, booster: false },
    ]);
  });
});

describe("position and total prefer what the record itself says", () => {
  it("takes the Pass's own dose number over the chronological count", () => {
    // Someone transcribing only the last line of a page they never entered
    // the rest of: they are right about their history, the count is not.
    const series = deriveSeries([
      record("only-entry", 6, "hepatitis-b", { doseNumber: 3 }),
    ]);
    expect(series.get("only-entry")).toEqual([
      { antigen: "hepatitis-b", position: 3, total: 3, booster: false },
    ]);
  });

  it("takes the record's own series length over the catalogue's", () => {
    // HPV is two doses when the course starts early and three when it starts
    // later; the override is for the person whose Pass says three.
    const series = deriveSeries([
      record("hpv-1", 24, "hpv", { seriesDoses: 3 }),
      record("hpv-2", 22, "hpv", { seriesDoses: 3 }),
      record("hpv-3", 18, "hpv", { seriesDoses: 3 }),
    ]);
    expect(series.get("hpv-3")).toEqual([
      { antigen: "hpv", position: 3, total: 3, booster: false },
    ]);
  });

  it("reports a null total for a seasonal dose that is not part of a series", () => {
    // Influenza has no series length, so there is no "of M" to report and
    // nothing to be past the end of. Five annual doses are five first doses
    // of five different years, never four boosters.
    const series = deriveSeries([
      record("flu-1", 39, "influenza"),
      record("flu-2", 27, "influenza"),
      record("flu-3", 15, "influenza"),
      record("flu-4", 3, "influenza"),
    ]);
    expect(series.get("flu-4")).toEqual([
      { antigen: "influenza", position: 4, total: null, booster: false },
    ]);
    expect(
      [1, 2, 3, 4].every((n) => series.get(`flu-${n}`)?.[0].booster === false),
      "a null total means nothing can be past the end of it",
    ).toBe(true);
  });
});

describe("a dose past the end of its series reads as a booster", () => {
  it("marks the fourth hepatitis B dose after a completed three-dose primary", () => {
    const series = deriveSeries([
      record("hb-1", 300, "hepatitis-b"),
      record("hb-2", 299, "hepatitis-b"),
      record("hb-3", 294, "hepatitis-b"),
      record("hb-later", 60, "hepatitis-b"),
    ]);
    expect(series.get("hb-3")?.[0].booster).toBe(false);
    expect(series.get("hb-later")).toEqual([
      { antigen: "hepatitis-b", position: 4, total: 3, booster: true },
    ]);
  });

  it("marks every tetanus dose after the primary series, not just the first", () => {
    const series = deriveSeries([
      record("t1", 480, "tetanus"),
      record("t2", 476, "tetanus"),
      record("t3", 468, "tetanus"),
      record("t4", 348, "tetanus"),
      record("t5", 228, "tetanus"),
      record("t6", 108, "tetanus"),
    ]);
    expect(["t4", "t5", "t6"].map((id) => series.get(id)?.[0].booster)).toEqual(
      [true, true, true],
    );
  });

  it("marks a booster per component, so a combination can be both at once", () => {
    // Tetanus is long finished; pertussis has never been given. One Tdap dose
    // is a tetanus booster and a first pertussis dose in the same act.
    const history = [
      record("t1", 480, "tetanus"),
      record("t2", 476, "tetanus"),
      record("t3", 468, "tetanus"),
      record("tdap", 2, "tdap"),
    ];
    const series = deriveSeries(history);
    const tdap = series.get("tdap") ?? [];
    expect(tdap.find((e) => e.antigen === "tetanus")).toEqual({
      antigen: "tetanus",
      position: 4,
      total: 3,
      booster: true,
    });
    expect(tdap.find((e) => e.antigen === "pertussis")).toEqual({
      antigen: "pertussis",
      position: 1,
      total: 3,
      booster: false,
    });
  });
});

describe("a record with no resolvable antigen yields nothing", () => {
  it("returns an empty array for a free-text-only row", () => {
    const series = deriveSeries([record("free-text", 12, null)]);
    expect(
      series.get("free-text"),
      "a name string is not evidence about which antigens were given",
    ).toEqual([]);
  });

  it("returns an empty array for a slug the catalogue no longer lists", () => {
    const series = deriveSeries([record("orphan", 400, "retired-slug")]);
    expect(series.get("orphan")).toEqual([]);
  });

  it("keeps a key for every input, resolvable or not", () => {
    // Total in the mathematical sense: a caller reading a missing key as "no
    // series" and one reading it as "not computed" would disagree about the
    // same dose.
    const history = [
      record("a", 12, "tetanus"),
      record("b", 6, null),
      record("c", 3, "retired-slug"),
    ];
    const series = deriveSeries(history);
    expect([...series.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  it("does not let an unresolvable row shift the positions around it", () => {
    const series = deriveSeries([
      record("t1", 300, "tetanus"),
      record("free", 200, null),
      record("t2", 100, "tetanus"),
    ]);
    expect(series.get("t2")?.[0].position).toBe(2);
  });
});
