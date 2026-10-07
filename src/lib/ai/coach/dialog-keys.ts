/**
 * The message keys of the Coach dialog: live steps, result tables, the
 * method line, follow-up chips, clarifying questions, the reuse caption.
 *
 * One closed catalog, shared by the server (which renders every `label` in
 * the request locale) and the web client (which renders `labelKey` when it
 * has the string, and the server's `label` when it does not). A label never
 * carries model text: it is one of these keys plus server-chosen values
 * (a domain, a window, a count).
 *
 * Every key here exists in all seven bundles; `__tests__/dialog-keys.test.ts`
 * holds that, in both directions for the namespaces this file owns.
 *
 * Client-safe: no server import.
 */
import type { Locale } from "@/lib/i18n/config";
import { pluralKey } from "@/lib/i18n/plural";
import {
  coachScopeSourceSchema,
  type CoachFollowUpKind,
  type CoachMethodEntry,
  type CoachResultGranularity,
  type CoachResultPeriod,
  type CoachScopeWindow,
  type CoachStepDomain,
  type CoachStepReason,
} from "@/lib/ai/coach/types";

// ── Steps ─────────────────────────────────────────────────────────────────

/** The step label templates (`{domain}`, `{window}`). */
export const COACH_STEP_LABEL_KEYS = {
  read: "coach.step.read",
  readWindow: "coach.step.readWindow",
  snapshot: "coach.step.snapshot",
  showResult: "coach.step.showResult",
  reuse: "coach.step.reuse",
} as const;

/** The step list's own chrome. */
export const COACH_STEP_UI_KEYS = {
  headerActive: "coach.step.headerActive",
  listLabel: "coach.step.listLabel",
  toggleShow: "coach.step.toggleShow",
  toggleHide: "coach.step.toggleHide",
  announceDone: "coach.step.announceDone",
} as const;

/** "N readings" on a step row, by plural tier. */
export function stepReadingsKey(count: number, locale: Locale): string {
  return pluralKey("coach.step.readings", count, locale);
}

/** "N rows" on a step row, by plural tier. */
export function stepRowsKey(count: number, locale: Locale): string {
  return pluralKey("coach.step.rows", count, locale);
}

/** "N metrics" on the snapshot step, by plural tier. */
export function stepMetricsKey(count: number, locale: Locale): string {
  return pluralKey("coach.step.metrics", count, locale);
}

export const COACH_STEP_REASON_KEYS: Readonly<Record<CoachStepReason, string>> =
  {
    no_data: "coach.step.reason.noData",
    outside_window: "coach.step.reason.outsideWindow",
    module_disabled: "coach.step.reason.moduleDisabled",
    retrieval_failed: "coach.step.reason.retrievalFailed",
    invalid_arguments: "coach.step.reason.invalidArguments",
  };

const SCOPE_SOURCES: ReadonlySet<string> = new Set(
  coachScopeSourceSchema.options,
);

/**
 * A domain's display name. A measurement-backed scope source reuses the
 * metric names the sources rail already shows; the domains read as a whole
 * have their own.
 */
export function coachDomainLabelKey(domain: CoachStepDomain): string {
  return SCOPE_SOURCES.has(domain)
    ? `insights.coach.metric.${domain}`
    : `coach.step.domain.${domain}`;
}

/** A window in running text ("last 30 days"). */
export function coachWindowLabelKey(window: CoachScopeWindow): string {
  return `coach.step.window.${window}`;
}

export function coachPeriodLabelKey(period: CoachResultPeriod): string {
  return `coach.step.period.${period}`;
}

export function coachGranularityLabelKey(
  granularity: CoachResultGranularity,
): string {
  return `coach.step.granularity.${granularity}`;
}

// ── Results ───────────────────────────────────────────────────────────────

/** Table titles; `{metric}` where the title names one. */
export const COACH_RESULT_TITLE_KEYS = {
  byDay: "coach.result.title.byDay",
  byWeek: "coach.result.title.byWeek",
  byMonth: "coach.result.title.byMonth",
  previousPeriod: "coach.result.title.previousPeriod",
  yearAgo: "coach.result.title.yearAgo",
  workoutsBySport: "coach.result.title.workoutsBySport",
  labsLatest: "coach.result.title.labsLatest",
  sleepByNight: "coach.result.title.sleepByNight",
  complianceByDay: "coach.result.title.complianceByDay",
  distribution: "coach.result.title.distribution",
} as const;

/** Column headings. */
export const COACH_RESULT_COLUMN_KEYS = {
  day: "coach.result.column.day",
  week: "coach.result.column.week",
  month: "coach.result.column.month",
  night: "coach.result.column.night",
  sport: "coach.result.column.sport",
  sessions: "coach.result.column.sessions",
  analyte: "coach.result.column.analyte",
  value: "coach.result.column.value",
  unit: "coach.result.column.unit",
  date: "coach.result.column.date",
  referenceRange: "coach.result.column.referenceRange",
  systolic: "coach.result.column.systolic",
  diastolic: "coach.result.column.diastolic",
  mean: "coach.result.column.mean",
  total: "coach.result.column.total",
  min: "coach.result.column.min",
  max: "coach.result.column.max",
  readings: "coach.result.column.readings",
  rate: "coach.result.column.rate",
  duration: "coach.result.column.duration",
  range: "coach.result.column.range",
  count: "coach.result.column.count",
} as const;

