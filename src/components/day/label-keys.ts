/**
 * The message key of every code the day view words (v1.42, #613).
 *
 * Maps rather than template keys, for the reason in
 * `components/timeline/label-keys.ts`: each is typed over the code's own
 * union, and `label-keys.test.ts` resolves every value against the bundle.
 */
import type { AllergySeverity, FlowLevel } from "@/generated/prisma/client";
import type { DayNotableKind } from "@/lib/day/contract";
import type { InstrumentId } from "@/lib/mental-health/instruments";
import type { WorkoutSportType } from "@/lib/validations/workout";

export const DAY_NOTABLE_KEY: Readonly<Record<DayNotableKind, string>> = {
  extremeHigh: "day.notable.extremeHigh",
  extremeLow: "day.notable.extremeLow",
  firstValue: "day.notable.firstValue",
  gap: "day.notable.gap",
};

export const CYCLE_FLOW_KEY: Readonly<Record<FlowLevel, string>> = {
  NONE: "cycle.flow.NONE",
  SPOTTING: "cycle.flow.SPOTTING",
  LIGHT: "cycle.flow.LIGHT",
  MEDIUM: "cycle.flow.MEDIUM",
  HEAVY: "cycle.flow.HEAVY",
};

export const ALLERGY_SEVERITY_KEY: Readonly<Record<AllergySeverity, string>> = {
  MILD: "records.allergies.severity.MILD",
  MODERATE: "records.allergies.severity.MODERATE",
  SEVERE: "records.allergies.severity.SEVERE",
};

export const ASSESSMENT_INSTRUMENT_KEY: Readonly<Record<InstrumentId, string>> =
  {
    PHQ9: "mentalHealth.instrument.phq9",
    GAD7: "mentalHealth.instrument.gad7",
    WHO5: "mentalHealth.instrument.who5",
    SCI: "mentalHealth.instrument.sci",
  };

/** Each screener's bands (`instruments.ts`), by the band key it stores. */
export const ASSESSMENT_BAND_KEY: Readonly<
  Record<InstrumentId, Readonly<Record<string, string>>>
> = {
  PHQ9: {
    minimal: "mentalHealth.band.PHQ9.minimal",
    mild: "mentalHealth.band.PHQ9.mild",
    moderate: "mentalHealth.band.PHQ9.moderate",
    modSevere: "mentalHealth.band.PHQ9.modSevere",
    severe: "mentalHealth.band.PHQ9.severe",
  },
  GAD7: {
    minimal: "mentalHealth.band.GAD7.minimal",
    mild: "mentalHealth.band.GAD7.mild",
    moderate: "mentalHealth.band.GAD7.moderate",
    severe: "mentalHealth.band.GAD7.severe",
  },
  WHO5: {
    low: "mentalHealth.band.WHO5.low",
    good: "mentalHealth.band.WHO5.good",
  },
  SCI: {
    belowThreshold: "mentalHealth.band.SCI.belowThreshold",
    aboveThreshold: "mentalHealth.band.SCI.aboveThreshold",
  },
};

export const WORKOUT_SPORT_KEY: Readonly<Record<WorkoutSportType, string>> = {
  walking: "insights.workouts.sport.walking",
  running: "insights.workouts.sport.running",
  cycling: "insights.workouts.sport.cycling",
  hiking: "insights.workouts.sport.hiking",
  swimming: "insights.workouts.sport.swimming",
  rowing: "insights.workouts.sport.rowing",
  elliptical: "insights.workouts.sport.elliptical",
  stairClimber: "insights.workouts.sport.stairClimber",
  yoga: "insights.workouts.sport.yoga",
  mindAndBody: "insights.workouts.sport.mindAndBody",
  strength: "insights.workouts.sport.strength",
  hiit: "insights.workouts.sport.hiit",
  dance: "insights.workouts.sport.dance",
  golf: "insights.workouts.sport.golf",
  badminton: "insights.workouts.sport.badminton",
  tennis: "insights.workouts.sport.tennis",
  basketball: "insights.workouts.sport.basketball",
  soccer: "insights.workouts.sport.soccer",
  crossTraining: "insights.workouts.sport.crossTraining",
  mixedCardio: "insights.workouts.sport.mixedCardio",
  other: "insights.workouts.sport.other",
};

/** An illness day's functional impact, 0 (fully functional) to 3. */
export const ILLNESS_IMPACT_KEY: Readonly<Record<string, string>> = {
  "0": "illness.impact.0",
  "1": "illness.impact.1",
  "2": "illness.impact.2",
  "3": "illness.impact.3",
};
