/**
 * The chart a result table gets, chosen on the server from the table's shape
 * and the metric: a line for level metrics over time, a bar for totals and
 * category counts, a histogram for a distribution, or none (table only)
 * when the table is too short, too long or has no numeric column.
 *
 * Pure and deterministic: the same table always gets the same chart, and the
 * model never picks one. The model can only ask, through `show_result`'s
 * `view`, for an earlier day table as a distribution (`buildDistributionTable`)
 * or for the table without a chart.
 *
 * Imports types only, so the client can use the category view below
 * (`chartCategoryRows`) without pulling anything server-side in.
 */
import type {
  CoachChartSpec,
  CoachResultCell,
  CoachResultColumn,
  CoachResultTable,
  CoachScopeSource,
  CoachStepDomain,
} from "@/lib/ai/coach/types";

/** Fewer rows than this: table only. */
export const CHART_MIN_ROWS = 2;
/** More rows than this: table only (the table's own row cap). */
export const CHART_MAX_ROWS = 400;
/** Category bars turn horizontal above this many categories. */
export const CATEGORY_VERTICAL_MAX = 6;
/** Category bars show this many categories; the rest fold into "other". */
export const CATEGORY_TOP_N = 8;
/** A histogram needs at least this many values. */
export const HISTOGRAM_MIN_VALUES = 10;
/** Bin-count bounds for a histogram without a fixed width. */
export const HISTOGRAM_MIN_BINS = 5;
export const HISTOGRAM_MAX_BINS = 20;

/**
 * How a metric's periods add up: a level (a reading that stands for the
 * period: blood pressure, weight, sleep) is drawn as a line; a total (a sum
 * over the period: steps, energy) as bars. A record over every source, so a
 * new source does not compile until it is placed.
 */
export const METRIC_AGGREGATION_KIND: Readonly<
  Record<CoachScopeSource, "level" | "total">
> = {
  bp: "level",
  weight: "level",
  pulse: "level",
  mood: "level",
  compliance: "level",
  hrv: "level",
  sleep: "level",
  resting_hr: "level",
  steps: "total",
  active_energy: "total",
  flights: "total",
  distance: "total",
  vo2_max: "level",
  body_temp: "level",
  walking_hr: "level",
  respiratory_rate: "level",
  spo2: "level",
  pulse_wave_velocity: "level",
  vascular_age: "level",
  body_fat: "level",
  fat_mass: "level",
  fat_free_mass: "level",
  muscle_mass: "level",
  lean_body_mass: "level",
  bone_mass: "level",
  total_body_water: "level",
  bmi: "level",
  visceral_fat: "level",
  glucose: "level",
  walking_steadiness: "level",
  walking_asymmetry: "level",
  walking_double_support: "level",
  walking_step_length: "level",
  walking_speed: "level",
  audio_env: "level",
  audio_headphone: "level",
  audio_event: "total",
  daylight: "total",
  skin_temp: "level",
  workouts: "total",
};

/**
 * Whether a metric's periods are totals or levels. The table tool folds a
 * week or month with it (a sum or a mean), the method line names it, and the
 * chart draws it: one answer for all three.
 */
export function aggregationKind(domain: CoachStepDomain): "level" | "total" {
  return (
    (METRIC_AGGREGATION_KIND as Partial<Record<string, "level" | "total">>)[
      domain
    ] ?? "level"
  );
}

/**
 * Fixed bin widths for the metrics people ask "how often" about, in the
 * unit the table carries. Glucose only when the table is in mg/dL; any
 * other metric or unit falls back to the Freedman–Diaconis rule.
 */
const NICE_BIN_WIDTH: Readonly<
  Partial<Record<CoachScopeSource, { width: number; unit?: string }>>
> = {
  bp: { width: 5, unit: "mmHg" },
  pulse: { width: 5, unit: "bpm" },
  resting_hr: { width: 5, unit: "bpm" },
  walking_hr: { width: 5, unit: "bpm" },
  weight: { width: 0.5, unit: "kg" },
  sleep: { width: 30, unit: "min" },
  glucose: { width: 10, unit: "mg/dL" },
  steps: { width: 1000 },
};

type ChartInput = Omit<CoachResultTable, "chart" | "chartKind"> & {
  chart?: CoachChartSpec | null;
};

function isNumericCell(cell: CoachResultCell | undefined): cell is number {
  return typeof cell === "number" && Number.isFinite(cell);
}

