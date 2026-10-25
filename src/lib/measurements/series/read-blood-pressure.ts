/**
 * The blood-pressure series: systolic points paired with the diastolic of
 * the same source within five minutes, from the ladder's one source per day.
 */
import { prisma } from "@/lib/db";
import { VALUE_RANGES } from "@/lib/validations/measurement";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";

import type { SeriesRead } from "./kinds";

export async function readBloodPressureSeries(
  userId: string,
  since: Date,
): Promise<SeriesRead> {
  // Exclude non-physiological rows (systolic < 40 / diastolic < 20) from the
  // series AND the implicit "latest" (the last point). BP is two rows paired
  // client-side, so a corrupt row that slipped in before the input floor was
  // enforced — a seed-era systolic-0, iOS #33 — must never surface as the
  // latest reading. Floors mirror VALUE_RANGES (the input validator's min);
  // this is a read-side selection guard, not a tightening of the write floor.
  //
  // The ladder picks ONE source per day for the reading, not one per type:
  // the source is chosen from the day's systolic rows that pass the floor,
  // and both halves are read from it. Two per-type picks diverge whenever a
  // source holds only half of a reading on a day (a deleted diastolic, a
  // sub-floor systolic, an orphaned sample), and the pairing below then
  // joined one source's systolic to another source's diastolic. Picking on
  // floor-passing systolic rows also keeps a corrupt row from claiming a day
  // it then contributes nothing to. The day is the UTC day, as in every
  // other ladder read (`canonicalMeasurementsCte`), and the pick looks at
  // the whole edge day, not only the slice after `since`.
  //
  // `rank` is the closed-enum whitelist splice from `buildSourceRankCase`;
  // every request value is a positional parameter. The statement and why it
  // is a window rather than a join are under `bloodPressureSeriesSql`.
  const rank = buildSourceRankCase(
    await loadUserSourcePriority(userId),
    '"type"',
    '"source"',
  );
  const bpRows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      type: "BLOOD_PRESSURE_SYS" | "BLOOD_PRESSURE_DIA";
      source: string;
      value: number;
      measured_at: Date;
    }>
  >(
    bloodPressureSeriesSql(rank),
    userId,
    since,
    VALUE_RANGES.BLOOD_PRESSURE_SYS.min,
    VALUE_RANGES.BLOOD_PRESSURE_DIA.min,
  );
  const sys = bpRows.filter((r) => r.type === "BLOOD_PRESSURE_SYS");
  // Diastolic rows per source: a pair is only ever made inside one source,
  // which also holds across midnight, where the two days may have picked
  // different sources.
  const diaBySource = new Map<string, typeof bpRows>();
  for (const r of bpRows) {
    if (r.type !== "BLOOD_PRESSURE_DIA") continue;
    const list = diaBySource.get(r.source);
    if (list) list.push(r);
    else diaBySource.set(r.source, [r]);
  }

  // Pair by closest timestamp within ±5 minutes. Both reads arrive
  // sorted ascending, so the nearest-diastolic index is non-decreasing
  // across the systolic walk — a two-pointer merge (one pointer per
  // source) finds each pair in O(sys + dia) instead of the previous full
  // diastolic rescan per systolic row (O(sys × dia) — quadratic on dense
  // imports). Ties keep the earlier diastolic row, matching the old
  // scan's strict-`<` keep.
  const PAIR_WINDOW_MS = 5 * 60_000;
  const diaIdx = new Map<string, number>();
  const points = sys.map((s) => {
    const sysMs = s.measured_at.getTime();
    const dia = diaBySource.get(s.source) ?? [];
    let idx = diaIdx.get(s.source) ?? 0;
    while (
      idx + 1 < dia.length &&
      Math.abs(dia[idx + 1].measured_at.getTime() - sysMs) <
        Math.abs(dia[idx].measured_at.getTime() - sysMs)
    ) {
      idx += 1;
    }
    diaIdx.set(s.source, idx);
    const best = dia[idx];
    const paired =
      best !== undefined &&
      Math.abs(best.measured_at.getTime() - sysMs) <= PAIR_WINDOW_MS;
    return {
      id: s.id,
      at: s.measured_at.toISOString(),
      value: s.value,
      secondary: paired ? best.value : null,
    };
  });
  return { points };
}

/**
 * The series statement: every floor-passing systolic and diastolic row from
 * `$2` on, of the source the ladder picks for its UTC day. `$1` is the user,
 * `$2` the window start, `$3` and `$4` the systolic and diastolic floors;
 * `rank` is a `buildSourceRankCase` CASE over unqualified `"type"` and
 * `"source"`.
 *
 * One scan reads the window from the start of its first UTC day, so the pick
 * sees the whole edge day. A window function names each day's source on
 * every row: the day's rows are ordered systolic first, then by ladder rank,
 * then by source name, and the first row's source is taken only when that
 * row is a systolic one, so a day with no floor-passing systolic picks no
 * source and shows nothing, as before. Rows of any other source, and rows
 * of the edge day before `$2`, are dropped after the pick.
 *
 * Why no join: the pick used to be a `DISTINCT ON` over the day's systolic
 * rows joined back to the readings. On a table without planner statistics
 * (a new install, an import still under the autoanalyze threshold) the
 * planner estimated one row on each side and ran that join as a nested loop
 * that rescanned the pick for every reading: ten years of readings cost
 * about 5,000 row visits per row. The window has no such choice to get
 * wrong; `tests/integration/canonical-source-pick-unanalysed.test.ts` holds
 * that, and `tests/integration/bp-series-pick-parity.test.ts` holds the old
 * statement as the reference for the rows it returns.
 */
export function bloodPressureSeriesSql(rank: string): string {
  return `
    SELECT w."id", w."type"::text AS type, w."source"::text AS source,
           w."value", w."measured_at"
    FROM (
      SELECT mm."id", mm."type", mm."source", mm."value", mm."measured_at",
        FIRST_VALUE(
          CASE WHEN mm."type" = 'BLOOD_PRESSURE_SYS'::"measurement_type"
            THEN mm."source" END
        ) OVER (
          PARTITION BY date_trunc('day', mm."measured_at")
          ORDER BY mm."type" <> 'BLOOD_PRESSURE_SYS'::"measurement_type",
            (${rank}), mm."source"::text
        ) AS canonical_source
      FROM measurements mm
      WHERE mm."user_id" = $1
        AND mm."deleted_at" IS NULL
        AND mm."measured_at" >= date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC')
        AND (
          (mm."type" = 'BLOOD_PRESSURE_SYS'::"measurement_type" AND mm."value" >= $3)
          OR (mm."type" = 'BLOOD_PRESSURE_DIA'::"measurement_type" AND mm."value" >= $4)
        )
    ) w
    WHERE w."source" = w.canonical_source
      AND w."measured_at" >= $2
    ORDER BY w."measured_at" ASC, w."id" ASC
  `;
}
