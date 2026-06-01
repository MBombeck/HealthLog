"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Target } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { Card, CardContent } from "@/components/ui/card";

/**
 * v1.8.0 — surface the numeric target range + in-target share on each
 * insights category page, directly beneath the chart / assessment.
 *
 * The data is the same `/api/insights/targets` payload that powers the
 * `/targets` editing surface — this component reads the shared
 * `queryKeys.insightsTargets()` cache, so on a session that has already
 * visited `/targets` the read is free, and on a cold sub-page it warms a
 * cache the `/targets` page then reuses. We never recompute the ranges
 * here: the route is the single source of truth for the age-based ESH
 * blood-pressure band, the WHO weight / BMI band, the Karvonen pulse
 * band, the AASM sleep band, and the medication / mood / step targets.
 *
 * Each insights slug maps to one target `type`. Blood pressure is the one
 * composite case: the route emits the systolic band on the
 * `BLOOD_PRESSURE` target and the diastolic band on the top-level
 * `bpDiastolic` slot, so we stitch them back into a `S/D` range string.
 *
 * The "in target" share reads `daysInRange30d / daysLogged30d` — the
 * fraction of logged days over the last 30 whose mean reading landed in
 * the green band. We hide the share alone when the route flags
 * `insufficientData`; the range stays visible so the band is always
 * legible. This matches the `/targets` consistency strip so the two
 * surfaces never disagree.
 *
 * A discreet "Adjust target range" link routes to `/targets`, which
 * stays the canonical place to view / tune the bands.
 */

interface TargetRange {
  min: number;
  max: number;
}

interface TargetItem {
  type: string;
  current: number | null;
  unit: string;
  range: TargetRange | null;
  daysInRange30d: number;
  daysLogged30d: number;
  insufficientData: boolean;
}

interface TargetsResponse {
  targets: TargetItem[];
  bpDiastolic: {
    current: number | null;
    range: TargetRange | null;
  };
}

/**
 * Map each insights category slug to the target `type` the route emits.
 * Slugs without a numeric target (HRV, oxygen saturation, body
 * temperature, active energy, workouts, resting HR) are absent — the
 * component renders nothing for them, so the sub-page collapses cleanly.
 */
const SLUG_TO_TARGET_TYPE: Record<string, string> = {
  "blood-pressure": "BLOOD_PRESSURE",
  weight: "WEIGHT",
  bmi: "BMI",
  pulse: "PULSE",
  sleep: "SLEEP_DURATION",
  mood: "MOOD_SCORE",
  medications: "MEDICATION_COMPLIANCE",
};

interface MetricTargetSummaryProps {
  /** Insights category slug, e.g. `"blood-pressure"`. */
  slug: string;
}

/** Trim a trailing `.0` so whole-number bands read `120` not `120.0`. */
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function MetricTargetSummary({ slug }: MetricTargetSummaryProps) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const targetType = SLUG_TO_TARGET_TYPE[slug];

  const { data } = useQuery({
    queryKey: queryKeys.insightsTargets(),
    queryFn: async () => {
      const res = await fetch("/api/insights/targets");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as TargetsResponse;
    },
    enabled: isAuthenticated && targetType != null,
  });

  // No numeric target for this slug, or the payload hasn't resolved yet.
  if (!targetType || !data) return null;

  const target = data.targets.find((entry) => entry.type === targetType);
  if (!target || !target.range) return null;

  const { range, unit } = target;

  // Compose the range string. Blood pressure stitches the systolic band
  // (on this target) with the diastolic band (on `bpDiastolic`) so the
  // user reads the familiar `S/D` pair.
  let rangeLabel: string;
  if (targetType === "BLOOD_PRESSURE" && data.bpDiastolic.range) {
    const dia = data.bpDiastolic.range;
    rangeLabel = t("insights.subPage.target.bpRange", {
      sysMin: fmt(range.min),
      sysMax: fmt(range.max),
      diaMin: fmt(dia.min),
      diaMax: fmt(dia.max),
      unit,
    });
  } else {
    rangeLabel = t("insights.subPage.target.range", {
      min: fmt(range.min),
      max: fmt(range.max),
      unit,
    });
  }

  // In-target share: fraction of logged days in the green band over the
  // last 30. Suppressed when the route flagged insufficient data so the
  // sub-page mirrors the `/targets` strip exactly.
  const showShare =
    !target.insufficientData && target.daysLogged30d > 0;
  const sharePct = showShare
    ? Math.round((target.daysInRange30d / target.daysLogged30d) * 100)
    : null;

  return (
    <Card data-slot="metric-target-summary">
      <CardContent className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
        <div className="flex items-center gap-2.5">
          <Target
            className="text-dracula-green size-4 shrink-0"
            aria-hidden="true"
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{rangeLabel}</p>
            {sharePct != null ? (
              <p className="text-muted-foreground text-xs">
                {t("insights.subPage.target.inTargetShare", {
                  pct: sharePct,
                })}
              </p>
            ) : null}
          </div>
        </div>
        <Link
          href="/targets"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex min-h-11 items-center rounded-sm px-1 text-xs font-medium underline-offset-4 transition-colors hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          {t("insights.subPage.target.adjustLink")}
        </Link>
      </CardContent>
    </Card>
  );
}
