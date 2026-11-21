/**
 * The chip row in order of use and each symptom's preset intensity: the
 * symptoms a person logs most come first, and a picked one starts on the
 * intensity it had last time.
 */
import { describe, expect, it } from "vitest";

import {
  latestIntensityById,
  orderSymptomsByUse,
} from "../symptom-chip-filter";

const def = (id: string, count30d: number, lastOccurredAt: string | null) => ({
  id,
  recent: { count30d, lastOccurredAt },
});

describe("orderSymptomsByUse", () => {
  it("puts the most used first, breaks a tie by recency, keeps the rest", () => {
    const list = [
      def("aura", 0, null),
      def("headache", 2, "2026-11-10T08:00:00Z"),
      def("nausea", 5, "2026-11-01T08:00:00Z"),
      def("dizzy", 2, "2026-11-19T08:00:00Z"),
      def("fever", 0, "2026-08-01T08:00:00Z"),
    ];
    expect(orderSymptomsByUse(list).map((d) => d.id)).toEqual([
      "nausea",
      "dizzy",
      "headache",
      "aura",
      "fever",
    ]);
  });
});

describe("latestIntensityById", () => {
  it("takes each symptom's newest occurrence", () => {
    const latest = latestIntensityById([
      { definitionId: "nausea", intensity: 6 },
      { definitionId: "headache", intensity: 3 },
      { definitionId: "nausea", intensity: 2 },
    ]);
    expect(latest.get("nausea")).toBe(6);
    expect(latest.get("headache")).toBe(3);
    expect(latest.has("aura")).toBe(false);
  });
});