function columnIndex(table: ChartInput, key: string): number {
  return table.columns.findIndex((column) => column.key === key);
}

/**
 * Metrics whose value columns are alternative estimators of one quantity
 * (HRV as SDNN and as RMSSD), not two sides of one reading: the chart draws
 * the first, which the table tool orders as the one with more readings.
 */
const SINGLE_SERIES_DOMAINS: ReadonlySet<CoachStepDomain> =
  new Set<CoachStepDomain>(["hrv"]);

/**
 * The series a time series is drawn with: its value columns, and only the
 * first one plus one partner in the same unit — two axes with different
 * units on one chart read as a comparison they are not.
 */
function timeSeriesColumns(table: ChartInput): CoachResultColumn[] {
  const values = table.columns.filter((column) => column.kind === "number");
  const candidates =
    values.length > 0
      ? values
      : table.columns.filter((column) => column.kind === "count");
  const [first, ...rest] = candidates;
  if (!first) return [];
  if (SINGLE_SERIES_DOMAINS.has(table.source.domain)) return [first];
  const partner = rest.find((column) => column.unit === first.unit);
  return partner ? [first, partner] : [first];
}

function timeSeriesSpec(table: ChartInput): CoachChartSpec | null {
  const x = table.columns.find((column) => column.kind === "period");
  if (!x) return null;
  const series = timeSeriesColumns(table);
  if (series.length === 0) return null;
  const indexes = series.map((column) => columnIndex(table, column.key));
  const points = table.rows.filter((row) =>
    indexes.some((index) => isNumericCell(row[index])),
  ).length;
  if (points === 0) return null;
  const keys = series.map((column) => column.key);
  // A line needs two points; one reading is a single bar, not a dot.
  if (aggregationKind(table.source.domain) === "total" || points < 2) {
    return { kind: "bar", x: x.key, series: keys, orientation: "vertical" };
  }
  return { kind: "line", x: x.key, series: keys };
}

function categorySpec(table: ChartInput): CoachChartSpec | null {
  const x = table.columns.find((column) => column.kind === "category");
  const counts = table.columns.find((column) => column.kind === "count");
  if (!x || !counts) return null;
  const index = columnIndex(table, counts.key);
  let any = false;
  for (const row of table.rows) {
    const cell = row[index];
    if (cell === null || cell === undefined) continue;
    if (!isNumericCell(cell) || cell < 0 || !Number.isInteger(cell)) {
      return null;
    }
    any = true;
  }
  if (!any) return null;
  return {
    kind: "bar",
    x: x.key,
    series: [counts.key],
    orientation:
      table.rows.length > CATEGORY_VERTICAL_MAX ? "horizontal" : "vertical",
  };
}

/**
 * The chart for a table, or null for table only.
 *
 * 1. Fewer than 2 or more than 400 rows, or no numeric column: none.
 * 2. A time series: a line for a level metric, vertical bars for a total;
 *    at most two series, and only in one unit.
 * 3. Category counts: bars, horizontal above six categories (the top eight
 *    and "other" are drawn; `chartCategoryRows`). Counts must be
 *    non-negative whole numbers.
 * 4. A distribution keeps the histogram it was built with
 *    (`buildDistributionTable`); its bins cannot be read back from the rows.
 * 5. A comparison (v1.41, `compare_series`) keeps the `compare` chart it was
 *    built with, while its columns still hold what the chart names.
 * 6. Anything else (a list of lab results): none.
 */
export function deriveChartSpec(table: ChartInput): CoachChartSpec | null {
  if (
    table.rows.length < CHART_MIN_ROWS ||
    table.rows.length > CHART_MAX_ROWS
  ) {
    return null;
  }
  if (table.chart?.kind === "compare") return compareSpec(table, table.chart);
  switch (table.shape) {
    case "timeSeries":
      return timeSeriesSpec(table);
    case "categoryCounts":
      return categorySpec(table);
    case "distribution":
      return table.chart?.kind === "histogram" ? table.chart : null;
    default:
      return null;
  }
}

/**
 * A comparison's chart, kept when the columns it names are there: the shared
 * period column and two numeric ones. Two axes only for two metrics.
 */
