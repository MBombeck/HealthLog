/**
 * Tables projected from the results of the older tools, which read through
 * the snapshot builder: per-sport counts for workouts, the latest reading
 * per analyte for labs, adherence per week for medication compliance.
 *
 * Pure: each takes the result's `data` exactly as the model was given it,
 * so a table never shows a figure the tool did not return.
 *
 * The analyte and sport names in these tables are the person's own record,
 * shown only to them. They never reach a step label, the method line or any
 * plaintext column.
 */
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { shiftDateKey, userDayKey, weekdayOfDateKey } from "@/lib/tz/format";
import type {
  CoachResultCell,
  CoachResultColumn,
  CoachResultPeriod,
  CoachResultTable,
  CoachScopeWindow,
} from "@/lib/ai/coach/types";
import {
  COACH_CHART_COMPARE_KEYS,
  COACH_RESULT_COLUMN_KEYS,
  COACH_RESULT_TITLE_KEYS,
  coachDomainLabelKey,
  coachPeriodLabelKey,
} from "@/lib/ai/coach/dialog-keys";

export interface ProjectionContext {
  ref: string;
  locale: Locale;
  window: CoachScopeWindow;
  timeZone: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * `get_workouts` → sessions and minutes per sport over the window. The sport
 * name is the app's own label for it, falling back to the stored key.
 */
export function projectWorkouts(
  data: unknown,
  ctx: ProjectionContext,
): CoachResultTable | null {
  const perSport = isRecord(data) ? data.perSport : undefined;
  if (!Array.isArray(perSport) || perSport.length === 0) return null;
  const { t } = getServerTranslator(ctx.locale);
  const rows: CoachResultCell[][] = [];
  for (const entry of perSport) {
    if (!isRecord(entry) || typeof entry.sport !== "string") continue;
    const labelKey = `insights.workouts.sport.${entry.sport}`;
    const label = t(labelKey);
    rows.push([
      label === labelKey ? entry.sport : label,
      numberOrNull(entry.count),
      numberOrNull(entry.totalDurationMin),
    ]);
  }
  if (rows.length === 0) return null;
  const titleKey = COACH_RESULT_TITLE_KEYS.workoutsBySport;
  return {
    ref: ctx.ref,
    source: {
      tool: "get_workouts",
      domain: "workouts",
      window: ctx.window,
      period: "current",
    },
    shape: "categoryCounts",
    titleKey,
    title: t(titleKey),
    rowCount: rows.length,
    chartKind: null,
    displayed: false,
    columns: [
      {
        key: "sport",
        kind: "category",
        labelKey: COACH_RESULT_COLUMN_KEYS.sport,
        label: t(COACH_RESULT_COLUMN_KEYS.sport),
      },
      {
        key: "sessions",
        kind: "count",
        labelKey: COACH_RESULT_COLUMN_KEYS.sessions,
        label: t(COACH_RESULT_COLUMN_KEYS.sessions),
      },
      {
        key: "duration",
        kind: "number",
        labelKey: COACH_RESULT_COLUMN_KEYS.duration,
        label: t(COACH_RESULT_COLUMN_KEYS.duration),
        unit: "min",
        decimals: 0,
      },
    ],
    rows,
    truncated: false,
    chart: null,
  };
}

function rangeText(low: number | null, high: number | null): string | null {
  if (low !== null && high !== null) return `${low}–${high}`;
  if (low !== null) return `≥ ${low}`;
  if (high !== null) return `≤ ${high}`;
  return null;
}

/**
 * `get_labs` → the latest reading per analyte: name, value (or the
 * qualitative text), unit, the day it was taken, and the reference range.
 * No chart: the rows are different tests, not one series.
 */
export function projectLabs(
  data: unknown,
  ctx: ProjectionContext,
): CoachResultTable | null {
  const recent = isRecord(data) ? data.recent : undefined;
  if (!Array.isArray(recent) || recent.length === 0) return null;
  const { t } = getServerTranslator(ctx.locale);
  const rows: CoachResultCell[][] = [];
  for (const entry of recent) {
    if (!isRecord(entry) || typeof entry.analyte !== "string") continue;
    const takenAt =
      typeof entry.takenAt === "string" ? new Date(entry.takenAt) : null;
    rows.push([
      entry.analyte,
      numberOrNull(entry.value) ??
        (typeof entry.valueText === "string" ? entry.valueText : null),
      typeof entry.unit === "string" && entry.unit !== "" ? entry.unit : null,
      takenAt && !Number.isNaN(takenAt.getTime())
        ? userDayKey(takenAt, ctx.timeZone)
        : null,
      rangeText(
        numberOrNull(entry.referenceLow),
        numberOrNull(entry.referenceHigh),
      ),
    ]);
  }
  if (rows.length === 0) return null;
  const titleKey = COACH_RESULT_TITLE_KEYS.labsLatest;
  const column = (
    key: string,
    kind: "category" | "number" | "period",
    labelKey: string,
  ) => ({ key, kind, labelKey, label: t(labelKey) });
  return {
    ref: ctx.ref,
    source: {
      tool: "get_labs",
      domain: "labs",
      // The labs read is a fixed trailing twelve months, whatever the scope.
      window: "lastYear",
      period: "current",
    },
    shape: "single",
    titleKey,
    title: t(titleKey),
    rowCount: rows.length,
    chartKind: null,
    displayed: false,
    columns: [
      column("analyte", "category", COACH_RESULT_COLUMN_KEYS.analyte),
      { ...column("value", "number", COACH_RESULT_COLUMN_KEYS.value) },
      column("unit", "category", COACH_RESULT_COLUMN_KEYS.unit),
      column("date", "period", COACH_RESULT_COLUMN_KEYS.date),
      column(
        "referenceRange",
        "category",
        COACH_RESULT_COLUMN_KEYS.referenceRange,
      ),
    ],
    rows,
    truncated: false,
    chart: null,
  };
}

/** Monday (`YYYY-MM-DD`) of an ISO week key (`YYYY-Www`). */
function mondayOfIsoWeek(weekIso: string): string | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekIso);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  // Week 1 holds January 4th; its Monday is the ISO year's first Monday.
  const jan4 = `${String(year).padStart(4, "0")}-01-04`;
  return shiftDateKey(mondayOfDay(jan4), (week - 1) * 7);
}

