"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Scale,
  Heart,
  Activity,
  Moon,
  Percent,
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertCircle,
  ExternalLink,
  Smile,
  Droplet,
} from "lucide-react";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";

interface TargetData {
  type: string;
  label: string;
  current: number | null;
  average30: number | null;
  trend: "up" | "down" | "stable" | null;
  unit: string;
  range: { min: number; max: number } | null;
  classification: { category: string; color: string } | null;
  source: string;
  // v1.4.25 W3e — consistency strip + recency + streak. Optional on the
  // client so the i18n / spacing tests that only pre-populate
  // classification + range still type-check; the runtime route always
  // sets these.
  daysInRange7d?: number;
  daysLogged7d?: number;
  daysInRange30d?: number;
  daysLogged30d?: number;
  lastMetGoalAt?: string | null;
  streakDays?: number;
  insufficientData?: boolean;
  consistency7d?: ReadonlyArray<"in" | "near" | "out" | null>;
  details?: {
    medications?: Array<{
      name: string;
      compliance7: number;
      compliance30: number;
    }>;
  };
}

interface BpDiastolic {
  current: number | null;
  average30: number | null;
  range: { min: number; max: number } | null;
}

interface TargetPageSummary {
  targetsMetThisWeek: number;
  totalTargets: number;
  streakHighlight: { metric: string; days: number } | null;
}

interface TargetsResponse {
  targets: TargetData[];
  pageSummary?: TargetPageSummary;
  bpDiastolic: BpDiastolic;
  profile: {
    heightCm: number | null;
    age: number | null;
    gender: string | null;
    glucoseUnit?: string | null;
  };
}

const TYPE_ICONS: Record<string, typeof Scale> = {
  WEIGHT: Scale,
  BLOOD_PRESSURE: Heart,
  BLOOD_PRESSURE_IN_TARGET: Heart,
  PULSE: Activity,
  SLEEP_DURATION: Moon,
  BODY_FAT: Percent,
  BMI: Scale,
  MOOD_SCORE: Smile,
  MOOD_STABILITY: Smile,
  BLOOD_GLUCOSE_FASTING: Droplet,
  BLOOD_GLUCOSE_POSTPRANDIAL: Droplet,
  BLOOD_GLUCOSE_RANDOM: Droplet,
  BLOOD_GLUCOSE_BEDTIME: Droplet,
};

const TYPE_COLORS: Record<string, string> = {
  WEIGHT: "text-dracula-purple",
  BLOOD_PRESSURE: "text-dracula-pink",
  BLOOD_PRESSURE_IN_TARGET: "text-dracula-pink",
  PULSE: "text-dracula-green",
  SLEEP_DURATION: "text-dracula-cyan",
  BODY_FAT: "text-dracula-orange",
  BMI: "text-dracula-yellow",
  MOOD_SCORE: "text-dracula-lavender",
  MOOD_STABILITY: "text-dracula-lavender",
  BLOOD_GLUCOSE_FASTING: "text-dracula-red",
  BLOOD_GLUCOSE_POSTPRANDIAL: "text-dracula-red",
  BLOOD_GLUCOSE_RANDOM: "text-dracula-red",
  BLOOD_GLUCOSE_BEDTIME: "text-dracula-red",
};

const GLUCOSE_TYPES = new Set([
  "BLOOD_GLUCOSE_FASTING",
  "BLOOD_GLUCOSE_POSTPRANDIAL",
  "BLOOD_GLUCOSE_RANDOM",
  "BLOOD_GLUCOSE_BEDTIME",
]);

/**
 * Map server-emitted classification.category strings to the i18n
 * key under `targets.status.*`. The server is the source of truth
 * for the category set (lib/analytics/classifications.ts +
 * pulse-targets.ts + targets/route.ts inline maps); v1.4.19 phase
 * A7 wires this map so the German locale stops surfacing English
 * status pills like "Low / On Target / Stable / Moderate" — the
 * exact regression the maintainer reported.
 */
