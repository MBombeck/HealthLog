import { describe, expect, it } from "vitest";

import {
  APPLE_HEALTH_TYPE_MAP,
  HK_QUANTITY_TYPE_DEFERRED,
  mapAppleHealthEntry,
} from "../apple-health-mapping";
import { acceptedHealthKitTypes } from "../healthkit-accepted-types";

describe("acceptedHealthKitTypes", () => {
  it("is exactly the mapping table's identifiers, sorted", () => {
    const accepted = acceptedHealthKitTypes();
    expect(accepted.length).toBeGreaterThan(0);
    expect([...accepted]).toEqual(Object.keys(APPLE_HEALTH_TYPE_MAP).sort());
  });

  it("carries quantity and category identifiers, never a deferred one", () => {
    const accepted = acceptedHealthKitTypes();
    expect(accepted).toContain("HKQuantityTypeIdentifierBodyMass");
    expect(accepted).toContain("HKCategoryTypeIdentifierSleepAnalysis");
    for (const id of accepted) {
      expect(HK_QUANTITY_TYPE_DEFERRED.has(id), id).toBe(false);
    }
    expect(accepted).not.toContain("HKQuantityTypeIdentifierHeight");
    expect(accepted).not.toContain("HKQuantityTypeIdentifierBasalEnergyBurned");
  });

  it("lists only identifiers the batch mapper turns into a row", () => {
    for (const id of acceptedHealthKitTypes()) {
      const out = mapAppleHealthEntry({
        hkIdentifier: id,
        value: 1,
        unit: APPLE_HEALTH_TYPE_MAP[id]!.hkUnit,
        startDate: "2026-01-01T10:00:00.000Z",
        endDate: "2026-01-01T10:00:00.000Z",
        sleepStage: 1,
        categoryValue: 1,
      });
      expect(out, id).not.toBeNull();
    }
    for (const id of HK_QUANTITY_TYPE_DEFERRED) {
      expect(
        mapAppleHealthEntry({
          hkIdentifier: id,
          value: 1,
          unit: "count",
          startDate: "2026-01-01T10:00:00.000Z",
          endDate: "2026-01-01T10:00:00.000Z",
        }),
        id,
      ).toBeNull();
    }
  });
});
