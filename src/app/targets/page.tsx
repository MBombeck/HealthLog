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

interface TargetsResponse {
  targets: TargetData[];
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

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className={`h-4 w-4 ${iconColor}`} />
            <CardTitle className="text-sm font-medium">
              {target.label}
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
                    {target.classification.category}
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
    <div className="space-y-8">
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
