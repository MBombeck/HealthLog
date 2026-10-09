/**
 * The message key of every code the timeline words (v1.42, #613).
 *
 * A key built from a template (`t(\`timeline.zoom.${zoom}\`)`) is invisible to
 * `i18n-call-site-coverage.test.ts`, so a value without its key shipped as
 * the raw key and nothing in the gate noticed. Each code family is a map
 * here instead: typed over the code's own union, so a new code does not
 * compile until it has a key, and walked by `label-keys.test.ts`, which
 * resolves every value against the bundle. `no-template-key-guard.test.ts`
 * keeps the template form out of the timeline and the day view.
 */
import type {
  DayNotableKind,
  LifeEventCategory,
  LifeEventPrecision,
  TimelineBucket,
  TimelineLaneKey,
  TimelineReadinessKey,
  TimelineReadinessStatus,
  TimelineReadinessVerdict,
  TimelineZoom,
} from "@/lib/day/contract";
import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";

import type { LifeEventDraftError } from "./life-event-draft";

export const TIMELINE_LANE_LABEL_KEY: Readonly<
  Record<TimelineLaneKey, string>
> = {
  life: "timeline.lanes.life",
  illness: "timeline.lanes.illness",
  allergies: "timeline.lanes.allergies",
  medications: "timeline.lanes.medications",
  vaccinations: "timeline.lanes.vaccinations",
  visits: "timeline.lanes.visits",
  labs: "timeline.lanes.labs",
  documents: "timeline.lanes.documents",
  cycle: "timeline.lanes.cycle",
};

export const TIMELINE_ZOOM_LABEL_KEY: Readonly<Record<TimelineZoom, string>> = {
  all: "timeline.zoom.all",
  year: "timeline.zoom.year",
  quarter: "timeline.zoom.quarter",
  range: "timeline.zoom.range",
};

export const TIMELINE_LEGEND_MEAN_KEY: Readonly<
  Record<TimelineBucket, string>
> = {
  quarter: "timeline.legendMeanQuarter",
  month: "timeline.legendMeanMonth",
  week: "timeline.legendMeanWeek",
  day: "timeline.legendMeanDay",
};

/** The two blood pressure lines read as their own names on the chart. */
export const TIMELINE_BLOOD_PRESSURE_SERIES_KEY: Readonly<
  Record<"BLOOD_PRESSURE_SYS" | "BLOOD_PRESSURE_DIA", string>
> = {
  BLOOD_PRESSURE_SYS: "timeline.values.series.BLOOD_PRESSURE_SYS",
  BLOOD_PRESSURE_DIA: "timeline.values.series.BLOOD_PRESSURE_DIA",
};

export const TIMELINE_CHRONICLE_NOTABLE_KEY: Readonly<
  Record<DayNotableKind, string>
> = {
  extremeHigh: "timeline.chronicle.notable.extremeHigh",
  extremeLow: "timeline.chronicle.notable.extremeLow",
  firstValue: "timeline.chronicle.notable.firstValue",
  gap: "timeline.chronicle.notable.gap",
};

/** A readiness row's name: the lane's own, or the inventory's for the rest. */
export const TIMELINE_READINESS_LANE_KEY: Readonly<
  Record<TimelineReadinessKey, string>
> = {
  values: "timeline.readiness.lanes.values",
  mood: "timeline.readiness.lanes.mood",
  environment: "timeline.readiness.lanes.environment",
  life: "timeline.readiness.lanes.life",
  illness: "timeline.lanes.illness",
  allergies: "timeline.lanes.allergies",
  medications: "timeline.lanes.medications",
  vaccinations: "timeline.lanes.vaccinations",
  visits: "timeline.lanes.visits",
  labs: "timeline.lanes.labs",
  documents: "timeline.lanes.documents",
  cycle: "timeline.lanes.cycle",
};

export const TIMELINE_READINESS_VERDICT_KEY: Readonly<
  Record<TimelineReadinessVerdict, string>
> = {
  carries: "timeline.readiness.verdict.carries",
  thin: "timeline.readiness.verdict.thin",
};

export const TIMELINE_READINESS_STATUS_KEY: Readonly<
  Record<TimelineReadinessStatus, string>
> = {
  carries: "timeline.readiness.status.carries",
  thin: "timeline.readiness.status.thin",
  empty: "timeline.readiness.status.empty",
};

export const LIFE_EVENT_CATEGORY_KEY: Readonly<
  Record<LifeEventCategory, string>
> = {
  FAMILY: "lifeEvents.category.FAMILY",
  HOME: "lifeEvents.category.HOME",
  WORK: "lifeEvents.category.WORK",
  LOSS: "lifeEvents.category.LOSS",
  OTHER: "lifeEvents.category.OTHER",
};

export const LIFE_EVENT_PRECISION_KEY: Readonly<
  Record<LifeEventPrecision, string>
> = {
  DAY: "lifeEvents.precision.DAY",
  MONTH: "lifeEvents.precision.MONTH",
  YEAR: "lifeEvents.precision.YEAR",
};

export const LIFE_EVENT_ERROR_KEY: Readonly<
  Record<LifeEventDraftError, string>
> = {
  titleRequired: "lifeEvents.errors.titleRequired",
  titleTooLong: "lifeEvents.errors.titleTooLong",
  categoryRequired: "lifeEvents.errors.categoryRequired",
  dateRequired: "lifeEvents.errors.dateRequired",
  endBeforeStart: "lifeEvents.errors.endBeforeStart",
  noteTooLong: "lifeEvents.errors.noteTooLong",
};

export const DOCUMENT_KIND_KEY: Readonly<
  Record<InboundDocumentKindValue, string>
> = {
  DOCTOR_REPORT: "documents.kind.DOCTOR_REPORT",
  DISCHARGE_LETTER: "documents.kind.DISCHARGE_LETTER",
  LAB_RESULT: "documents.kind.LAB_RESULT",
  IMAGING: "documents.kind.IMAGING",
  PRESCRIPTION: "documents.kind.PRESCRIPTION",
  REFERRAL: "documents.kind.REFERRAL",
  INSURANCE: "documents.kind.INSURANCE",
  VACCINATION: "documents.kind.VACCINATION",
  SICK_NOTE: "documents.kind.SICK_NOTE",
  OTHER: "documents.kind.OTHER",
};

/**
 * `map[code]` for a code that arrived as a plain string: the key, or
 * undefined for a code the map does not hold.
 */
export function keyOf<K extends string>(
  map: Readonly<Record<K, string>>,
  code: string,
): string | undefined {
  return Object.hasOwn(map, code) ? map[code as K] : undefined;
}
