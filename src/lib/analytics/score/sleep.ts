import {
  scoreConsistency,
  scoreSufficiency,
  sleepNeedMinutes,
} from "@/lib/insights/derived/sleep-score";
import type { Derived } from "@/lib/insights/derived/types";
import { userDayKey } from "@/lib/tz/format";

import type { PillarValue, SleepPillarInput } from "./types";
import {
  coverage,
  failedPillar,
  insufficientPillar,
  okPillar,
  readingSpread,
} from "./shared";
import { mean } from "@/lib/stats/central";

export const SLEEP_WINDOW_DAYS = 28;
export const SLEEP_MIN_NIGHTS = 14;
export const SLEEP_REGULARITY_MIN_NIGHTS = 21;

export function computeSleepPillar(
  input: SleepPillarInput,
): Derived<PillarValue> {
  if (input.readFailed) {
    return failedPillar({
      id: "SLEEP",
      asOf: input.asOf,
      windowDays: SLEEP_WINDOW_DAYS,
    });
  }

  const asOfDay = userDayKey(input.asOf, input.timezone);
  const sinceDay = userDayKey(
    new Date(input.asOf.getTime() - (SLEEP_WINDOW_DAYS - 1) * 86_400_000),
    input.timezone,
  );
  const nights = input.nights
    .filter((night) => night.night <= asOfDay && night.night >= sinceDay)
    .sort((a, b) => a.night.localeCompare(b.night));

  if (nights.length < SLEEP_MIN_NIGHTS) {
    return insufficientPillar({
      id: "SLEEP",
      source: input.source,
      asOf: input.asOf,
      windowDays: SLEEP_WINDOW_DAYS,
      requiredInputs: SLEEP_MIN_NIGHTS,
      presentInputs: nights.length,
      historyDays: nights.length,
      missing: [`${Math.max(0, SLEEP_MIN_NIGHTS - nights.length)} nights`],
      reason:
        input.nights.length > 0 ? "below_night_floor_or_stale" : "not_tracked",
    });
  }

  const asleepValues = nights.map((night) => night.asleepMinutes);
  // The night floor above guarantees nights here.
  const observed = mean(asleepValues)!;
  const need = sleepNeedMinutes(input.ageYears);
  const sufficiency = scoreSufficiency(observed, need) ?? 0;
  const midpoints = nights
    .map((night) => night.midpoint)
    .filter((midpoint): midpoint is number => midpoint != null);
  // The floor is on the nights that have a place on the clock: a day whose
  // only sleep was a nap counts toward the level but carries no midpoint, so
  // 21 nights could hold far fewer midpoints than the floor asks for.
  const regularity =
    midpoints.length >= SLEEP_REGULARITY_MIN_NIGHTS
      ? scoreConsistency(midpoints)
      : null;
  // These are the existing Sleep Score's own declared sub-score weights,
  // renormalised over the two inputs admitted here: sufficiency 0.3 and
  // consistency 0.2 become 60/40. Below 21 nights the level stands alone.
  const score =
    regularity == null
      ? sufficiency
      : Math.round(sufficiency * 0.6 + regularity * 0.4);
  const noiseFloor = Math.max(
    1,
    Math.round(((0.5 * readingSpread(asleepValues)) / need) * 100),
  );
  const latest = nights.at(-1)!;

  return okPillar({
    id: "SLEEP",
    source: input.source,
    asOf: input.asOf,
    windowDays: SLEEP_WINDOW_DAYS,
    coverage: coverage({
      requiredInputs: SLEEP_MIN_NIGHTS,
      presentInputs: SLEEP_MIN_NIGHTS,
      historyDays: nights.length,
    }),
    value: {
      score,
      observed: {
        value: Math.round(observed),
        unit: "minutes/night",
        label: `${Math.round(observed)} min/night${regularity == null ? "" : " + regularity"}`,
        asOf: `${latest.night}T00:00:00.000Z`,
        sources: input.sources,
      },
      reference: {
        kind: "guideline-band",
        low: need,
        high: null,
        label: `at least ${need} min/night; long sleep is not penalised`,
        source: "NSF 2015; Ai 2021; Daghlas 2019; Windred 2024",
      },
      noiseFloor,
      deltaEligible: true,
      deltaIdentity: "sleep_duration_rhythm",
    },
  });
}