function compareSpec(
  table: ChartInput,
  spec: Extract<CoachChartSpec, { kind: "compare" }>,
): CoachChartSpec | null {
  const x = table.columns.find((column) => column.key === spec.x);
  const a = table.columns.find((column) => column.key === spec.a);
  const b = table.columns.find((column) => column.key === spec.b);
  if (x?.kind !== "period" || a?.kind !== "number" || b?.kind !== "number") {
    return null;
  }
  const ia = columnIndex(table, spec.a);
  const ib = columnIndex(table, spec.b);
  const paired = table.rows.filter(
    (row) => isNumericCell(row[ia]) && isNumericCell(row[ib]),
  ).length;
  if (paired < CHART_MIN_ROWS) return null;
  return {
    ...spec,
    axes: spec.mode === "metrics" && spec.axes === 2 ? 2 : 1,
  };
}

// ── Histogram ─────────────────────────────────────────────────────────────

export interface HistogramBin {
  from: number;
  to: number;
  count: number;
}

/** Strips float noise from a bin edge (0.1 + 0.2 and the like). */
function clean(value: number): number {
  return Number(value.toFixed(10));
}

/** Linear-interpolated quantile of a sorted list. */
function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

/** The "nice" widths: 1, 2, 2.5 and 5 times a power of ten. */
const NICE_STEPS = [1, 2, 2.5, 5];

function niceAtLeast(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of NICE_STEPS) {
    if (step * power >= value - 1e-12) return clean(step * power);
  }
  return clean(10 * power);
}

function niceBelow(width: number): number {
  const power = 10 ** Math.floor(Math.log10(width));
  const mantissa = clean(width / power);
  const index = NICE_STEPS.findIndex((step) => step >= mantissa);
  if (index > 0) return clean(NICE_STEPS[index - 1] * power);
  return clean(5 * (power / 10));
}

function niceAbove(width: number): number {
  return niceAtLeast(clean(width * 1.000001));
}

function binCount(min: number, max: number, width: number): number {
  const start = Math.floor(clean(min / width)) * width;
  return Math.floor(clean((max - start) / width)) + 1;
}

/** Freedman–Diaconis on a nice width, held to 5..20 bins. */
function freedmanDiaconisWidth(sorted: number[]): number {
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const range = max - min;
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const raw =
    iqr > 0 ? (2 * iqr) / Math.cbrt(sorted.length) : range / HISTOGRAM_MIN_BINS;
  let width = niceAtLeast(raw);
  for (let guard = 0; guard < 64; guard += 1) {
    const bins = binCount(min, max, width);
    if (bins > HISTOGRAM_MAX_BINS) width = niceAbove(width);
    else if (bins < HISTOGRAM_MIN_BINS && width > 1e-9)
      width = niceBelow(width);
    else break;
  }
  return width;
}

/**
 * Bins for a set of values: a fixed width for the metrics that have one
 * (doubled until at most 20 bins remain), Freedman–Diaconis otherwise.
 * Bins run from the one holding the lowest value to the one holding the
 * highest; empty bins in between stay, with a count of 0. Each bin holds
 * `from <= v < to`. Fewer than ten values: null, not a histogram of noise.
 */
export function buildHistogram(
  values: readonly number[],
  domain: CoachStepDomain,
  unit: string | undefined,
): HistogramBin[] | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < HISTOGRAM_MIN_VALUES) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  const fixed = (
    NICE_BIN_WIDTH as Partial<Record<string, { width: number; unit?: string }>>
  )[domain];
  let width: number;
  if (fixed && (fixed.unit === undefined || fixed.unit === unit)) {
    width = fixed.width;
    while (binCount(min, max, width) > HISTOGRAM_MAX_BINS) width *= 2;
  } else if (max === min) {
    width = niceAtLeast(Math.max(Math.abs(min), 1) / 10);
  } else {
    width = freedmanDiaconisWidth(sorted);
  }

  const start = clean(Math.floor(clean(min / width)) * width);
  const count = binCount(min, max, width);
  const bins: HistogramBin[] = Array.from({ length: count }, (_, i) => ({
    from: clean(start + i * width),
    to: clean(start + (i + 1) * width),
    count: 0,
  }));
  for (const value of sorted) {
    const index = Math.min(
      count - 1,
      Math.max(0, Math.floor(clean((value - start) / width))),
    );
    bins[index].count += 1;
  }
  return bins;
}

/** Decimals a bin edge needs to be told apart from its neighbour. */
export function binDecimals(bins: readonly HistogramBin[]): number {
  let decimals = 0;
  for (const bin of bins) {
    for (const edge of [bin.from, bin.to]) {
      const text = String(edge);
      const dot = text.indexOf(".");
      if (dot >= 0) decimals = Math.max(decimals, text.length - dot - 1);
    }
  }
  return Math.min(decimals, 3);
}

