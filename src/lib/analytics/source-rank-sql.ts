/**
 * v1.11.1 — source-aware SQL collapse helpers.
 *
 * The rollup writer mints one row per (type, day, source); the live
 * measurement reads see one raw row per reading. For overlapping standard
 * vitals (e.g. WHOOP + Apple Watch resting heart rate) both the rollup
 * all-time aggregate and the live 90-day aggregates must resolve to the
 * source-priority ladder's canonical source per (type, day) before composing,
 * or a dual-source user double-counts / blends two devices.
 *
 * `collapseRollupRowsBySource` does this in application code for the row-by-row
 * readers. These helpers do the equivalent IN SQL so the slim slice + the
 * comprehensive aggregator + the live `/api/measurements` fallback keep their
 * single-round-trip `GROUP BY type` shape (no six-figure row transfer).
 *
 * Every spliced literal is a closed-enum value (`MeasurementType` /
 * `MeasurementSource`) asserted against `/^[A-Z0-9_]+$/`, the same whitelist
 * convention the rollup writer uses for its date-trunc + type-list splices.
 * The user id is always passed as a bound parameter, never spliced.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { assertInstantSql } from "@/lib/analytics/request-clock-sql";
import { metricKeyForType } from "@/lib/measurements/cumulative-day-sum";
import {
  getSourceLadder,
  parseSourcePriority,
} from "@/lib/validations/source-priority";

/**
 * Measurement types that carry a source-priority ladder — the overlapping
 * vitals plus the cumulative metrics. Single-source types are intentionally
 * absent: they only ever have one source per (type, day), so the collapse is
 * a no-op for them and they fall into the CASE's ELSE branch.
 */
export const RANKED_TYPES: readonly MeasurementType[] = [
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  // v1.42 (#1110) — the `hrvRmssd` ladder.
  "HRV_RMSSD",
  "RESPIRATORY_RATE",
  "OXYGEN_SATURATION",
  "BODY_TEMPERATURE",
  "SKIN_TEMPERATURE",
  "WEIGHT",
  "BODY_FAT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "VO2_MAX",
  "RECOVERY_SCORE",
  // v1.18.10 — STRESS_SCORE carries a source-priority ladder (`stress`)
  // so the SQL collapse ranks a future device-native producer above the
  // COMPUTED proxy deterministically. No-op until a second producer lands.
  "STRESS_SCORE",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "ACTIVE_ENERGY_BURNED",
  "WALKING_RUNNING_DISTANCE",
  "FLIGHTS_CLIMBED",
];

// Enum members can carry digits (e.g. VO2_MAX, BLOOD_PRESSURE_SYS) — allow
// 0-9 so the whitelist doesn't reject a legitimate closed-enum value.
const ENUM_RE = /^[A-Z0-9_]+$/;
function assertEnumLiteral(value: string): string {
  if (!ENUM_RE.test(value)) {
    throw new Error(`unsafe enum literal for SQL splice: ${value}`);
  }
  return value;
}

/**
 * Build a SQL CASE expression mapping `(typeCol, sourceCol)` to an integer
 * rank where 0 = the highest-priority source on that type's ladder. A source
 * absent from a type's ladder — and every row of a type without a ladder —
 * gets rank 90 so a deterministic tiebreak (`source` name, or `count DESC`
 * where available) decides. Resolves the user's `sourcePriorityJson` ladders;
 * `null` yields the default ladders.
 */
export function buildSourceRankCase(
  priorityJson: unknown,
  typeCol: string,
  sourceCol: string,
): string {
  const resolved = parseSourcePriority(priorityJson);
  const branches: string[] = [];
  for (const type of RANKED_TYPES) {
    const metricKey = metricKeyForType(type);
    if (!metricKey) continue;
    const ladder = getSourceLadder(resolved, metricKey);
    if (ladder.length === 0) continue;
    const whens = ladder
      .map((source, i) => `WHEN '${assertEnumLiteral(source)}' THEN ${i}`)
      .join(" ");
    branches.push(
      `WHEN ${typeCol} = '${assertEnumLiteral(type)}' THEN ` +
        `(CASE ${sourceCol} ${whens} ELSE 90 END)`,
    );
  }
  if (branches.length === 0) return "90";
  return `CASE ${branches.join(" ")} ELSE 90 END`;
}

const INTERVAL_RE = /^\d+ (day|days|month|months|year|years)$/;
function assertInterval(value: string): string {
  if (!INTERVAL_RE.test(value)) {
    throw new Error(`unsafe interval literal for SQL splice: ${value}`);
  }
  return value;
}

/**
 * A trailing window: the readings from the instant `from` on, or from
 * `interval` before it when one is given.
 */
