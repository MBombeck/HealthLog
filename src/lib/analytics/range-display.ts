/**
 * The range delta in the unit the account reads, with that unit named.
 *
 * `computeRangeDelta` works in the stored canonical unit, which is what the
 * dashboard summary compares in. The `/api/analytics/range` answer goes to a
 * client, and a client must not guess: blood glucose follows the account's
 * glucose unit, the metric/imperial types (weight, length, distance,
 * temperature, …) follow its unit system, and every answer carries the unit
 * its numbers are in. One resolver decides it, `getReadingTransform`, the
 * same one the series route's glucose conversion and the server-built texts
 * read.
 *
 * Absolute values (min, max, mean) take the whole transform; the delta takes
 * the factor alone, since an offset (°C to °F) shifts both means by the same
 * amount. A sum of `count` readings takes the offset `count` times. The
 * percentage is recomputed from the converted means so it describes the
 * numbers shown beside it. The trend keeps the stored comparison: a positive
 * factor never turns a direction around.
 */
import type {
  RangeDeltaResult,
  WindowAggregate,
} from "@/lib/analytics/range-shared";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getReadingTransform,
  transformRescales,
  type DisplayTransform,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";
import { getUnitForType } from "@/lib/measurements/unit-map";

export interface RangeDeltaInUnit extends RangeDeltaResult {
  /** The unit every number of this answer is in. */
  unit: string;
}

function convertAggregate(
  agg: WindowAggregate,
  transform: DisplayTransform,
): WindowAggregate {
  const abs = (v: number | null) =>
    v === null ? null : applyDisplayTransform(v, transform);
  const sum =
    agg.sum === null
      ? null
      : applyDisplayTransformDelta(agg.sum, transform) +
        (transform.offset ?? 0) * agg.count;
  return {
    count: agg.count,
    min: abs(agg.min),
    max: abs(agg.max),
    mean: abs(agg.mean),
    sum,
  };
}

export function rangeDeltaInUnit(
  result: RangeDeltaResult,
  type: string,
  preferences: UnitPreferences,
): RangeDeltaInUnit {
  const transform = getReadingTransform(type, preferences);
  const canonical = getUnitForType(type);
  if (!transformRescales(transform)) {
    return { ...result, unit: transform.displayUnit || canonical };
  }
  const current = convertAggregate(result.current, transform);
  const previous = convertAggregate(result.previous, transform);
  const delta =
    result.delta === null
      ? null
      : applyDisplayTransformDelta(result.delta, transform);
  const deltaPct =
    delta === null || previous.mean === null || previous.mean === 0
      ? null
      : delta / previous.mean;
  return {
    ...result,
    current,
    previous,
    delta,
    deltaPct,
    unit: transform.displayUnit || canonical,
  };
}
