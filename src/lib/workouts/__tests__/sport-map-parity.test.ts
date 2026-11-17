/**
 * Cross-integration sport-mapping parity.
 *
 * Every workout integration normalises its raw sport label to HealthLog's
 * canonical `WorkoutSportType` at ingest time: Google Health
 * (`mapGoogleHealthSportType()`), WHOOP (`mapWhoopSportType()`), and — as of
 * the Strava-brick-collapse fix — Strava (`mapStravaSportType()`). This
 * table-driven suite checks the mappers together so a future integration or a re-tuned mapping can't
 * silently drift out of parity: every mapper must (a) only ever return a
 * value from `workoutSportTypeEnum`, (b) default unmapped/garbage input to
 * `"other"`, never throw or return the raw input, and (c) agree on the
 * handful of sports every wearable reports (walking, running, cycling,
 * swimming, strength, yoga, hiit).
 */
import { describe, expect, it } from "vitest";

import { mapGoogleHealthSportType } from "@/lib/google-health/mappers";
import { mapWhoopSportType } from "@/lib/whoop/sport-map";
import { mapStravaSportType } from "@/lib/strava/sport-map";
import { workoutSportTypeEnum } from "@/lib/validations/workout";

type Mapper = (raw: string) => string;

const MAPPERS: Record<string, Mapper> = {
  googleHealth: (raw) => mapGoogleHealthSportType(raw),
  // WHOOP's mapper takes (sportId, sportName) — exercise it via sport_name
  // to line up with the other integrations' string-in shape.
  whoop: (raw) => mapWhoopSportType(undefined, raw),
  strava: (raw) => mapStravaSportType(raw),
};

describe("sport-map parity — every mapper only emits canonical values", () => {
  const valid = new Set(workoutSportTypeEnum.options);

  it.each(Object.entries(MAPPERS))(
    "%s: garbage input resolves to 'other', never throws, never echoes the raw string",
    (_name, mapper) => {
      for (const garbage of ["", "   ", "not-a-real-sport", "🚴", "NaN"]) {
        expect(() => mapper(garbage)).not.toThrow();
        const result = mapper(garbage);
        expect(
          valid.has(result as (typeof workoutSportTypeEnum.options)[number]),
        ).toBe(true);
      }
    },
  );
});

/**
 * Common-sport agreement table. Each row is one real-world activity every
 * wearable reports; `labels` gives each mapper its OWN vocabulary for that
 * activity (integrations don't share a wire format), and `expected` is the
 * canonical bucket all three must land on.
 */
const COMMON_SPORTS: Array<{
  expected: string;
  labels: {
    googleHealth: string;
    whoop: string;
    strava: string;
  };
}> = [
  {
    expected: "walking",
    labels: {
      googleHealth: "WALKING",
      whoop: "Walking",
      strava: "Walk",
    },
  },
  {
    expected: "running",
    labels: {
      googleHealth: "RUNNING",
      whoop: "Running",
      strava: "Run",
    },
  },
  {
    expected: "cycling",
    labels: {
      googleHealth: "BIKING",
      whoop: "Cycling",
      strava: "Ride",
    },
  },
  {
    expected: "swimming",
    labels: {
      googleHealth: "SWIMMING",
      whoop: "Swimming",
      strava: "Swim",
    },
  },
  {
    expected: "strength",
    labels: {
      googleHealth: "STRENGTH_TRAINING",
      whoop: "Weightlifting",
      strava: "WeightTraining",
    },
  },
  {
    expected: "yoga",
    labels: {
      googleHealth: "YOGA",
      whoop: "Yoga",
      strava: "Yoga",
    },
  },
  {
    expected: "hiit",
    labels: {
      googleHealth: "HIIT",
      whoop: "HIIT",
      strava: "HighIntensityIntervalTraining",
    },
  },
  {
    expected: "golf",
    labels: {
      googleHealth: "GOLF",
      whoop: "Golf",
      strava: "Golf",
    },
  },
  {
    expected: "tennis",
    labels: {
      googleHealth: "TENNIS",
      whoop: "Tennis",
      strava: "Tennis",
    },
  },
  {
    expected: "rowing",
    labels: {
      googleHealth: "ROWING",
      whoop: "Rowing",
      strava: "Rowing",
    },
  },
];

describe("sport-map parity — Google Health / WHOOP / Strava agree on common sports", () => {
  it.each(COMMON_SPORTS)(
    "$expected: all three integrations map to the same canonical bucket",
    ({ expected, labels }) => {
      expect(mapGoogleHealthSportType(labels.googleHealth)).toBe(expected);
      expect(mapWhoopSportType(undefined, labels.whoop)).toBe(expected);
      expect(mapStravaSportType(labels.strava)).toBe(expected);
    },
  );
});

describe("sport-map parity — the confirmed bug, guarded across integrations", () => {
  it("a cycling workout NEVER lands on a non-canonical / provider-specific string", () => {
    for (const [name, mapper] of Object.entries(MAPPERS)) {
      const cyclingLabels: Record<string, string> = {
        googleHealth: "BIKING",
        whoop: "Cycling",
        strava: "Ride",
      };
      const result = mapper(cyclingLabels[name]!);
      expect(result).toBe("cycling");
    }
  });

  it("a Strava workout NEVER lands on the raw PascalCase label (the brick-collapse root cause)", () => {
    for (const raw of ["Run", "Ride", "VirtualRide", "TrailRun", "Workout"]) {
      const result = mapStravaSportType(raw);
      expect(result).not.toBe(raw);
      expect(
        (workoutSportTypeEnum.options as readonly string[]).includes(result),
      ).toBe(true);
    }
  });
});
