/**
 * v1.4.25 W5e — cross-source canonical-row picker.
 *
 * Cumulative metrics (steps, active energy, walking/running distance,
 * flights climbed, sleep duration) sum-per-day. When two sources both
 * record steps for the same day — say WITHINGS via the Withings
 * Activity API and APPLE_HEALTH via the iOS passthrough — naïvely
 * summing every row double-counts. This helper picks ONE source per
 * day according to the user's per-metric-class priority list and
 * drops rows from the other sources from the aggregation set.
 *
 * Important: dropping a row from the aggregation set does NOT delete
 * it from the DB. The non-canonical rows stay in `measurements` as an
 * audit trail — the user can flip the priority and the analytics
 * re-pick instantly without a re-sync.
 *
 * v1.4.25 W8c — two-axis pick. After narrowing to the winning source,
 * the picker now consults a device-type ladder ("watch beats phone
 * beats scale") and keeps ONLY the rows from the top-ranked device-
 * type present in that day's bucket. Rationale: a user wearing an
 * Apple Watch + carrying an iPhone + standing on a Withings scale
 * pushes three different hourly step streams into HealthKit; summing
 * them triple-counts. The watch's stream is the most reliable
 * "moving body" signal, so we keep the watch rows and drop the phone
 * + scale rows. Rows tagged with `deviceType = null` resolve to
 * `"unknown"` (lowest rank) and are kept only if NO ranked device-type
 * coexists in the same day — never silently dropped.
 *
 * Picker stays O(n) overall with O(1) device-type rank lookups.
 */
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";

import {
  type DeviceType,
  getDeviceTypeLadder,
  getSourceLadder,
  normalizeDeviceType,
  parseSourcePriority,
  type SourcePriorityMetricKey,
} from "@/lib/validations/source-priority";

/**
 * Minimum row shape the helper consults — anything else on the row is
 * fine, the helper just narrows the type so it composes with the
 * existing Measurement reads without a transform step.
 *
 * `deviceType` is the v1.4.25 W8c nullable column. Legacy rows + every
 * pre-W8c Measurement leaves it `null`; the picker maps null → unknown
 * via `normalizeDeviceType()` so the picker never branches on
 * presence.
 *
 * `type` is the `MeasurementType` enum on each Measurement row and
 * lets the picker reach into the per-metric device-type override
 * without re-deriving it from the caller's `metricKey`. Optional so
 * callers who only carry an aggregation-bucket key (e.g. legacy paths)
 * still compile; the picker falls back to the user-default ladder
 * when absent.
 */
export interface SourcePickerRow {
  measuredAt: Date;
  source: MeasurementSource;
  deviceType?: string | null;
  type?: MeasurementType | null;
}

/**
 * Pick the canonical-source rows for a per-day cumulative metric.
 *
 * Algorithm (v1.4.25 W8c two-axis):
 *   1. Bucket rows by `dayKey(measuredAt)`.
 *   2. For each day, walk the SOURCE priority list in order and pick
 *      the FIRST source that has any row in that bucket.
 *   3. Among the picked source's rows in that bucket, walk the
 *      DEVICE-TYPE priority list and keep ONLY rows from the FIRST
 *      device-type that has any row in that bucket. Cumulative-metric
 *      callers sum these without double-counting; point-metric
 *      callers pick the latest downstream.
 *   4. If `deviceTypePriority` has a per-metric override keyed by the
 *      row's `MeasurementType`, that wins over the user's default
 *      ladder which wins over `DEFAULT_DEVICE_TYPE_PRIORITY`.
 *   5. Rows whose device-type isn't in the ladder fall through as
 *      `"unknown"`; they only survive when no ranked device-type
 *      coexists in the same day, so legacy NULL-tagged rows still
 *      contribute when they're the only signal.
 *
 * Day-key strategy: the caller supplies the function so the analytics
 * paths (timezone-aware) and tests (deterministic ISO date) can share
 * code without dragging a TZ runtime into the helper.
 *
 * Determinism precondition: input rows MUST be in a deterministic
 * order (typically `ORDER BY measuredAt ASC, id ASC` from the caller's
 * Prisma read). The picker's bucket map preserves insertion order, so
 * the output's stability — including tie-breaking on first-seen
 * device-type — depends on the caller honouring this contract.
 *
 * @returns the filtered row list (subset of input) plus the
 *          per-day picked source — useful for debug overlays / audit
 *          logging downstream.
 */
