/**
 * Live steps: one `CoachStep` per tool call, emitted as `step` frames while
 * the turn runs and persisted on `metricSource.steps`.
 *
 * A step carries a catalog label key, the server-rendered label, the domain,
 * the window and a server-counted number. Never free text, an analyte name
 * or a health value: every field is either a closed enum member checked
 * here, a catalog string rendered from those enums, or a non-negative
 * integer the server counted. Nothing the model wrote and nothing the
 * record holds as text can reach it, because nothing is copied through
 * without passing one of those checks.
 */
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { AiToolCall } from "@/lib/ai/types";
import {
  coachScopeSourceSchema,
  coachScopeWindowSchema,
  type CoachResultGranularity,
  type CoachResultPeriod,
  type CoachScopeWindow,
  type CoachStep,
  type CoachStepDomain,
  type CoachStepReason,
  type CoachStepStatus,
} from "@/lib/ai/coach/types";
import {
  COACH_STEP_LABEL_KEYS,
  coachDomainLabelKey,
  coachWindowLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import type { CoachToolResult } from "@/lib/ai/coach/tools/executor";
import {
  SHOW_RESULT_TOOL_NAME,
  isCoachToolName,
  type CoachToolName,
} from "@/lib/ai/coach/tools/definitions";
import { isTurnResultRef } from "@/lib/ai/coach/results/refs";
import { COMPARE_SERIES_TOOL_NAME } from "@/lib/ai/coach/tools/compare-series";

/**
 * At most this many steps per turn; later calls run but show no step.
 * v1.41 — four per round of the longest turn: 48 for twelve rounds, 64 since
 * v1.41.2 raised the cap to sixteen.
 */
export const MAX_TURN_STEPS = 64;

const SCOPE_SOURCES: ReadonlySet<string> = new Set(
  coachScopeSourceSchema.options,
);
const WINDOWS: ReadonlySet<string> = new Set(coachScopeWindowSchema.options);
/** Every domain a result table can name as its source. */
const RESULT_DOMAINS: ReadonlySet<string> = new Set<string>([
  ...coachScopeSourceSchema.options,
  "labs",
  "illness",
  "cycle",
  "correlations",
]);
const PERIODS: ReadonlySet<string> = new Set<CoachResultPeriod>([
  "current",
  "previous",
  "yearAgo",
]);
const GRANULARITIES: ReadonlySet<string> = new Set<CoachResultGranularity>([
  "day",
  "week",
  "month",
]);

/**
 * The domain each tool reads. `null` means the domain is the validated
 * `metric` argument. A record keyed on the tool name, so a new tool does not
 * compile until it says what it reads.
 */
const TOOL_DOMAIN: Readonly<Record<CoachToolName, CoachStepDomain | null>> = {
  get_metric_series: null,
  get_glucose_panel: "glucose",
  get_sleep: "sleep",
  get_medication_compliance: "compliance",
  get_labs: "labs",
  get_illness_recovery: "illness",
  get_workouts: "workouts",
  get_cycle: "cycle",
  get_correlations: "correlations",
  get_metric_table: null,
};

/**
 * The window a tool reads when the call names none. `"fallback"` is the
 * conversation's window (the executor's default); `null` is a read with no
 * window at all. Labs read a fixed trailing year whatever the conversation
 * says, so their step says that year rather than the conversation's window.
 */
const TOOL_WINDOW: Readonly<
  Record<CoachToolName, CoachScopeWindow | "fallback" | null>
> = {
  get_metric_series: "fallback",
  get_glucose_panel: "fallback",
  get_sleep: "fallback",
  get_medication_compliance: "fallback",
  get_labs: "lastYear",
  get_illness_recovery: "fallback",
  get_workouts: "fallback",
  get_cycle: null,
  get_correlations: null,
  get_metric_table: "fallback",
};

/**
 * A miss reason from the executor, mapped onto the step. Anything not listed
 * (a correlation reader's own "no pattern survived" code, a rows-exist-but-
 * no-block verdict) is an empty step with no stated reason: saying "no
 * readings" there would be false.
 */
const MISS: Readonly<
  Record<string, { status: CoachStepStatus; reason?: CoachStepReason }>
> = {
  no_data: { status: "empty", reason: "no_data" },
  analyte_not_found: { status: "empty", reason: "no_data" },
  outside_window: { status: "empty", reason: "outside_window" },
  // Beyond the lookback limit: to the person, "no readings in this window"
  // is the true sentence; the limit itself is named in the answer.
  outside_reach: { status: "empty", reason: "outside_window" },
  module_disabled: { status: "empty", reason: "module_disabled" },
  retrieval_failed: { status: "failed", reason: "retrieval_failed" },
  no_data_unconfirmed: { status: "failed", reason: "retrieval_failed" },
  invalid_arguments: { status: "failed", reason: "invalid_arguments" },
  unknown_tool: { status: "failed", reason: "invalid_arguments" },
  unsupported_metric: { status: "failed", reason: "invalid_arguments" },
  use_get_glucose_panel: { status: "failed", reason: "invalid_arguments" },
  use_get_medication_compliance: {
    status: "failed",
    reason: "invalid_arguments",
  },
  use_get_workouts: { status: "failed", reason: "invalid_arguments" },
  // `show_result`: a name the conversation does not hold, a stored table
  // that could not be read, a turn already holding eight tables.
  unknown_result: { status: "failed", reason: "invalid_arguments" },
  result_unavailable: { status: "failed", reason: "retrieval_failed" },
  result_limit: { status: "failed" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-negative integer, or undefined. Never a float: a count, not a value. */
function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function pick<T extends string>(
  allowed: ReadonlySet<string>,
  value: unknown,
): T | undefined {
  return typeof value === "string" && allowed.has(value)
    ? (value as T)
    : undefined;
}

/**
 * The readings a table summary counted: the total of its readings column,
 * or, for a table without one, the periods that hold a reading. Both are
 * figures `summariseTable` counted on the server.
 */
function tableSummaryCount(data: Record<string, unknown>): number | undefined {
  const stats = data.stats;
  const readings = isRecord(stats) ? stats.readings : undefined;
  return (
    (isRecord(readings) ? asCount(readings.total) : undefined) ??
    asCount(data.periodsWithReadings)
  );
}

/**
 * How many readings or rows a present result covered, when the result says
 * so in a field the server counted:
 * - a metric series: the aggregate's coverage count, else the readings the
 *   snapshot counted for it;
 * - a metric table: the readings its periods fold;
 * - workouts: the sessions in the window;
 * - labs: the biomarkers returned (one row each).
 * Anything else carries no count rather than a guess.
 */
function presentCount(tool: CoachToolName, data: unknown): number | undefined {
  if (!isRecord(data)) return undefined;
  switch (tool) {
    case "get_metric_table":
      return tableSummaryCount(data);
    case "get_metric_series": {
      const section = data.section;
      const coverage =
        isRecord(section) && isRecord(section.aggregate)
          ? section.aggregate.coverage
          : undefined;
      // The aggregate's count where the block has one; a series without an
      // aggregate (body composition, the synced series) carries the readings
      // the snapshot counted beside the section.
      return (
        (isRecord(coverage) ? asCount(coverage.count) : undefined) ??
        asCount(data.readings)
      );
    }
    case "get_workouts":
      return asCount(data.totalInWindow);
    case "get_labs":
      return Array.isArray(data.recent) ? data.recent.length : undefined;
    default:
      return undefined;
  }
}

function render(
  locale: Locale,
  domain: CoachStepDomain,
  window: CoachScopeWindow | undefined,
): { labelKey: string; label: string } {
  const { t } = getServerTranslator(locale);
  const labelKey = window
    ? COACH_STEP_LABEL_KEYS.readWindow
    : COACH_STEP_LABEL_KEYS.read;
  return {
    labelKey,
    label: t(labelKey, {
      domain: t(coachDomainLabelKey(domain)),
      ...(window ? { window: t(coachWindowLabelKey(window)) } : {}),
    }),
  };
}

/**
 * The step for one tool call: `running` when `result` is absent (the call
 * just started), its final status once the result is in. `index` counts
 * calls across the turn from 0; `parsedArgs` are the schema-validated
 * arguments, absent when they did not validate. `fallbackWindow` is the
 * conversation's window, the one a call without a window reads.
 *
 * Null for a call past the cap, for a tool name outside the catalogue, and
 * for a metric call whose metric did not validate: there is nothing true to
 * label those with.
 */
export function toStep(args: {
  call: AiToolCall;
  index: number;
  parsedArgs: Record<string, unknown> | undefined;
  result?: CoachToolResult;
  locale: Locale;
  fallbackWindow?: CoachScopeWindow;
}): CoachStep | null {
  const { call, index, parsedArgs, result, locale } = args;
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_TURN_STEPS) {
    return null;
  }
  if (call.name === SHOW_RESULT_TOOL_NAME) {
    return reuseStep({ index, result, locale });
  }
  if (call.name === COMPARE_SERIES_TOOL_NAME) {
    return compareStep({ ...args, index });
  }
  if (!isCoachToolName(call.name)) return null;
  const tool = call.name;

  const domain =
    TOOL_DOMAIN[tool] ??
    pick<CoachStepDomain>(SCOPE_SOURCES, parsedArgs?.metric);
  // A metric series call whose arguments did not validate names no domain
  // the executor would read; the executor refuses it and the model is told.
  // There is nothing true to show, so it gets no step.
  if (!domain) return null;

  // A metric table says what it read (the window, and the period and
  // granularity after the executor's defaults); before it settles, the
  // validated arguments say what it is about to read.
  const source = tool === "get_metric_table" ? tableSource(result) : undefined;
  const windowRule = TOOL_WINDOW[tool];
  const window =
    windowRule === null
      ? undefined
      : windowRule === "fallback"
        ? (source?.window ??
          pick<CoachScopeWindow>(WINDOWS, parsedArgs?.window) ??
          pick<CoachScopeWindow>(WINDOWS, result?.searchedWindow) ??
          pick<CoachScopeWindow>(WINDOWS, args.fallbackWindow))
        : windowRule;
  const period =
    source?.period ?? pick<CoachResultPeriod>(PERIODS, parsedArgs?.period);
  const granularity =
    source?.granularity ??
    pick<CoachResultGranularity>(GRANULARITIES, parsedArgs?.granularity);

  const settled = settle(tool, result);
  const resultRef = producedRef(result);
  return {
    id: `s${index + 1}`,
    tool,
    ...render(locale, domain, window),
    domain,
    ...(window ? { window } : {}),
    ...(period ? { period } : {}),
    ...(granularity ? { granularity } : {}),
    status: settled.status,
    ...(settled.count !== undefined ? { count: settled.count } : {}),
    ...(settled.reason ? { reason: settled.reason } : {}),
    ...(resultRef ? { resultRef } : {}),
  };
}

/** The table a settled call produced for this turn, by its `r<n>` name. */
function producedRef(result: CoachToolResult | undefined): string | undefined {
  const ref = result?.present ? result.table?.ref : undefined;
  return ref !== undefined && ref === result?.resultRef && isTurnResultRef(ref)
    ? ref
    : undefined;
}

/**
 * What a present table result read, each field checked against its enum:
 * the table's own source, else the source its model summary repeats.
 */
function tableSource(result: CoachToolResult | undefined):
  | {
      domain?: CoachStepDomain;
      window?: CoachScopeWindow;
      period?: CoachResultPeriod;
      granularity?: CoachResultGranularity;
    }
  | undefined {
  if (!result?.present) return undefined;
  const raw: unknown =
    result.table?.source ??
    (isRecord(result.data) ? result.data.source : undefined);
  if (!isRecord(raw)) return undefined;
  return {
    domain: pick<CoachStepDomain>(RESULT_DOMAINS, raw.domain),
    window: pick<CoachScopeWindow>(WINDOWS, raw.window),
    period: pick<CoachResultPeriod>(PERIODS, raw.period),
    granularity: pick<CoachResultGranularity>(GRANULARITIES, raw.granularity),
  };
}

/**
 * A `show_result` call: an earlier table of the conversation shown again,
 * with no new read. Before it settles the step names no domain (the name
 * alone says nothing true about one); once the stored table is found, the
 * step takes the domain, window, period and granularity of the read that
 * built it, the readings that table counted, and the name the copy carries
 * in this turn.
 */
function reuseStep(args: {
  index: number;
  result: CoachToolResult | undefined;
  locale: Locale;
}): CoachStep {
  const { index, result, locale } = args;
  const { t } = getServerTranslator(locale);
  const labelKey = COACH_STEP_LABEL_KEYS.showResult;
  const base = {
    id: `s${index + 1}`,
    tool: SHOW_RESULT_TOOL_NAME,
    labelKey,
    label: t(labelKey),
  } as const;
  if (!result) return { ...base, status: "running" };
  const source = tableSource(result);
  const resultRef = producedRef(result);
  if (!source?.domain || !resultRef) {
    // Nothing was shown. A reuse has no "no readings" outcome: the table
    // either came back or it did not.
    const miss = result.present ? undefined : missFor(result.reason);
    return {
      ...base,
      status: "failed",
      ...(miss?.reason ? { reason: miss.reason } : {}),
    };
  }
  const count = isRecord(result.data)
    ? tableSummaryCount(result.data)
    : undefined;
  return {
    ...base,
    domain: source.domain,
    ...(source.window ? { window: source.window } : {}),
    ...(source.period ? { period: source.period } : {}),
    ...(source.granularity ? { granularity: source.granularity } : {}),
    status: "done",
    ...(count !== undefined ? { count } : {}),
    resultRef,
  };
}

function missFor(reason: unknown): {
  status: CoachStepStatus;
  reason?: CoachStepReason;
} {
  return (
    (typeof reason === "string" &&
      Object.hasOwn(MISS, reason) &&
      MISS[reason]) || {
      status: "empty",
    }
  );
}

function settle(
  tool: CoachToolName,
  result: CoachToolResult | undefined,
): { status: CoachStepStatus; count?: number; reason?: CoachStepReason } {
  if (!result) return { status: "running" };
  if (result.present) {
    return { status: "done", count: presentCount(tool, result.data) };
  }
  const miss = missFor(result.reason);
  // An out-of-window miss knows how much the record holds elsewhere; the
  // count rides the step for the method line, the row shows the reason.
  const count =
    miss.status === "empty" && isRecord(result.available)
      ? asCount(result.available.count)
      : undefined;
  return {
    status: miss.status,
    ...(count !== undefined ? { count } : {}),
    ...(miss.reason ? { reason: miss.reason } : {}),
  };
}

/**
 * v1.41 — a `compare_series` call: two series of the metric table, shown as
 * the metric table's step for the first metric. Its count is the readings
 * the first series folded; the second series rides the same table.
 */
function compareStep(args: {
  index: number;
  parsedArgs: Record<string, unknown> | undefined;
  result?: CoachToolResult;
  locale: Locale;
  fallbackWindow?: CoachScopeWindow;
}): CoachStep | null {
  const { index, parsedArgs, result, locale } = args;
  const domain = pick<CoachStepDomain>(SCOPE_SOURCES, parsedArgs?.metric);
  if (!domain) return null;
  const window =
    pick<CoachScopeWindow>(WINDOWS, parsedArgs?.window) ??
    pick<CoachScopeWindow>(WINDOWS, args.fallbackWindow);
  const granularity = pick<CoachResultGranularity>(
    GRANULARITIES,
    parsedArgs?.granularity,
  );
  const base = {
    id: `s${index + 1}`,
    tool: "get_metric_table" as const,
    ...render(locale, domain, window),
    domain,
    ...(window ? { window } : {}),
    ...(granularity ? { granularity } : {}),
  };
  if (!result) return { ...base, status: "running" };
  if (!result.present) {
    const miss = missFor(result.reason);
    return {
      ...base,
      status: miss.status,
      ...(miss.reason ? { reason: miss.reason } : {}),
    };
  }
  const sideA = isRecord(result.data) ? result.data.a : undefined;
  const count = isRecord(sideA) ? tableSummaryCount(sideA) : undefined;
  const resultRef = producedRef(result);
  return {
    ...base,
    status: "done",
    ...(count !== undefined ? { count } : {}),
    ...(resultRef ? { resultRef } : {}),
  };
}

/**
 * The single step a no-tools turn shows: the full snapshot, with the number
 * of metrics it covered. The snapshot is already built when this runs, so
 * the step is settled from the start.
 */
export function snapshotStep(args: {
  metricCount: number;
  locale: Locale;
}): CoachStep | null {
  const { t } = getServerTranslator(args.locale);
  const count = asCount(args.metricCount) ?? 0;
  return {
    id: "s1",
    tool: "snapshot",
    labelKey: COACH_STEP_LABEL_KEYS.snapshot,
    label: t(COACH_STEP_LABEL_KEYS.snapshot),
    domain: "snapshot",
    status: count > 0 ? "done" : "empty",
    count,
    ...(count === 0 ? { reason: "no_data" as const } : {}),
  };
}
