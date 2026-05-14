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
 * Today (v1.4.25) only WITHINGS + MANUAL coexist. The function
 * effectively no-ops for every user because there's only one ingest
 * source per metric. The architecture lands here so v1.5's iOS
 * passthrough drops onto a known foundation.
 */
import type { MeasurementSource } from "@/generated/prisma/client";

import {
  DEFAULT_SOURCE_PRIORITY,
  parseSourcePriority,
  type SourcePriorityMetricKey,
} from "@/lib/validations/source-priority";

/**
 * Minimum row shape the helper consults — anything else on the row is
 * fine, the helper just narrows the type so it composes with the
 * existing Measurement reads without a transform step.
 */
export interface SourcePickerRow {
  measuredAt: Date;
  source: MeasurementSource;
}

/**
 * Pick the canonical-source rows for a per-day cumulative metric.
 *
 * Algorithm:
 *   1. Bucket rows by `dayKey(measuredAt)`.
 *   2. For each day, walk the priority list in order and pick the
 *      FIRST source that has any row in that bucket.
 *   3. Return every row from the picked source — drop rows from the
 *      other sources in the same bucket.
 *
 * Day-key strategy: the caller supplies the function so the analytics
 * paths (timezone-aware) and tests (deterministic ISO date) can share
 * code without dragging a TZ runtime into the helper.
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

  const priority =
    parseSourcePriority(userPriorityJson)[metricKey] ??
    DEFAULT_SOURCE_PRIORITY[metricKey];

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

  const canonicalRows: T[] = [];
  const pickedByDay = new Map<string, MeasurementSource>();
  for (const [key, slot] of buckets) {
    // Walk the priority list — first match wins.
    let picked: MeasurementSource | undefined;
    for (const source of priority) {
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
    for (const row of slot.rows) {
      if (row.source === picked) canonicalRows.push(row);
    }
  }

  return { canonicalRows, pickedByDay };
}
