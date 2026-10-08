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
  // v1.18.10 I-5 — STRESS_SCORE carries a source-priority ladder (`stress`)
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
 * Build the canonical-source SELECT body — the raw `measurements` rows
 * restricted to the ladder-winning source per (type, day) — WITHOUT the
 * outer `( … ) m` alias wrapper. The inner `DISTINCT ON` picks the
 * canonical source for each day and the join keeps only that source's
 * readings.
 *
 * Use this when the same canonical set must be referenced more than once in
 * one statement (e.g. a `window_stats` CTE plus the outer aggregate): bind it
 * once via `WITH cm AS (${canonicalMeasurementsCte(...)})` and select
 * `FROM cm m` everywhere, so the expensive DISTINCT-ON self-join runs once
 * rather than per reference. For the single-reference case use
 * `canonicalMeasurementsFrom`, which wraps this body in the alias.
 *
 * The user id is bound as `$1`. `rankUnqualified` must be a CASE built with
 * unqualified `"type"`/`"source"` columns. `sinceInterval` (e.g. `"90 days"`)
 * is whitelisted and, when given, scopes both the inner pick and the outer
 * filter to a trailing window. `onlyType`, when given, scopes both halves to
 * that one metric.
 */
export function canonicalMeasurementsCte(
  rankUnqualified: string,
  sinceInterval?: string,
  onlyType?: MeasurementType,
): string {
  const sinceInner = sinceInterval
    ? `AND "measured_at" >= NOW() - INTERVAL '${assertInterval(sinceInterval)}'`
    : "";
  const sinceOuter = sinceInterval
    ? `AND mm."measured_at" >= NOW() - INTERVAL '${assertInterval(sinceInterval)}'`
    : "";
  // A single-type reader (a series for one metric) scopes both halves to that
  // type, so the pick scans one metric's rows instead of every row the user
  // has in the window.
  const typeInner = onlyType
    ? `AND "type" = '${assertEnumLiteral(onlyType)}'::"measurement_type"`
    : "";
  const typeOuter = onlyType
    ? `AND mm."type" = '${assertEnumLiteral(onlyType)}'::"measurement_type"`
    : "";
  return `
        SELECT mm.*
        FROM measurements mm
        JOIN (
          SELECT DISTINCT ON ("type", date_trunc('day', "measured_at"))
            "type"                           AS t,
            date_trunc('day', "measured_at") AS d,
            "source"                         AS canon
          FROM measurements
          WHERE "user_id" = $1
            AND "deleted_at" IS NULL
            ${sinceInner}
            ${typeInner}
          ORDER BY "type", date_trunc('day', "measured_at"), (${rankUnqualified}), "source"::text
        ) c
          ON c.t = mm."type"
          AND c.d = date_trunc('day', mm."measured_at")
          AND c.canon = mm."source"
        WHERE mm."user_id" = $1
          AND mm."deleted_at" IS NULL
          ${sinceOuter}
          ${typeOuter}`;
}

/**
 * Build a FROM-clause subquery (aliased `m`) that restricts raw `measurements`
 * to the canonical-source rows per (type, day): the inner `DISTINCT ON` picks
 * the ladder-winning source for each day, and the join keeps only that source's
 * readings. Use it in place of `FROM measurements m` so a live aggregate over
 * an overlapping vital never blends two devices — the same collapse the rollup
 * readers apply, kept in lockstep for live/rollup parity.
 *
 * The user id is bound as `$1`. `rankUnqualified` must be a CASE built with
 * unqualified `"type"`/`"source"` columns. `sinceInterval` (e.g. `"90 days"`)
 * is whitelisted and, when given, scopes both the inner pick and the outer
 * filter to a trailing window.
 */
export function canonicalMeasurementsFrom(
  rankUnqualified: string,
  sinceInterval?: string,
  onlyType?: MeasurementType,
): string {
  return `(${canonicalMeasurementsCte(rankUnqualified, sinceInterval, onlyType)}
      ) m`;
}