const STATUS_CATEGORY_KEY: Record<string, string> = {
  // BMI
  Underweight: "underweight",
  Normal: "normal",
  Overweight: "overweight",
  "Obesity Grade I": "obesityGrade1",
  "Obesity Grade II": "obesityGrade2",
  "Obesity Grade III": "obesityGrade3",
  // BP
  Optimal: "optimal",
  "High-normal": "highNormal",
  "Hypertension Grade 1": "hypertensionGrade1",
  "Hypertension Grade 2": "hypertensionGrade2",
  "Hypertension Grade 3": "hypertensionGrade3",
  // Pulse
  Bradycardia: "bradycardia",
  Elevated: "elevated",
  Tachycardia: "tachycardia",
  // Pulse target / sleep target
  "Significantly low": "significantlyLow",
  "Slightly low": "slightlyLow",
  "On target": "onTarget",
  "Slightly elevated": "slightlyElevated",
  "Significantly elevated": "significantlyElevated",
  // Sleep
  "Far too short": "farTooShort",
  "Too short": "tooShort",
  "Slightly long": "slightlyLong",
  "Far too long": "farTooLong",
  // Body fat
  "Below essential": "belowEssential",
  Essential: "essential",
  Athletic: "athletic",
  Fitness: "fitness",
  Acceptable: "acceptable",
  Obese: "obese",
  // Steps
  "Very low": "veryLow",
  "Low active": "lowActive",
  "Moderately active": "moderatelyActive",
  Active: "active",
  "Very active": "veryActive",
  // Generic / shared (BP-on-target, mood, medication compliance, glucose)
  Good: "good",
  Moderate: "moderate",
  Low: "low",
  High: "high",
  "Very good": "veryGood",
  "Very stable": "veryStable",
  Stable: "stable",
  Fluctuating: "fluctuating",
};

/** Resolve a server-emitted classification.category to its translated label. */
function translateStatus(
  category: string,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  const key = STATUS_CATEGORY_KEY[category];
  if (!key) return category; // unmapped — fall back to verbatim string
  return t(`targets.status.${key}`);
}

/** Resolve a target's display label.
 *
 * Glucose contexts are special-cased: the server emits an i18n key
 * (e.g. `targets.glucoseFasting`) as its `label`, and the page's
 * top-level `visibleTargets` mapping resolves that to a localised
 * string before the card mounts. So when this helper runs, glucose
 * targets already carry the localised label and the i18n lookup
 * below misses (no `targets.label.BLOOD_GLUCOSE_FASTING` key) — the
 * fallback returns the verbatim resolved label, which is correct.
 *
 * Every other target type carries a stable English label from the
 * server. Look it up under `targets.label.<TYPE>` here so the card
 * title respects the user's locale.
 */
function translateTargetLabel(
  target: TargetData,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  const i18nKey = `targets.label.${target.type}`;
  const localised = t(i18nKey);
  if (localised && localised !== i18nKey) {
    return localised;
  }
  return target.label;
}

function getTargetSourceLink(target: TargetData): string | null {
  if (target.type === "WEIGHT" || target.type === "BMI") {
    return "https://www.who.int/news-room/fact-sheets/detail/obesity-and-overweight";
  }

  if (target.type === "BLOOD_PRESSURE") {
    return "https://academic.oup.com/eurheartj/article/39/33/3021/5079119";
  }
  if (target.type === "BLOOD_PRESSURE_IN_TARGET") {
    return "https://academic.oup.com/eurheartj/article/39/33/3021/5079119";
  }

  if (target.type === "PULSE") {
    if (target.source.includes("CDC/NCHS")) {
      return "https://www.cdc.gov/nchs/data/nhsr/nhsr041.pdf";
    }
    if (target.source.includes("AHA")) {
      return "https://www.heart.org/en/health-topics/high-blood-pressure/the-facts-about-high-blood-pressure/all-about-heart-rate-pulse";
    }
  }

  if (target.type === "SLEEP_DURATION") {
    return "https://aasm.org/seven-or-more-hours-of-sleep-per-night-a-health-necessity-for-adults/";
  }

  if (target.type === "BODY_FAT") {
    return "https://www.acefitness.org/resources/everyone/blog/6596/what-are-the-guidelines-for-percentage-of-body-fat-loss/";
  }

  if (target.type === "ACTIVITY_STEPS") {
    return "https://www.who.int/publications/i/item/9789240015128";
  }

  if (target.type === "MOOD_SCORE" || target.type === "MOOD_STABILITY") {
    return null;
  }

  return null;
}

