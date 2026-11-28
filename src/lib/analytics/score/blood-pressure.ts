import type { Derived } from "@/lib/insights/derived/types";

import type { BloodPressurePillarInput, PillarValue } from "./types";
import {
  coverage,
  daysBetween,
  failedPillar,
  insufficientPillar,
  okPillar,
  withinWindow,
} from "./shared";
import { NBSP } from "@/lib/format/unit-join";

export const BLOOD_PRESSURE_WINDOW_DAYS = 90;
export const BLOOD_PRESSURE_MIN_PAIRS = 12;

export function computeBloodPressurePillar(
  input: BloodPressurePillarInput,
): Derived<PillarValue> {
  if (input.readFailed) {
    return failedPillar({
      id: "BLOOD_PRESSURE",
      asOf: input.asOf,
      windowDays: BLOOD_PRESSURE_WINDOW_DAYS,
    });
  }

  if (!input.target) {
    return insufficientPillar({
      id: "BLOOD_PRESSURE",
      source: input.source,
      asOf: input.asOf,
      windowDays: BLOOD_PRESSURE_WINDOW_DAYS,
      requiredInputs: BLOOD_PRESSURE_MIN_PAIRS,
      presentInputs: 0,
      historyDays: 0,
      missing: ["date of birth"],
      reason: "missing_reference_profile",
    });
  }

  const latestFresh =
    input.latestAt != null &&
    withinWindow(input.latestAt, input.asOf, BLOOD_PRESSURE_WINDOW_DAYS);
  const presentPairs = latestFresh ? input.pairCount : 0;
  const historyDays = latestFresh
    ? daysBetween(input.oldestAt, input.latestAt)
    : 0;

  if (
    presentPairs < BLOOD_PRESSURE_MIN_PAIRS ||
    input.graded == null ||
    input.representative == null ||
    input.latestAt == null
  ) {
    return insufficientPillar({
      id: "BLOOD_PRESSURE",
      source: input.source,
      asOf: input.asOf,
      windowDays: BLOOD_PRESSURE_WINDOW_DAYS,
      requiredInputs: BLOOD_PRESSURE_MIN_PAIRS,
      presentInputs: Math.min(presentPairs, BLOOD_PRESSURE_MIN_PAIRS),
      historyDays,
      missing: [
        `${Math.max(0, BLOOD_PRESSURE_MIN_PAIRS - presentPairs)} paired readings`,
      ],
      reason: latestFresh ? "below_reading_floor" : "stale_or_untracked",
    });
  }

  const representativeSys = Math.round(input.representative.sys);
  const representativeDia = Math.round(input.representative.dia);
  const target = input.target;
  return okPillar({
    id: "BLOOD_PRESSURE",
    source: input.source,
    asOf: input.asOf,
    windowDays: BLOOD_PRESSURE_WINDOW_DAYS,
    coverage: coverage({
      requiredInputs: BLOOD_PRESSURE_MIN_PAIRS,
      presentInputs: BLOOD_PRESSURE_MIN_PAIRS,
      historyDays,
    }),
    value: {
      score: input.graded.score,
      // Same object the score came out of, so the popover can only ever
      // explain the number beside it.
      scoreBasis: input.graded.basis,
      observed: {
        value: representativeSys,
        unit: "mmHg",
        label: `${representativeSys}/${representativeDia}${NBSP}mmHg`,
        asOf: input.latestAt.toISOString(),
        sources: input.sources,
      },
      reference: {
        kind: "clinical-threshold",
        low: target.sysLow,
        high: target.sysHigh,
        label: `${target.sysLow}–${target.sysHigh}/${target.diaLow}–${target.diaHigh}${NBSP}mmHg`,
        source: "ESH 2023",
      },
      personalReference: input.personalTarget
        ? {
            kind: "guideline-band",
            low: input.personalTarget.sysLow,
            high: input.personalTarget.sysHigh,
            label: `${input.personalTarget.sysLow}–${input.personalTarget.sysHigh}/${input.personalTarget.diaLow}–${input.personalTarget.diaHigh}${NBSP}mmHg`,
            source: "personal target",
          }
        : undefined,
      // The existing grade moves roughly four points over the first 1 mmHg
      // above its ceiling. One score point is therefore the smallest honest
      // integer movement; the pair-series aggregation handles reading noise.
      noiseFloor: 1,
      deltaEligible: true,
      deltaIdentity: "graded_bp_pair_series",
    },
  });
}