/** Monday (`YYYY-MM-DD`) of the ISO week a day key falls in. */
function mondayOfDay(dayKey: string): string {
  return shiftDateKey(dayKey, -((weekdayOfDateKey(dayKey) + 6) % 7));
}

/**
 * `get_medication_compliance` → adherence per week over the window. The
 * snapshot keeps the last fortnight by day and older weeks folded; both
 * fold into whole weeks here from the same taken / due counts, so a week
 * that straddles the two is one row, not two.
 */
export function projectCompliance(
  data: unknown,
  ctx: ProjectionContext,
): CoachResultTable | null {
  const compliance = isRecord(data) ? data.compliance : undefined;
  const timeline = isRecord(compliance) ? compliance.timeline : undefined;
  if (!isRecord(timeline)) return null;
  const weeks = new Map<string, { taken: number; total: number }>();
  const add = (week: string | null, taken: unknown, total: unknown) => {
    const takenN = numberOrNull(taken);
    const totalN = numberOrNull(total);
    if (!week || takenN === null || totalN === null || totalN <= 0) return;
    const entry = weeks.get(week) ?? { taken: 0, total: 0 };
    entry.taken += takenN;
    entry.total += totalN;
    weeks.set(week, entry);
  };
  for (const row of Array.isArray(timeline.weekly) ? timeline.weekly : []) {
    if (!isRecord(row) || typeof row.weekISO !== "string") continue;
    add(mondayOfIsoWeek(row.weekISO), row.taken, row.total);
  }
  for (const row of Array.isArray(timeline.recent) ? timeline.recent : []) {
    if (!isRecord(row) || typeof row.date !== "string") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
    add(mondayOfDay(row.date), row.taken, row.total);
  }
  if (weeks.size === 0) return null;
  const { t } = getServerTranslator(ctx.locale);
  const rows: CoachResultCell[][] = [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, { taken, total }]) => [week, (taken / total) * 100, total]);
  const titleKey = COACH_RESULT_TITLE_KEYS.byWeek;
  return {
    ref: ctx.ref,
    source: {
      tool: "get_medication_compliance",
      domain: "compliance",
      window: ctx.window,
      period: "current",
      granularity: "week",
    },
    shape: "timeSeries",
    titleKey,
    title: t(titleKey, { metric: t(coachDomainLabelKey("compliance")) }),
    rowCount: rows.length,
    chartKind: null,
    displayed: false,
    columns: [
      {
        key: "week",
        kind: "period",
        labelKey: COACH_RESULT_COLUMN_KEYS.week,
        label: t(COACH_RESULT_COLUMN_KEYS.week),
      },
      {
        key: "rate",
        kind: "number",
        labelKey: COACH_RESULT_COLUMN_KEYS.rate,
        label: t(COACH_RESULT_COLUMN_KEYS.rate),
        unit: "%",
        decimals: 0,
      },
      {
        key: "doses",
        kind: "count",
        labelKey: COACH_RESULT_COLUMN_KEYS.count,
        label: t(COACH_RESULT_COLUMN_KEYS.count),
      },
    ],
    rows,
    truncated: false,
    chart: null,
  };
}

// ── Comparisons (v1.41) ─────────────────────────────────────────────────

/** The value columns of a comparison table. */
export const COMPARE_COLUMN_A = "a";
export const COMPARE_COLUMN_B = "b";

/** A comparison keeps at most this many rows, like every table. */
const RESULT_COMPARE_MAX_ROWS = 400;

/** The first value column of a metric table: what a comparison draws. */
function valueColumn(
  table: CoachResultTable,
): { column: CoachResultColumn; index: number } | null {
  let index = table.columns.findIndex((column) => column.kind === "number");
  if (index < 0) {
    index = table.columns.findIndex(
      (column) => column.kind === "count" && column.key !== "readings",
    );
  }
  return index < 0 ? null : { column: table.columns[index], index };
}