/** The words a distribution table is labelled with, in the reply's locale. */
export interface DistributionLabels {
  /** BCP 47 tag the bin edges are formatted in. */
  localeTag: string;
  title: string;
  /** Heading of the range column. */
  range: string;
  /** Heading of the count column. */
  count: string;
  /** One bin's label, e.g. `120–125 mmHg`. */
  bin: (from: string, to: string, unit: string) => string;
}

/**
 * A day table as a distribution: how many days fell into each range of its
 * first value column. Only a day table (one value per day) qualifies, and
 * only with at least ten values; otherwise null and the table keeps its
 * own chart.
 */
export function buildDistributionTable(
  table: CoachResultTable,
  labels: DistributionLabels,
): CoachResultTable | null {
  if (table.shape !== "timeSeries" || table.source.granularity !== "day") {
    return null;
  }
  const column = table.columns.find((candidate) => candidate.kind === "number");
  if (!column) return null;
  const index = columnIndex(table, column.key);
  const values = table.rows
    .map((row) => row[index])
    .filter((cell): cell is number => isNumericCell(cell));
  const bins = buildHistogram(values, table.source.domain, column.unit);
  if (!bins) return null;

  const decimals = binDecimals(bins);
  const format = new Intl.NumberFormat(labels.localeTag, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true,
  });
  const unit = column.unit ?? "";
  const valueColumns = table.columns.filter(
    (candidate) => candidate.kind === "number",
  );
  const rows: CoachResultCell[][] = bins.map((bin) => [
    labels.bin(format.format(bin.from), format.format(bin.to), unit).trim(),
    bin.count,
  ]);
  const chart: CoachChartSpec = {
    kind: "histogram",
    column: column.key,
    ...(column.unit ? { unit: column.unit } : {}),
    bins,
  };
  const withChart = rows.length >= CHART_MIN_ROWS ? chart : null;
  return {
    ref: table.ref,
    source: table.source,
    shape: "distribution",
    titleKey: "coach.result.title.distribution",
    title: labels.title,
    rowCount: rows.length,
    chartKind: withChart ? "histogram" : null,
    displayed: table.displayed,
    ...(table.reusedFrom ? { reusedFrom: table.reusedFrom } : {}),
    columns: [
      {
        key: "range",
        kind: "category",
        labelKey: "coach.result.column.range",
        label:
          valueColumns.length > 1
            ? `${labels.range} (${column.label})`
            : labels.range,
      },
      {
        key: "count",
        kind: "count",
        labelKey: "coach.result.column.count",
        label: labels.count,
      },
    ],
    rows,
    truncated: false,
    chart: withChart,
  };
}

// ── The category view (client and server) ─────────────────────────────────

export interface ChartCategoryRow {
  label: string;
  value: number;
  /** True for the folded "other" bar. */
  other: boolean;
}

/**
 * The bars a category chart draws: the eight largest categories, largest
 * first, and the rest summed into one "other" bar. A category without a
 * count is left out of the bars (the table still lists it).
 */
export function chartCategoryRows(
  table: Pick<CoachResultTable, "columns" | "rows">,
  spec: Extract<CoachChartSpec, { kind: "bar" }>,
  otherLabel: string,
): ChartCategoryRow[] {
  const xIndex = table.columns.findIndex((column) => column.key === spec.x);
  const yIndex = table.columns.findIndex(
    (column) => column.key === spec.series[0],
  );
  if (xIndex < 0 || yIndex < 0) return [];
  const entries = table.rows
    .map((row, order) => ({
      label: String(row[xIndex] ?? ""),
      value: row[yIndex],
      order,
    }))
    .filter((entry): entry is { label: string; value: number; order: number } =>
      isNumericCell(entry.value),
    )
    .sort((a, b) => b.value - a.value || a.order - b.order);
  const top = entries.slice(0, CATEGORY_TOP_N).map((entry) => ({
    label: entry.label,
    value: entry.value,
    other: false,
  }));
  const rest = entries.slice(CATEGORY_TOP_N);
  if (rest.length === 0) return top;
  return [
    ...top,
    {
      label: otherLabel,
      value: rest.reduce((sum, entry) => sum + entry.value, 0),
      other: true,
    },
  ];
}
