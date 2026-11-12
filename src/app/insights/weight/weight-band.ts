import { getEffectiveRange } from "@/lib/analytics/effective-range";
import {
  buildWeightRangeFromHeight,
  type TrafficRange,
} from "@/lib/analytics/value-bands";

/** The slice of `GET /api/insights/targets` the weight band needs. */
export interface WeightTargetsSlice {
  targets: ReadonlyArray<{
    type: string;
    range: { min: number; max: number } | null;
    source: string;
  }>;
  profile?: { heightCm: number | null };
}

/**
 * The weight band for the record on screen, as the server resolved it.
 *
 * The page used to read the person at the keyboard: their height from
 * `useAuth()` and their own target from `/api/user/thresholds`, which
 * refuses inside somebody else's record. A parent on a child's record saw a
 * band built from the parent's height. `/api/insights/targets` resolves the
 * record's own target and height, and the reference panel under the chart
 * reads the same payload. The record's own target (`source: "Custom"`) gets
 * the wings `getEffectiveRange` gives every override; otherwise the band is
 * the height-derived WHO one. Where the server names no range there is none:
 * no target and no height, or a child's record, which the adult WHO band does
 * not describe.
 */
export function selectWeightBandRange(
  data: WeightTargetsSlice | null,
): TrafficRange | null {
  const weight = data?.targets.find((entry) => entry.type === "WEIGHT");
  if (!data || !weight?.range) return null;
  if (weight.source === "Custom") {
    return getEffectiveRange(
      "WEIGHT",
      { heightCm: null, dateOfBirth: null, gender: null },
      { WEIGHT: weight.range },
    ).range;
  }
  const heightCm = data.profile?.heightCm ?? null;
  return heightCm ? buildWeightRangeFromHeight(heightCm) : null;
}
