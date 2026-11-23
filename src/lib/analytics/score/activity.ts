import type { Derived } from "@/lib/insights/derived/types";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";

import type { ActivityPillarInput, PillarValue } from "./types";
import {
  clampScore,
  coverage,
  failedPillar,
  insufficientPillar,
  okPillar,
  readingSpread,
} from "./shared";
import { mean } from "@/lib/stats/central";

export const ACTIVITY_WINDOW_DAYS = 28;
export const ACTIVITY_MIN_DAYS = 21;
export const OLDER_ADULT_AGE = 60;
export const YOUNGER_STEP_PLATEAU = 10_000;
export const OLDER_STEP_PLATEAU = 8_000;

/**
 * The activity window: the `ACTIVITY_WINDOW_DAYS` completed local days that
 * end yesterday, as inclusive `YYYY-MM-DD` keys. Today is left out because
 * its step total is still growing: counting it pulled every score computed
 * during the day down by a partial day.
 */
export function activityWindowKeys(
  asOf: Date,
  timezone: string,
): { startDay: string; endDay: string } {
  const today = userDayKey(asOf, timezone);
  return {
    startDay: shiftDateKey(today, -ACTIVITY_WINDOW_DAYS),
    endDay: shiftDateKey(today, -1),
  };
}

export function computeActivityPillar(
  input: ActivityPillarInput,
): Derived<PillarValue> {
  if (input.readFailed) {
    return failedPillar({
      id: "ACTIVITY",
      asOf: input.asOf,
      windowDays: ACTIVITY_WINDOW_DAYS,
    });
  }

  const { startDay, endDay } = activityWindowKeys(input.asOf, input.timezone);
  const points = input.days.filter(
    (point) => point.day <= endDay && point.day >= startDay,
  );
  if (points.length < ACTIVITY_MIN_DAYS) {
    return insufficientPillar({
      id: "ACTIVITY",
      source: input.source,
      asOf: input.asOf,
      windowDays: ACTIVITY_WINDOW_DAYS,
      requiredInputs: ACTIVITY_MIN_DAYS,
      presentInputs: points.length,
      historyDays: points.length,
      missing: [`${Math.max(0, ACTIVITY_MIN_DAYS - points.length)} days`],
      reason:
        input.days.length > 0 ? "below_day_floor_or_stale" : "not_tracked",
    });
  }

  const values = points.map((point) => point.value);
  // The day floor above guarantees days here.
  const observed = mean(values)!;
  const plateau =
    input.ageYears != null && input.ageYears >= OLDER_ADULT_AGE
      ? OLDER_STEP_PLATEAU
      : YOUNGER_STEP_PLATEAU;
  const score = clampScore((observed / plateau) * 100);
  const noiseFloor = Math.max(
    1,
    Math.round(((0.5 * readingSpread(values)) / plateau) * 100),
  );
  const latestDay = [...points].sort((a, b) => b.day.localeCompare(a.day))[0];

  return okPillar({
    id: "ACTIVITY",
    source: input.source,
    asOf: input.asOf,
    windowDays: ACTIVITY_WINDOW_DAYS,
    coverage: coverage({
      requiredInputs: ACTIVITY_MIN_DAYS,
      presentInputs: ACTIVITY_MIN_DAYS,
      historyDays: points.length,
    }),
    value: {
      score,
      observed: {
        value: Math.round(observed),
        unit: "steps/day",
        label: `${Math.round(observed).toLocaleString("en-US")} steps/day`,
        asOf: `${latestDay.day}T00:00:00.000Z`,
        sources: input.sources,
      },
      reference: {
        kind: "guideline-band",
        low: 0,
        high: plateau,
        label: `benefit plateaus by ${plateau.toLocaleString("en-US")} steps/day`,
        source: "Paluch 2022",
      },
      noiseFloor,
      deltaEligible: true,
      deltaIdentity: "ACTIVITY_STEPS",
    },
  });
}