/** The table's own chrome: paging, copy, the chart/table toggle, notices. */
export const COACH_RESULT_UI_KEYS = {
  other: "coach.result.other",
  noReading: "coach.result.noReading",
  showAll: "coach.result.showAll",
  showFewer: "coach.result.showFewer",
  copyMenu: "coach.result.copyMenu",
  copyForSpreadsheet: "coach.result.copyForSpreadsheet",
  copyAsText: "coach.result.copyAsText",
  copied: "coach.result.copied",
  copyFailed: "coach.result.copyFailed",
  viewLabel: "coach.result.viewLabel",
  viewChart: "coach.result.viewChart",
  viewTable: "coach.result.viewTable",
  chartSummary: "coach.result.chartSummary",
  dataUsed: "coach.result.dataUsed",
  truncated: "coach.result.truncated",
  loading: "coach.result.loading",
  loadFailed: "coach.result.loadFailed",
  reusedFrom: "coach.result.reusedFrom",
  reusedFromUndated: "coach.result.reusedFromUndated",
  histogramBin: "coach.result.histogramBin",
} as const;

/** Why a stored table is not shown. */
export const COACH_RESULT_WITHHELD_KEYS = {
  module_disabled: "coach.result.withheld.moduleDisabled",
  unavailable: "coach.result.withheld.unavailable",
} as const;

// ── Method ────────────────────────────────────────────────────────────────

export const COACH_METHOD_KEYS = {
  label: "coach.method.label",
  entry: "coach.method.entry",
  entryNoWindow: "coach.method.entryNoWindow",
  reused: "coach.method.reused",
} as const;

/** "N readings" in the method line, by plural tier. */
export function methodReadingsKey(count: number, locale: Locale): string {
  return pluralKey("coach.method.readings", count, locale);
}

export const COACH_METHOD_AGGREGATION_KEYS: Readonly<
  Record<NonNullable<CoachMethodEntry["aggregation"]>, string>
> = {
  mean: "coach.method.aggregation.mean",
  median: "coach.method.aggregation.median",
  latest: "coach.method.aggregation.latest",
  sum: "coach.method.aggregation.sum",
  count: "coach.method.aggregation.count",
  rate: "coach.method.aggregation.rate",
};

/** "weekly averages" and "weekly totals", by granularity. */
export function methodAveragesKey(granularity: CoachResultGranularity): string {
  return `coach.method.averages.${granularity}`;
}

export function methodTotalsKey(granularity: CoachResultGranularity): string {
  return `coach.method.totals.${granularity}`;
}

export const COACH_METHOD_ABSENT_KEYS: Readonly<
  Record<NonNullable<CoachMethodEntry["absent"]>, string>
> = {
  no_data: "coach.method.absent.noData",
  outside_window: "coach.method.absent.outsideWindow",
  module_disabled: "coach.method.absent.moduleDisabled",
};

// ── Follow-ups ────────────────────────────────────────────────────────────

/** One label per chip kind; `{metric}` on a related-metric chip. */
export const COACH_FOLLOW_UP_KEYS: Readonly<Record<CoachFollowUpKind, string>> =
  {
    widen_window: "coach.followUp.widenWindow",
    previous_period: "coach.followUp.previousPeriod",
    year_ago: "coach.followUp.yearAgo",
    as_chart: "coach.followUp.asChart",
    as_table: "coach.followUp.asTable",
    related_metric: "coach.followUp.relatedMetric",
    continue: "coach.followUp.continue",
    change_assumption: "coach.followUp.changeAssumption",
  };

export const COACH_FOLLOW_UP_UI_KEYS = {
  groupLabel: "coach.followUp.groupLabel",
  settingLabel: "coach.followUp.settingLabel",
  settingHint: "coach.followUp.settingHint",
} as const;

// ── Clarification ─────────────────────────────────────────────────────────

export const COACH_CLARIFY_UI_KEYS = {
  cardLabel: "coach.clarify.cardLabel",
  choicesLabel: "coach.clarify.choicesLabel",
  freeTextHint: "coach.clarify.freeTextHint",
  contextHint: "coach.clarify.contextHint",
  comparisonBaseline90d: "coach.clarify.comparison.baseline90d",
  anchorIllness: "coach.clarify.anchor.illness",
} as const;

/** A window choice on a clarification card ("Last 30 days"). */
export function clarifyWindowLabelKey(window: CoachScopeWindow): string {
  return `coach.clarify.window.${window}`;
}

// ── Replies, assumptions (v1.41) ──────────────────────────────────────

/** The group of reply pills under the latest answer. */
export const COACH_SUGGESTED_REPLIES_KEYS = {
  groupLabel: "insights.coach.suggestedReplies.groupLabel",
} as const;

/** "Assumed: last 30 days. Change". */
export const COACH_ASSUMPTION_KEYS = {
  line: "insights.coach.assumption.line",
  change: "insights.coach.assumption.change",
} as const;

/** The legend of a chart comparing two periods ("{a} vs {b}"). */
export const COACH_CHART_COMPARE_KEYS = {
  periods: "insights.coach.chart.compare.periods",
} as const;

// ── Reuse ─────────────────────────────────────────────────────────────────

/** The prose of a turn answered from a stored table without a model call. */
export const COACH_REUSE_CAPTION_KEY = "coach.reuse.caption";
