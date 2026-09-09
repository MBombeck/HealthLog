import {
  groupByGlucoseContext,
  resolveGlucoseUnit,
  type GlucoseContextBucket,
} from "@/lib/glucose";
import { resolveGlucoseTarget } from "./glucose-targets";
import { makeRangeClassifier, rollupConsistency } from "./consistency";
import type { TargetGlucoseRow, TargetItem, TargetProfile } from "./types";

const LABEL_BY_CONTEXT: Record<GlucoseContextBucket, string> = {
  FASTING: "targets.glucoseFasting",
  POSTPRANDIAL: "targets.glucosePostprandial",
  RANDOM: "targets.glucoseRandom",
  BEDTIME: "targets.glucoseBedtime",
  UNSPECIFIED: "targets.glucoseUnspecified",
};

interface GlucoseTargetsInput {
  rows: TargetGlucoseRow[];
  profile: TargetProfile;
  timezone: string;
  now: Date;
}

export function buildGlucoseTargets({
  rows,
  profile,
  timezone,
  now,
}: GlucoseTargetsInput): TargetItem[] {
  const targets: TargetItem[] = [];
  const unit = resolveGlucoseUnit(profile.glucoseUnit);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // #943 — the untagged bucket rides the same loop. Iterating the four named
  // contexts alone left an account whose source writes no meal-time tag with
  // no glucose target at all, the same gap the dashboard tile had.
  for (const [context, contextRows] of groupByGlucoseContext(
    rows,
    (row) => row.glucoseContext,
  )) {
    const latest = contextRows[0].value;
    const recent = contextRows.filter((row) => row.measuredAt >= thirtyDaysAgo);
    const average30 =
      recent.length > 0
        ? Math.round(
            (recent.reduce((sum, row) => sum + row.value, 0) / recent.length) *
              10,
          ) / 10
        : null;
    const resolved = resolveGlucoseTarget({
      context,
      hasDiabetes: profile.hasDiabetes,
      profile: {
        heightCm: profile.heightCm,
        dateOfBirth: profile.dateOfBirth,
        gender: profile.gender,
      },
      overrides: profile.thresholdsJson,
    });
    const effectiveRange = resolved.range;
    const range = effectiveRange
      ? {
          min: effectiveRange.greenMin,
          max: effectiveRange.greenMax,
        }
      : null;
    let classification: TargetItem["classification"] = null;
    if (range && effectiveRange) {
      if (latest >= range.min && latest <= range.max) {
        classification = { category: "Optimal", color: "var(--success)" };
      } else if (
        latest >= effectiveRange.orangeMin &&
        latest <= effectiveRange.orangeMax
      ) {
        classification = {
          category: "Elevated",
          color: "var(--dracula-yellow)",
        };
      } else {
        classification = { category: "High", color: "var(--destructive)" };
      }
    }

    targets.push({
      type: `BLOOD_GLUCOSE_${context}`,
      label: LABEL_BY_CONTEXT[context],
      current: latest,
      average30,
      trend: null,
      unit,
      range,
      classification,
      source:
        resolved.source === "custom"
          ? "Custom"
          : resolved.source === "ADA goal (diabetes)"
            ? "ADA goal (diabetes)"
            : "ADA 2024 / DDG",
      ...rollupConsistency({
        events: recent.map((row) => ({
          measuredAt: row.measuredAt,
          value: row.value,
        })),
        classify: makeRangeClassifier(
          range,
          effectiveRange
            ? {
                orangeMin: effectiveRange.orangeMin,
                orangeMax: effectiveRange.orangeMax,
              }
            : undefined,
        ),
        timezone,
        now,
      }),
    });
  }

  return targets;
}
