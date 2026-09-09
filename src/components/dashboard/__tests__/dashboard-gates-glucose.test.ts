/**
 * #943 — the Blood Glucose tile must not depend on a meal-time tag.
 *
 * A reporter's meter syncs through Apple Health and never writes HealthKit's
 * blood-glucose meal-time metadata, so all 358 of their readings carry an
 * empty `glucose_context`. The tile strip fanned out over the four named
 * contexts only, found none of them populated, and omitted the tile — with
 * the glucose module on, the layout toggle on, and a reading from today.
 *
 * These cases pin the untagged bucket: it counts toward eligibility and
 * carries the latest value and the trend, while a tagged account still gets
 * its per-context breakdown.
 */
import { describe, expect, it } from "vitest";

import { resolveGlucoseTiles } from "../dashboard-gates";
import type { DataSummary } from "@/lib/analytics/trends";

function summary(overrides: Partial<DataSummary> = {}): DataSummary {
  return {
    count: 12,
    latest: 118,
    min: 92,
    max: 149,
    mean: 117,
    median: 116,
    avg7: 119,
    avg30: 117,
    slope7: null,
    slope30: { slope: 0.4, direction: "up", confidence: 0.6 },
    ...overrides,
  };
}

describe("resolveGlucoseTiles (#943)", () => {
  it("is eligible when every reading is untagged", () => {
    const tiles = resolveGlucoseTiles({
      UNSPECIFIED: summary({ count: 358, latest: 104 }),
    });

    expect(tiles).toHaveLength(1);
    expect(tiles[0].bucket).toBe("UNSPECIFIED");
    expect(tiles[0].summary.latest).toBe(104);
    expect(tiles[0].summary.slope30).not.toBeNull();
  });

  it("keeps the named breakdown and appends the untagged bucket last", () => {
    const tiles = resolveGlucoseTiles({
      FASTING: summary({ count: 5 }),
      BEDTIME: summary({ count: 3 }),
      UNSPECIFIED: summary({ count: 9 }),
    });

    expect(tiles.map((tile) => tile.bucket)).toEqual([
      "FASTING",
      "BEDTIME",
      "UNSPECIFIED",
    ]);
  });

  it("stays ineligible when nothing is logged", () => {
    expect(resolveGlucoseTiles(undefined)).toEqual([]);
    expect(resolveGlucoseTiles({})).toEqual([]);
    expect(resolveGlucoseTiles({ UNSPECIFIED: summary({ count: 0 }) })).toEqual(
      [],
    );
  });

  it("names every bucket it emits", () => {
    const tiles = resolveGlucoseTiles({
      RANDOM: summary(),
      UNSPECIFIED: summary(),
    });

    for (const tile of tiles) {
      expect(tile.labelKey).toMatch(/^targets\.glucose/);
    }
  });
});
