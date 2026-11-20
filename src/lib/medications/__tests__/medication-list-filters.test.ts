import { describe, expect, it } from "vitest";
import { ALL_MEDICATION_CATEGORIES } from "@/lib/medications/category-filter";
import {
  matchesMedicationFilters,
  filterMedications,
  type MedicationFilterable,
} from "../medication-list-filters";

describe("matchesMedicationFilters & filterMedications", () => {
  const sampleMeds: MedicationFilterable[] = [
    {
      name: "Aspirin 100mg",
      category: "PAIN",
      courses: [
        { startsOn: "2026-01-01", endsOn: "2026-01-10" },
        { startsOn: "2026-02-01", endsOn: "2026-02-10" },
      ],
    },
    {
      name: "Ramipril 5mg",
      category: "HEART",
      courses: [
        { startsOn: "2026-01-15", endsOn: null }, // open ended
      ],
    },
    {
      name: "Ibuprofen 400mg",
      category: "PAIN",
      // Legacy with both startsOn and endsOn
      startsOn: "2026-03-01",
      endsOn: "2026-03-15",
    },
    {
      name: "Vitamin D3",
      category: "SUPPLEMENT",
      // Legacy with known end only (open start)
      startsOn: null,
      endsOn: "2026-01-20",
    },
    {
      name: "Metformin 500mg",
      category: "DIABETES",
      // Legacy with known start only (open end)
      startsOn: "2026-01-20",
      endsOn: null,
    },
    {
      name: "Unknown Elixir",
      category: "OTHER",
      // Legacy with neither start nor end
      startsOn: null,
      endsOn: null,
    },
  ];

  describe("Name substring filter (q)", () => {
    it("matches case-insensitively with trimmed input", () => {
      const result = filterMedications(sampleMeds, { q: "  aspi  " });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Aspirin 100mg");
    });

    it("matches all medications when query is empty or whitespace", () => {
      expect(filterMedications(sampleMeds, { q: "" })).toHaveLength(6);
      expect(filterMedications(sampleMeds, { q: "   " })).toHaveLength(6);
    });

    it("returns empty when query does not match", () => {
      expect(filterMedications(sampleMeds, { q: "nonexistent" })).toHaveLength(
        0,
      );
    });
  });

  describe("Category filter", () => {
    it("filters by category key", () => {
      const painMeds = filterMedications(sampleMeds, { category: "PAIN" });
      expect(painMeds.map((m) => m.name)).toEqual([
        "Aspirin 100mg",
        "Ibuprofen 400mg",
      ]);
    });

    it("matches all categories when category is ALL_MEDICATION_CATEGORIES or empty", () => {
      expect(
        filterMedications(sampleMeds, { category: ALL_MEDICATION_CATEGORIES }),
      ).toHaveLength(6);
      expect(filterMedications(sampleMeds, {})).toHaveLength(6);
    });
  });

  describe("Treatment period date range filter (fromDay / toDay)", () => {
    it("matches course inclusive overlap with both bounds provided", () => {
      // Course 1: 2026-01-01 to 2026-01-10
      const res = filterMedications(sampleMeds, {
        fromDay: "2026-01-05",
        toDay: "2026-01-08",
      });
      expect(res.map((m) => m.name)).toContain("Aspirin 100mg");
    });

    it("matches boundary inclusion (exact startsOn and endsOn match)", () => {
      const resStarts = filterMedications(sampleMeds, {
        fromDay: "2026-01-01",
        toDay: "2026-01-01",
      });
      expect(resStarts.map((m) => m.name)).toContain("Aspirin 100mg");

      const resEnds = filterMedications(sampleMeds, {
        fromDay: "2026-01-10",
        toDay: "2026-01-10",
      });
      expect(resEnds.map((m) => m.name)).toContain("Aspirin 100mg");
    });

    it("does NOT match gap between independent courses", () => {
      // Aspirin has course 1: 01-01 to 01-10, course 2: 02-01 to 02-10.
      // 01-11 to 01-14 is in the gap.
      const res = filterMedications(sampleMeds, {
        fromDay: "2026-01-11",
        toDay: "2026-01-14",
      });
      expect(res.map((m) => m.name)).not.toContain("Aspirin 100mg");
    });

    it("treats null course end as open (+Infinity)", () => {
      // Ramipril: starts 2026-01-15, endsOn: null
      const resFuture = filterMedications(sampleMeds, {
        fromDay: "2028-05-01",
        toDay: "2028-05-10",
      });
      expect(resFuture.map((m) => m.name)).toEqual([
        "Ramipril 5mg",
        "Metformin 500mg",
      ]);

      const resBeforeStart = filterMedications(sampleMeds, {
        fromDay: "2026-01-01",
        toDay: "2026-01-14",
      });
      expect(resBeforeStart.map((m) => m.name)).not.toContain("Ramipril 5mg");
    });

    it("supports optional fromDay only (toDay unbound / +Infinity)", () => {
      const res = filterMedications(sampleMeds, { fromDay: "2026-03-10" });
      // Ibuprofen ends 03-15; Ramipril & Metformin open-ended
      expect(res.map((m) => m.name)).toEqual([
        "Ramipril 5mg",
        "Ibuprofen 400mg",
        "Metformin 500mg",
      ]);
    });

    it("supports optional toDay only (fromDay unbound / -Infinity)", () => {
      const res = filterMedications(sampleMeds, { toDay: "2026-01-02" });
      // Aspirin started 01-01; Vitamin D3 ended 01-20 (open start)
      expect(res.map((m) => m.name)).toEqual(["Aspirin 100mg", "Vitamin D3"]);
    });

    it("handles legacy rows with known end only (open start -Infinity)", () => {
      // Vitamin D3 ends 2026-01-20, startsOn: null
      const res = filterMedications(sampleMeds, {
        fromDay: "2025-01-01",
        toDay: "2025-12-31",
      });
      expect(res.map((m) => m.name)).toContain("Vitamin D3");
    });

    it("excludes legacy rows with neither start nor end ONLY when date filter is active", () => {
      // Active date filter: "Unknown Elixir" is excluded
      const withFilter = filterMedications(sampleMeds, {
        fromDay: "2026-01-01",
      });
      expect(withFilter.map((m) => m.name)).not.toContain("Unknown Elixir");

      // Inactive date filter: "Unknown Elixir" is included
      const withoutFilter = filterMedications(sampleMeds, {});
      expect(withoutFilter.map((m) => m.name)).toContain("Unknown Elixir");
    });

    it("ignores date predicate while dates are reversed (fromDay > toDay) but still enforces other filters", () => {
      const res = filterMedications(sampleMeds, {
        fromDay: "2026-05-01",
        toDay: "2026-01-01", // reversed!
      });
      // All items pass because date predicate is ignored when reversed
      expect(res).toHaveLength(sampleMeds.length);

      // Search and category are still enforced when date predicate is bypassed
      const filteredBySearch = filterMedications(sampleMeds, {
        q: "Aspirin",
        fromDay: "2026-05-01",
        toDay: "2026-01-01",
      });
      expect(filteredBySearch.map((m) => m.name)).toEqual(["Aspirin 100mg"]);

      const filteredByCategory = filterMedications(sampleMeds, {
        category: "HEART",
        fromDay: "2026-05-01",
        toDay: "2026-01-01",
      });
      expect(filteredByCategory.map((m) => m.name)).toEqual(["Ramipril 5mg"]);
    });

    it("defensively excludes courses with neither start nor end during active date filtering", () => {
      const medWithDatelessCourse: MedicationFilterable = {
        name: "Dateless Course Med",
        category: "OTHER",
        courses: [{ startsOn: null, endsOn: null }],
      };
      expect(
        matchesMedicationFilters(medWithDatelessCourse, {
          fromDay: "2026-01-01",
          toDay: "2026-01-10",
        }),
      ).toBe(false);
      // But passes when no date filter is active
      expect(matchesMedicationFilters(medWithDatelessCourse, {})).toBe(true);
    });

    it("operates timezone-neutrally on calendar day string comparisons", () => {
      const med: MedicationFilterable = {
        name: "Test",
        category: "OTHER",
        courses: [
          {
            startsOn: "2026-06-15T00:00:00.000Z",
            endsOn: "2026-06-20T23:59:59.000Z",
          },
        ],
      };
      expect(
        matchesMedicationFilters(med, {
          fromDay: "2026-06-15",
          toDay: "2026-06-20",
        }),
      ).toBe(true);
      expect(
        matchesMedicationFilters(med, {
          fromDay: "2026-06-21",
        }),
      ).toBe(false);
    });
  });

  describe("Combined filters (AND)", () => {
    it("requires search, category, and date range to all match", () => {
      const res = filterMedications(sampleMeds, {
        q: "Aspirin",
        category: "PAIN",
        fromDay: "2026-01-05",
        toDay: "2026-01-08",
      });
      expect(res.map((m) => m.name)).toEqual(["Aspirin 100mg"]);

      // Wrong category -> fails
      expect(
        filterMedications(sampleMeds, {
          q: "Aspirin",
          category: "HEART",
          fromDay: "2026-01-05",
          toDay: "2026-01-08",
        }),
      ).toHaveLength(0);

      // Outside date range -> fails
      expect(
        filterMedications(sampleMeds, {
          q: "Aspirin",
          category: "PAIN",
          fromDay: "2026-01-15",
          toDay: "2026-01-20",
        }),
      ).toHaveLength(0);
    });
  });
});
