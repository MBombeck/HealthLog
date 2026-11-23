import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
} from "@/lib/insights/derived/coverage";
import type {
  Derived,
  DerivedProvenanceSource,
} from "@/lib/insights/derived/types";

import type { WeightGoalValue } from "./types";
import { DAY_MS, provenance } from "./shared";

export interface WeightGoalReading {
  value: number;
  at: Date;
  source: string;
}

function distanceToBand(
  value: number,
  target: { min: number; max: number },
): number {
  return Math.max(0, target.min - value, value - target.max);
}

export function computeWeightGoal(args: {
  rows: WeightGoalReading[];
  target: { min: number; max: number } | null;
  source: DerivedProvenanceSource;
  asOf: Date;
  readFailed?: boolean;
  /**
   * A pregnancy or postpartum state holds: weight is data, not a
   * distance to a goal, so the card says why it shows none.
   */
  pregnancyContext?: boolean;
}): Derived<WeightGoalValue> {
  const since = new Date(args.asOf.getTime() - 60 * DAY_MS);
  const rowsInWindow = args.rows.filter(
    (row) => row.at >= since && row.at <= args.asOf,
  );
  const weightProvenance = provenance({
    inputs: ["WEIGHT", "personal weight target"],
    source: args.source,
    windowDays: 60,
    asOf: args.asOf,
  });
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 2,
    presentInputs: (rowsInWindow.length > 0 ? 1 : 0) + (args.target ? 1 : 0),
    historyDays: rowsInWindow.length > 0 ? 1 : 0,
    missing: [
      ...(rowsInWindow.length === 0 ? ["weight reading"] : []),
      ...(!args.target ? ["personal weight target"] : []),
    ],
    fullHistoryDays: 1,
  });
  if (args.readFailed) {
    return buildInsufficient({
      coverage,
      provenance: weightProvenance,
      reason: "read_failed",
    });
  }
  if (args.pregnancyContext) {
    return buildInsufficient({
      coverage,
      provenance: weightProvenance,
      reason: "pregnancy_context",
    });
  }
  if (!args.target || rowsInWindow.length === 0) {
    return buildInsufficient({
      coverage,
      provenance: weightProvenance,
      reason: args.target ? "weight_not_tracked" : "no_personal_goal",
    });
  }

  const rows = [...rowsInWindow].sort(
    (a, b) => b.at.getTime() - a.at.getTime(),
  );
  const latest = rows[0];
  const previous = rows.find(
    (row) => row.at <= new Date(latest.at.getTime() - 7 * DAY_MS),
  );
  const latestDistance = distanceToBand(latest.value, args.target);
  const previousDistance = previous
    ? distanceToBand(previous.value, args.target)
    : null;
  return buildOk({
    value: {
      currentKg: latest.value,
      target: args.target,
      distanceKg: latestDistance,
      deltaKg:
        previousDistance == null
          ? null
          : Math.round((previousDistance - latestDistance) * 10) / 10,
      asOf: latest.at.toISOString(),
      source: latest.source,
    },
    coverage,
    confidence,
    provenance: weightProvenance,
  });
}