export interface CanonicalWindow {
  from: string;
  interval?: string;
}

/**
 * Build the canonical-source SELECT body — the raw `measurements` rows
 * restricted to the ladder-winning source per (type, day) — WITHOUT the
 * outer `( … ) m` alias wrapper. One scan reads the window's rows; a window
 * function names each (type, day)'s canonical source on every row, and the
 * rows of any other source are dropped.
 *
 * Use this when the same canonical set must be referenced more than once in
 * one statement (e.g. a `window_stats` CTE plus the outer aggregate): bind it
 * once via `WITH cm AS (${canonicalMeasurementsCte(...)})` and select
 * `FROM cm m` everywhere, so the pick runs once rather than per reference.
 * For the single-reference case use `canonicalMeasurementsFrom`, which wraps
 * this body in the alias.
 *
 * The rows carry every `measurements` column plus `canonical_source`, the
 * picked source (equal to `source` on every row that survives). Readers
 * select the columns they need, so the extra one never reaches them.
 *
 * The user id is bound as `$1`. `rankUnqualified` must be a CASE built with
 * unqualified `"type"`/`"source"` columns. `window`, when given, scopes the
 * scan to the readings from `from` on, or from `interval` (e.g. `"90 days"`,
 * whitelisted) before it. `from` is an instant the caller took
 * (`boundInstantSql` or `instantLiteralSql`, see `request-clock-sql.ts`), the
 * request's `now` for a trailing window, so the cut runs on the caller's
 * clock and never on the database's. `onlyType`, when given, scopes the scan
 * to that one metric.
 *
 * The pick is the first source of the day in ladder order (rank, then source
 * name), the same order the `DISTINCT ON` pick it replaced used, over the
 * same rows, so every (type, day) keeps the same source;
 * `tests/integration/canonical-source-pick-parity.test.ts` holds the
 * `DISTINCT ON` statement as its reference.
 *
 * Why no join: the earlier shape grouped the window to `(type, day, source)`,
 * picked per day with `DISTINCT ON`, and joined the picks back to the rows.
 * Whether that join ran as a hash join or as a nested loop that rescanned the
 * pick for every row was the planner's call, made from table statistics. On
 * a table without them (a new install, or an import still under the
 * autoanalyze threshold) it estimated one row and chose the nested loop: on a
 * 6,000-row fixture the all-time read took seconds, on a ten-year account it
 * ran past the statement timeout. A window over one scan has no such choice
 * to get wrong; `canonical-source-pick-unanalysed.test.ts` holds that.
 */
export function canonicalMeasurementsCte(
  rankUnqualified: string,
  window?: CanonicalWindow,
  onlyType?: MeasurementType,
): string {
  const bound = !window
    ? null
    : window.interval === undefined
      ? assertInstantSql(window.from)
      : `${assertInstantSql(window.from)} - INTERVAL '${assertInterval(window.interval)}'`;
  const since = bound ? `AND mm."measured_at" >= ${bound}` : "";
  // A single-type reader (a series for one metric) scopes the scan to that
  // type, so the pick reads one metric's rows instead of every row the user
  // has in the window.
  const typeOnly = onlyType
    ? `AND mm."type" = '${assertEnumLiteral(onlyType)}'::"measurement_type"`
    : "";
  return `
        SELECT w.*
        FROM (
          SELECT mm.*,
            FIRST_VALUE(mm."source") OVER (
              PARTITION BY mm."type", date_trunc('day', mm."measured_at")
              ORDER BY (${rankUnqualified}), mm."source"::text
            ) AS canonical_source
          FROM measurements mm
          WHERE mm."user_id" = $1
            AND mm."deleted_at" IS NULL
            ${since}
            ${typeOnly}
        ) w
        WHERE w."source" = w.canonical_source`;
}

/**
 * Build a FROM-clause subquery (aliased `m`) that restricts raw `measurements`
 * to the canonical-source rows per (type, day): the ladder-winning source for
 * each day, and only that source's readings. Use it in place of
 * `FROM measurements m` so a live aggregate over an overlapping vital never
 * blends two devices — the same collapse the rollup readers apply, kept in
 * lockstep for live/rollup parity.
 *
 * The user id is bound as `$1`; `rankUnqualified`, `window` and `onlyType` are
 * those of `canonicalMeasurementsCte`.
 */
export function canonicalMeasurementsFrom(
  rankUnqualified: string,
  window?: CanonicalWindow,
  onlyType?: MeasurementType,
): string {
  return `(${canonicalMeasurementsCte(rankUnqualified, window, onlyType)}
      ) m`;
}