export function pickCanonicalSourceRows<T extends SourcePickerRow>(
  rows: readonly T[],
  metricKey: SourcePriorityMetricKey,
  userPriorityJson: unknown,
  dayKey: (d: Date) => string,
): {
  canonicalRows: T[];
  pickedByDay: Map<string, MeasurementSource>;
} {
  if (rows.length === 0) {
    return { canonicalRows: [], pickedByDay: new Map() };
  }

  const resolved = parseSourcePriority(userPriorityJson);
  const sourceLadder = getSourceLadder(resolved, metricKey);

  // Bucket per day, track which sources contributed rows in each bucket.
  const buckets = new Map<
    string,
    {
      rows: T[];
      sources: Set<MeasurementSource>;
    }
  >();
  for (const row of rows) {
    const key = dayKey(row.measuredAt);
    const slot = buckets.get(key) ?? { rows: [], sources: new Set() };
    slot.rows.push(row);
    slot.sources.add(row.source);
    buckets.set(key, slot);
  }

  // Cache device-type ladders by (MeasurementType | "__default__") so a
  // bucket with mixed-type rows resolves the ladder once per type
  // rather than once per row. Resolution itself lives in
  // `getDeviceTypeLadder` — the cache is the only extra layer here.
  const ladderCache = new Map<string, readonly DeviceType[]>();
  function resolveLadder(rowType: MeasurementType | null | undefined): readonly DeviceType[] {
    const cacheKey = rowType ?? "__default__";
    let ladder = ladderCache.get(cacheKey);
    if (!ladder) {
      ladder = getDeviceTypeLadder(resolved, rowType ?? "default");
      ladderCache.set(cacheKey, ladder);
    }
    return ladder;
  }

  const canonicalRows: T[] = [];
  const pickedByDay = new Map<string, MeasurementSource>();
  for (const [key, slot] of buckets) {
    // ── Axis 1: walk the source priority list — first match wins. ──
    let picked: MeasurementSource | undefined;
    for (const source of sourceLadder) {
      if (slot.sources.has(source)) {
        picked = source;
        break;
      }
    }
    // Fallback: if NONE of the priority-listed sources are present
    // (e.g. a legacy IMPORT row that's not in the priority list),
    // keep every row in the bucket so legacy ingest paths don't go
    // dark when the priority list doesn't enumerate IMPORT.
    if (!picked) {
      canonicalRows.push(...slot.rows);
      continue;
    }
    pickedByDay.set(key, picked);

    // Narrow to the winning source's rows for this day.
    const pickedRows = slot.rows.filter((row) => row.source === picked);

    // ── Axis 2: keep only rows from the top-ranked device-type. ──
    // Single-row fast path — no device-type discrimination needed.
    if (pickedRows.length === 1) {
      canonicalRows.push(pickedRows[0]);
      continue;
    }

    // If every row in this bucket is unknown/null (no device-type
    // info), the second axis can't differentiate anything — keep
    // every row. Same intent as the source-axis fallback above:
    // never silently drop data when the picker has no signal to
    // filter on. This is the v1.4.25-today behaviour for Withings
    // rows whose webhook didn't carry a device hint.
    const hasAnyKnownDeviceType = pickedRows.some(
      (row) => normalizeDeviceType(row.deviceType) !== "unknown",
    );
    if (!hasAnyKnownDeviceType) {
      canonicalRows.push(...pickedRows);
      continue;
    }

    // Per-row ladder resolution. Single-type buckets (today's only
    // call site — `SLEEP_DURATION` aggregation in `/api/analytics`)
    // hit the `ladderCache` once and walk an O(rows) loop. Mixed-type
    // buckets (future Coach evidence rollup, doctor-PDF section,
    // correlations engine) resolve their per-row ladders from the
    // cache and pick the winning device-type independently per type
    // — every MeasurementType in the bucket keeps its own winner so
    // a callsite that batches WEIGHT + BODY_FAT through one picker
    // call doesn't drop one type's rows against the wrong ladder.
    //
    // Group present device-types per row-type so each type's winning
    // device-type is resolved against the right ladder.
    const presentByType = new Map<
      MeasurementType | "__default__",
      Set<DeviceType>
    >();
    for (const row of pickedRows) {
      const typeKey = (row.type ?? "__default__") as
        | MeasurementType
        | "__default__";
      const set = presentByType.get(typeKey) ?? new Set<DeviceType>();
      set.add(normalizeDeviceType(row.deviceType));
      presentByType.set(typeKey, set);
    }

    // Pick the winning device-type per row-type. `__default__` covers
    // legacy rows that arrive without a `type` field — they fall back
    // to the user-default ladder so the picker never silently drops
    // them.
    const winningDeviceTypeByRowType = new Map<
      MeasurementType | "__default__",
      DeviceType | "__fallback__"
    >();
    for (const [typeKey, presentSet] of presentByType) {
      const ladder = resolveLadder(
        typeKey === "__default__" ? null : (typeKey as MeasurementType),
      );
      let winner: DeviceType | undefined;
      for (const dt of ladder) {
        if (presentSet.has(dt)) {
          winner = dt;
          break;
        }
      }
      // Edge case: the user's custom ladder for THIS row-type doesn't
      // enumerate any device-type in the bucket. Fall through to keep
      // every row of that type — same intent as the source-axis
      // fallback (never silently drop data when the picker has no
      // ladder signal to filter on).
      winningDeviceTypeByRowType.set(typeKey, winner ?? "__fallback__");
    }

    for (const row of pickedRows) {
      const typeKey = (row.type ?? "__default__") as
        | MeasurementType
        | "__default__";
      const winner = winningDeviceTypeByRowType.get(typeKey);
      if (winner === "__fallback__") {
        // Per-type fallback: keep every row of this type.
        canonicalRows.push(row);
        continue;
      }
      if (normalizeDeviceType(row.deviceType) === winner) {
        canonicalRows.push(row);
      }
    }
  }

  return { canonicalRows, pickedByDay };
}
