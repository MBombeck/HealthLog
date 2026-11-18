/**
 * The HealthKit sample types `POST /api/measurements/batch` maps today,
 * derived from `APPLE_HEALTH_TYPE_MAP` and the scored-assessment table and
 * nothing else, so the list the iOS app reads on
 * `GET /api/integrations/healthkit` cannot drift from what the batch route
 * accepts (#1340). A type in `HK_QUANTITY_TYPE_DEFERRED` is
 * by construction absent: the mapping test refuses a double-booking.
 */
import { APPLE_HEALTH_TYPE_MAP } from "@/lib/measurements/apple-health-mapping";
import { HK_SCORED_ASSESSMENT_INSTRUMENT } from "@/lib/mental-health/apple-health-assessment";

// The PHQ-9 and GAD-7 scored assessments ride the same batch and are written
// as screener administrations rather than measurements.
const ACCEPTED: readonly string[] = Object.freeze(
  [
    ...Object.keys(APPLE_HEALTH_TYPE_MAP),
    ...Object.keys(HK_SCORED_ASSESSMENT_INSTRUMENT),
  ].sort(),
);

/** Quantity and category identifiers the batch route maps, sorted. */
export function acceptedHealthKitTypes(): readonly string[] {
  return ACCEPTED;
}
