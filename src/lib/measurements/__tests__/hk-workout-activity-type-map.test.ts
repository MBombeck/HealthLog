import { describe, expect, it } from "vitest";
import {
  HK_WORKOUT_ACTIVITY_TYPE_MAP,
  resolveHkWorkoutSportType,
} from "../hk-workout-activity-type-map";
import { workoutSportTypeEnum } from "@/lib/validations/workout";

describe("HK_WORKOUT_ACTIVITY_TYPE_MAP", () => {
  it("only references sport types that exist in the canonical enum", () => {
    const valid = new Set<string>(workoutSportTypeEnum.options);
    for (const [hkType, sport] of Object.entries(
      HK_WORKOUT_ACTIVITY_TYPE_MAP,
    )) {
      expect(
        valid.has(sport),
        `${hkType} maps to '${sport}', not in workoutSportTypeEnum`,
      ).toBe(true);
    }
  });

  it("covers the iOS 18 canonical roster", () => {
    // Spot-check the most commonly observed identifiers; full
    // exhaustiveness is impractical because Apple silently adds
    // identifiers between iOS releases.
    const canonical = [
      "HKWorkoutActivityTypeRunning",
      "HKWorkoutActivityTypeWalking",
      "HKWorkoutActivityTypeCycling",
      "HKWorkoutActivityTypeHiking",
      "HKWorkoutActivityTypeSwimming",
      "HKWorkoutActivityTypeYoga",
      "HKWorkoutActivityTypeHighIntensityIntervalTraining",
      "HKWorkoutActivityTypeFunctionalStrengthTraining",
      "HKWorkoutActivityTypeOther",
    ];
    for (const hkType of canonical) {
      expect(
        HK_WORKOUT_ACTIVITY_TYPE_MAP[hkType],
        `${hkType} missing from map`,
      ).toBeDefined();
    }
  });
});

describe("resolveHkWorkoutSportType", () => {
  it("returns the mapped sport and a `known` flag for a known identifier", () => {
    expect(resolveHkWorkoutSportType("HKWorkoutActivityTypeRunning")).toEqual({
      sportType: "running",
      known: true,
    });
  });

  it("falls back to 'other' with a falsy known flag", () => {
    const out = resolveHkWorkoutSportType("HKWorkoutActivityTypeFutureTypeXYZ");
    expect(out.sportType).toBe("other");
    expect(out.known).toBe(false);
  });
});