function TrendIcon({ trend }: { trend: "up" | "down" | "stable" | null }) {
  if (trend === "up") {
    return <TrendingUp className="h-4 w-4 text-orange-400" />;
  }
  if (trend === "down") {
    return <TrendingDown className="h-4 w-4 text-cyan-400" />;
  }
  if (trend === "stable") {
    return <Minus className="h-4 w-4 text-green-400" />;
  }
  return null;
}

/**
 * A horizontal range bar with green/yellow/red zones showing where
 * the current value falls relative to a target range.
 */
function RangeBar({
  value,
  min,
  max,
  unit,
  orangeMin,
  orangeMax,
}: {
  value: number;
  min: number;
  max: number;
  unit: string;
  orangeMin?: number;
  orangeMax?: number;
}) {
  const { t } = useTranslations();

  const span = max - min;
  const defaultOrangeWidth = span * 0.3;
  const computedOrangeMin = min - defaultOrangeWidth;
  const computedOrangeMax = max + defaultOrangeWidth;
  const effectiveOrangeMin =
    orangeMin != null ? Math.min(orangeMin, min) : computedOrangeMin;
  const effectiveOrangeMax =
    orangeMax != null ? Math.max(orangeMax, max) : computedOrangeMax;

  const orangeSpan = Math.max(1, effectiveOrangeMax - effectiveOrangeMin);
  const sidePadding = Math.max(1, orangeSpan * 0.18);
  const visualMin = effectiveOrangeMin - sidePadding;
  const visualMax = effectiveOrangeMax + sidePadding;
  const visualSpan = visualMax - visualMin;
  const clampedValue = Math.max(visualMin, Math.min(visualMax, value));
  const rawPosition = ((clampedValue - visualMin) / visualSpan) * 100;
  const EDGE_PADDING_PERCENT = 4;
  const position = Math.max(
    EDGE_PADDING_PERCENT,
    Math.min(100 - EDGE_PADDING_PERCENT, rawPosition),
  );

  // Zone boundaries (percent of visual bar)
  const greenStart = Math.max(0, ((min - visualMin) / visualSpan) * 100);
  const greenEnd = Math.min(100, ((max - visualMin) / visualSpan) * 100);
  const yellowLeftStart = Math.max(
    0,
    ((effectiveOrangeMin - visualMin) / visualSpan) * 100,
  );
  const yellowRightEnd = Math.min(
    100,
    ((effectiveOrangeMax - visualMin) / visualSpan) * 100,
  );

  // Determine marker color
  const inGreen = value >= min && value <= max;
  const inYellow =
    !inGreen && value >= effectiveOrangeMin && value <= effectiveOrangeMax;

  const markerColor = inGreen
    ? "var(--dracula-green)"
    : inYellow
      ? "var(--dracula-orange)"
      : "var(--dracula-red)";
  const minLabelPosition = Math.max(5, Math.min(95, greenStart));
  const maxLabelPosition = Math.max(5, Math.min(95, greenEnd));

  // Delta to target range
  const delta = value < min ? min - value : value > max ? value - max : 0;
  const deltaText =
    delta > 0
      ? value < min
        ? t("targets.belowTarget", { delta: delta.toFixed(1), unit })
        : t("targets.aboveTarget", { delta: delta.toFixed(1), unit })
      : t("targets.inTarget");

  return (
    <div className="space-y-1.5">
      <div className="bg-muted/50 relative h-3 w-full overflow-hidden rounded-full">
        {/* Red background (full bar) */}
        <div className="absolute inset-0 rounded-full bg-red-500/8" />
        {/* Yellow zones */}
        <div
          className="absolute top-0 h-full bg-yellow-500/12"
          style={{
            left: `${yellowLeftStart}%`,
            width: `${greenStart - yellowLeftStart}%`,
          }}
        />
        <div
          className="absolute top-0 h-full bg-yellow-500/12"
          style={{
            left: `${greenEnd}%`,
            width: `${yellowRightEnd - greenEnd}%`,
          }}
        />
        {/* Green zone */}
        <div
          className="absolute top-0 h-full bg-green-500/20"
          style={{
            left: `${greenStart}%`,
            width: `${greenEnd - greenStart}%`,
          }}
        />
        {/* Current value marker with tooltip */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border-2 shadow-sm"
                style={{
                  left: `${position}%`,
                  backgroundColor: markerColor,
                  borderColor: markerColor,
                }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs font-medium">
                {t("targets.currentValue", { value: String(value), unit })}
              </p>
              <p className="text-xs">
                {t("targets.targetRangeValue", {
                  min: String(min),
                  max: String(max),
                  unit,
                })}
              </p>
              <p className="text-xs font-medium">{deltaText}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="text-muted-foreground relative h-4 text-xs">
        <span
          className="absolute -translate-x-1/2"
          style={{ left: `${minLabelPosition}%` }}
        >
          {min} {unit}
        </span>
        <span
          className="absolute -translate-x-1/2"
          style={{ left: `${maxLabelPosition}%` }}
        >
          {max} {unit}
        </span>
      </div>
    </div>
  );
}

function TargetCard({
  target,
  bpDiastolic,
}: {
  target: TargetData;
  bpDiastolic?: BpDiastolic;
}) {
  const { t } = useTranslations();

  const Icon = TYPE_ICONS[target.type] ?? Activity;
  const iconColor = TYPE_COLORS[target.type] ?? "text-primary";
  const isBp = target.type === "BLOOD_PRESSURE";
  const isMedicationCompliance = target.type === "MEDICATION_COMPLIANCE";
  const medicationBreakdown = target.details?.medications ?? [];
  const sourceLink = getTargetSourceLink(target);

  const localisedLabel = translateTargetLabel(target, t);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className={`h-4 w-4 ${iconColor}`} />
            <CardTitle className="text-sm font-medium">
              {localisedLabel}
            </CardTitle>
          </div>
          <TrendIcon trend={target.trend} />
        </div>
      </CardHeader>
      <CardContent className="flex h-full flex-col gap-4">
        {/* Current value */}
        {target.current != null ? (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2">
              {isBp && bpDiastolic?.current != null ? (
                <>
                  <span className="text-3xl font-bold">
                    {Math.round(target.current)}
                  </span>
                  <span className="text-muted-foreground text-lg">/</span>
                  <span className="text-2xl font-bold">
                    {Math.round(bpDiastolic.current)}
                  </span>
                </>
              ) : (
                <span className="text-3xl font-bold">
                  {target.type === "BODY_FAT"
                    ? target.current.toFixed(1)
                    : Math.round(target.current * 10) / 10}
                </span>
              )}
              <span className="text-muted-foreground text-sm">
                {target.unit}
              </span>
            </div>
            {target.average30 != null && (
              <p className="text-muted-foreground text-xs">
                {t("targets.average30d")}{" "}
                {isBp && bpDiastolic?.average30 != null
                  ? `${Math.round(target.average30)}/${Math.round(bpDiastolic.average30)}`
                  : Math.round(target.average30 * 10) / 10}{" "}
                {target.unit}
              </p>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm">{t("targets.noMeasurementYet")}</span>
          </div>
        )}

        {/* Range bar */}
        {target.range && target.current != null && (
          <RangeBar
            value={target.current}
            min={target.range.min}
            max={target.range.max}
            unit={target.unit}
            orangeMin={isMedicationCompliance ? 70 : undefined}
            orangeMax={isMedicationCompliance ? 100 : undefined}
          />
        )}

        {/* BP diastolic range bar */}
        {isBp && bpDiastolic?.range && bpDiastolic.current != null && (
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs">
              {t("targets.diastolic")}
            </p>
            <RangeBar
              value={bpDiastolic.current}
              min={bpDiastolic.range.min}
              max={bpDiastolic.range.max}
              unit="mmHg"
            />
          </div>
        )}

        {isMedicationCompliance && medicationBreakdown.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-xs">
              {t("targets.compliancePerMedication")}
            </p>
            <div className="space-y-1">
              {medicationBreakdown.map((medication) => (
                <div
                  key={medication.name}
                  className="text-muted-foreground flex items-center justify-between gap-2 text-xs"
                >
                  <span className="truncate">{medication.name}</span>
                  <span className="shrink-0">
                    {medication.compliance7.toFixed(1)}% (7T) ·{" "}
                    {medication.compliance30.toFixed(1)}% (30T)
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Classification + source */}
        <div className="mt-auto flex items-center justify-between gap-2">
          {target.classification ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    className="cursor-help"
                    style={{
                      backgroundColor: `${target.classification.color}20`,
                      color: target.classification.color,
                    }}
                  >
                    {translateStatus(target.classification.category, t)}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  {target.range && (
                    <p className="text-xs">
                      {t("targets.targetRangeValue", {
                        min: String(target.range.min),
                        max: String(target.range.max),
                        unit: target.unit,
                      })}
                    </p>
                  )}
                  <p className="text-xs">
                    {t("targets.sourceLabel", { source: target.source })}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <span className="invisible text-xs">placeholder</span>
          )}
          {target.type !== "MEDICATION_COMPLIANCE" ? (
            sourceLink ? (
              <a
                href={sourceLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
              >
                <span>{target.source}</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <span className="text-muted-foreground text-xs">
                {target.source}
              </span>
            )
          ) : (
            <span />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function TargetsPage() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["insights", "targets"],
    queryFn: async () => {
      const res = await fetch("/api/insights/targets");
      if (!res.ok) throw new Error(t("targets.loadError"));
      const json = await res.json();
      return json.data as TargetsResponse;
    },
    enabled: isAuthenticated,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-muted-foreground py-20 text-center">
        {t("common.noData")}
      </div>
    );
  }

  const profileIncomplete = !data.profile.heightCm || !data.profile.age;
  const displayGlucoseUnit = resolveGlucoseUnit(
    data.profile.glucoseUnit ?? null,
  );
  const visibleTargets = data.targets
    .filter((target) => target.current != null)
    .map((target) => {
      if (!GLUCOSE_TYPES.has(target.type)) return target;
      // Server label is an i18n key for glucose; resolve here.
      const label = t(target.label);
      // Convert mg/dL canonical values to the user's display unit.
      const convert = (v: number | null) =>
        v == null ? null : convertGlucose(v, displayGlucoseUnit);
      return {
        ...target,
        label,
        unit: displayGlucoseUnit,
        current: convert(target.current),
        average30: convert(target.average30),
        range: target.range
          ? {
              min: convertGlucose(target.range.min, displayGlucoseUnit),
              max: convertGlucose(target.range.max, displayGlucoseUnit),
            }
          : null,
      };
    });

  return (
    // v1.4.19 phase A7 — the maintainer reported "relativ viel Platz" wasted
    // between the overview header and the first values on `/targets`.
    // Tighten the rhythm from `space-y-8` (32 px) to `space-y-6`
    // (24 px) — that matches the admin / settings pages.
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("targets.title")}</h1>
        <p className="mt-2 text-sm">{t("targets.introText")}</p>
      </div>

      {/* Profile incomplete hint */}
      {profileIncomplete && (
        <Card className="border-l-4 border-l-orange-500">
          <CardContent className="flex gap-3 py-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
            <div>
              <p className="text-sm font-medium">
                {t("targets.profileIncomplete")}
              </p>
              <p className="text-muted-foreground text-sm">
                {!data.profile.heightCm && !data.profile.age
                  ? t("targets.profileIncompleteHeightAge")
                  : !data.profile.heightCm
                    ? t("targets.profileIncompleteHeight")
                    : t("targets.profileIncompleteAge")}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Target cards grid */}
      {visibleTargets.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {visibleTargets.map((target) => (
            <TargetCard
              key={target.type}
              target={target}
              bpDiastolic={
                target.type === "BLOOD_PRESSURE" ? data.bpDiastolic : undefined
              }
            />
          ))}
        </div>
      ) : (
        <div className="text-muted-foreground border-border rounded-xl border p-6 text-sm">
          {t("targets.noMeasurementData")}
        </div>
      )}
    </div>
  );
}