function periodIndex(table: CoachResultTable): number {
  return table.columns.findIndex((column) => column.kind === "period");
}

function numericOrNull(cell: CoachResultCell | undefined): number | null {
  return typeof cell === "number" && Number.isFinite(cell) ? cell : null;
}

/**
 * Two series of one comparison as one table, `period | a | b`, with the
 * `compare` chart:
 *
 * - `periods`: the same metric over the current window (`a`) and an earlier
 *   one (`b`, the period before or a year earlier), overlaid position by
 *   position. The rows carry the current window's period keys; the earlier
 *   value of each row is the one at the same place in its own window. One
 *   axis: it is one metric in one unit.
 * - `metrics`: two metrics over the same window, joined on their period
 *   keys. Two axes when their units differ, one when they match.
 *
 * Pure: both tables are ones this turn read, and every value is copied from
 * them unchanged. Null when either has no value column or the comparison
 * holds fewer than two rows with a value on both sides.
 */
export function projectCompare(args: {
  mode: "periods" | "metrics";
  a: CoachResultTable;
  b: CoachResultTable;
  /** The earlier window of a `periods` comparison. */
  basis?: Exclude<CoachResultPeriod, "current">;
  ref: string;
  locale: Locale;
}): CoachResultTable | null {
  const { mode, a, b, locale } = args;
  const { t } = getServerTranslator(locale);
  const valueA = valueColumn(a);
  const valueB = valueColumn(b);
  const xA = periodIndex(a);
  const xB = periodIndex(b);
  if (!valueA || !valueB || xA < 0 || xB < 0) return null;

  let rows: CoachResultCell[][];
  if (mode === "periods") {
    rows = a.rows.map((row, i) => [
      row[xA] ?? null,
      numericOrNull(row[valueA.index]),
      numericOrNull(b.rows[i]?.[valueB.index]),
    ]);
  } else {
    const byKey = new Map<string, [number | null, number | null]>();
    for (const row of a.rows) {
      const key = row[xA];
      if (typeof key !== "string") continue;
      byKey.set(key, [numericOrNull(row[valueA.index]), null]);
    }
    for (const row of b.rows) {
      const key = row[xB];
      if (typeof key !== "string") continue;
      const entry = byKey.get(key) ?? [null, null];
      entry[1] = numericOrNull(row[valueB.index]);
      byKey.set(key, entry);
    }
    rows = [...byKey.entries()]
      .sort(([k1], [k2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : 0))
      .map(([key, [va, vb]]) => [key, va, vb]);
  }
  const paired = rows.filter((row) => row[1] !== null && row[2] !== null);
  if (paired.length < 2) return null;

  const domainA = a.source.domain;
  const domainB = b.source.domain;
  const basis = args.basis ?? "previous";
  const labelA =
    mode === "periods"
      ? coachPeriodLabelKey("current")
      : coachDomainLabelKey(domainA);
  const labelB =
    mode === "periods"
      ? coachPeriodLabelKey(basis)
      : coachDomainLabelKey(domainB);
  const columns: CoachResultColumn[] = [
    { ...a.columns[xA] },
    {
      key: COMPARE_COLUMN_A,
      kind: "number",
      labelKey: labelA,
      label: t(labelA),
      ...(valueA.column.unit ? { unit: valueA.column.unit } : {}),
      ...(valueA.column.decimals !== undefined
        ? { decimals: valueA.column.decimals }
        : {}),
    },
    {
      key: COMPARE_COLUMN_B,
      kind: "number",
      labelKey: labelB,
      label: t(labelB),
      ...(valueB.column.unit ? { unit: valueB.column.unit } : {}),
      ...(valueB.column.decimals !== undefined
        ? { decimals: valueB.column.decimals }
        : {}),
    },
  ];
  const sameUnit = (valueA.column.unit ?? "") === (valueB.column.unit ?? "");
  const titleKey = COACH_CHART_COMPARE_KEYS.periods;
  const title =
    mode === "periods"
      ? t(titleKey, { a: a.title, b: t(coachPeriodLabelKey(basis)) })
      : t(titleKey, {
          a: t(coachDomainLabelKey(domainA)),
          b: t(coachDomainLabelKey(domainB)),
        });
  const trimmed = rows.slice(-RESULT_COMPARE_MAX_ROWS);
  return {
    ref: args.ref,
    source: {
      tool: "get_metric_table",
      domain: domainA,
      window: a.source.window,
      period: "current",
      ...(a.source.granularity ? { granularity: a.source.granularity } : {}),
    },
    shape: "timeSeries",
    titleKey,
    title,
    rowCount: rows.length,
    chartKind: "compare",
    displayed: false,
    columns,
    rows: trimmed,
    truncated: trimmed.length < rows.length,
    chart: {
      kind: "compare",
      mode,
      x: columns[0].key,
      a: COMPARE_COLUMN_A,
      b: COMPARE_COLUMN_B,
      axes: mode === "periods" || sameUnit ? 1 : 2,
    },
  };
}
