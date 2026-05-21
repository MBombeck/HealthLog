"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SlidersHorizontal, RotateCcw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  METRIC_BOUNDS,
  type ThresholdMetric,
  type EffectiveRange,
} from "@/lib/analytics/effective-range";

interface ThresholdsApiResponse {
  effective: Record<ThresholdMetric, EffectiveRange>;
  overrides: Partial<Record<ThresholdMetric, { min: number; max: number }>>;
}

const METRIC_ORDER: ThresholdMetric[] = [
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "TOTAL_BODY_WATER",
  "BONE_MASS",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "BLOOD_GLUCOSE_FASTING",
  "BLOOD_GLUCOSE_POSTPRANDIAL",
  "BLOOD_GLUCOSE_RANDOM",
  "BLOOD_GLUCOSE_BEDTIME",
  "OXYGEN_SATURATION",
];

const METRIC_LABEL_KEYS: Record<ThresholdMetric, string> = {
  WEIGHT: "thresholds.metricWeight",
  BLOOD_PRESSURE_SYS: "thresholds.metricBpSys",
  BLOOD_PRESSURE_DIA: "thresholds.metricBpDia",
  PULSE: "thresholds.metricPulse",
  BODY_FAT: "thresholds.metricBodyFat",
  SLEEP_DURATION: "thresholds.metricSleep",
  ACTIVITY_STEPS: "thresholds.metricSteps",
  BLOOD_GLUCOSE_FASTING: "thresholds.metricGlucoseFasting",
  BLOOD_GLUCOSE_POSTPRANDIAL: "thresholds.metricGlucosePostprandial",
  BLOOD_GLUCOSE_RANDOM: "thresholds.metricGlucoseRandom",
  BLOOD_GLUCOSE_BEDTIME: "thresholds.metricGlucoseBedtime",
  TOTAL_BODY_WATER: "thresholds.metricBodyWater",
  BONE_MASS: "thresholds.metricBoneMass",
  OXYGEN_SATURATION: "thresholds.metricOxygenSaturation",
};

export function ThresholdsEditorSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.userThresholds(),
    queryFn: async () => {
      const res = await fetch("/api/user/thresholds");
      if (!res.ok) throw new Error("failed");
      const json = await res.json();
      return json.data as ThresholdsApiResponse;
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (
      payload: Partial<Record<ThresholdMetric, { min: number; max: number }>>,
    ) => {
      const res = await fetch("/api/user/thresholds", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error ?? "save failed");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userThresholds() });
      // Every chart/band depends on these thresholds — invalidate everything.
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
      toast.success(t("thresholds.saveSuccess"));
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t("thresholds.saveError"),
      ),
  });

  const resetMutation = useMutation({
    mutationFn: async (metric: ThresholdMetric | null) => {
      const url = metric
        ? `/api/user/thresholds?metric=${metric}`
        : "/api/user/thresholds";
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) throw new Error("reset failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userThresholds() });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
      toast.success(t("thresholds.resetSuccess"));
    },
    onError: () => toast.error(t("thresholds.saveError")),
  });

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 space-y-4 rounded-xl border p-6"
    >
      {/* v1.4.19 A8 / F-07: page header `settings.sections.thresholds.*`
          already provides the title + description for this route, so the
          card-level title + subtitle were a duplicate of the page header.
          Keep the icon + reset action so the card still has a visible
          control affordance. */}
      <div className="flex items-center justify-between">
        <SlidersHorizontal
          className="text-primary h-5 w-5"
          aria-hidden="true"
        />
        {data && Object.keys(data.overrides).length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => resetMutation.mutate(null)}
            disabled={resetMutation.isPending}
          >
            <RotateCcw className="mr-2 h-3.5 w-3.5" />
            {t("thresholds.resetAllAction")}
          </Button>
        )}
      </div>

      {isLoading || !data ? (
        <ThresholdsSkeletonList />
      ) : (
        <div className="space-y-3">
          {METRIC_ORDER.map((metric) => (
            <MetricRow
              key={metric}
              metric={metric}
              effective={data.effective[metric]}
              override={data.overrides[metric] ?? null}
              onSave={(range) => updateMutation.mutate({ [metric]: range })}
              onReset={() => resetMutation.mutate(metric)}
              busy={updateMutation.isPending || resetMutation.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Skeleton placeholder rendered while `/api/user/thresholds` is in
 * flight. Reserves one row per `METRIC_ORDER` entry at roughly the
 * loaded height so the page does not jump when the fetched list
 * swaps in. The pulsing animation honours `prefers-reduced-motion`
 * via Tailwind's `motion-reduce:animate-none`.
 */
function ThresholdsSkeletonList() {
  return (
    <div
      className="space-y-3"
      data-testid="thresholds-skeleton"
      aria-hidden="true"
    >
      {METRIC_ORDER.map((metric) => (
        <div
          key={metric}
          className="border-border space-y-3 rounded-lg border p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface MetricRowProps {
  metric: ThresholdMetric;
  effective: EffectiveRange | undefined;
  override: { min: number; max: number } | null;
  onSave: (range: { min: number; max: number }) => void;
  onReset: () => void;
  busy: boolean;
}

function MetricRow({
  metric,
  effective,
  override,
  onSave,
  onReset,
  busy,
}: MetricRowProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const bounds = METRIC_BOUNDS[metric];
  const hasOverride = override !== null;
  const [overrideMode, setOverrideMode] = useState(hasOverride);
  const [minStr, setMinStr] = useState(
    String(override?.min ?? effective?.default?.greenMin ?? bounds.min),
  );
  const [maxStr, setMaxStr] = useState(
    String(override?.max ?? effective?.default?.greenMax ?? bounds.max),
  );

  const minNum = parseFloat(minStr);
  const maxNum = parseFloat(maxStr);
  const valid =
    Number.isFinite(minNum) &&
    Number.isFinite(maxNum) &&
    minNum >= bounds.min &&
    maxNum <= bounds.max &&
    minNum < maxNum;

  const defaultRange = effective?.default;

  return (
    <div className="border-border space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t(METRIC_LABEL_KEYS[metric])}</p>
          <p className="text-muted-foreground text-xs">
            {defaultRange
              ? `${t("thresholds.defaultLabel")}: ${fmt.number(defaultRange.greenMin, 1)}–${fmt.number(defaultRange.greenMax, 1)} ${bounds.unit}`
              : t("thresholds.unsetExplanation")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* v1.4.33 F17 — the switch label used to flip between
              "Auto" and "Überschrieben" with the current state. The
              maintainer's audit caught that as confusing: a user
              looking at a row with "Auto" + the toggle off reads it
              as "Auto is off, why are there no inputs?" instead of
              "flip the switch to enter a custom range". Anchor the
              label on the *action* ("Eigene Werte" / "Custom range")
              so the affordance is unambiguous; the
              `thresholds.sourceOverride` badge to the right still
              announces when the override is active. */}
          <Label htmlFor={`override-${metric}`} className="text-xs">
            {t("thresholds.overrideToggleLabel")}
          </Label>
          <Switch
            id={`override-${metric}`}
            checked={overrideMode}
            onCheckedChange={(next) => {
              setOverrideMode(next);
              if (!next && hasOverride) onReset();
            }}
            disabled={busy}
          />
          {hasOverride && (
            <Badge variant="outline" className="text-xs">
              {t("thresholds.sourceOverride")}
            </Badge>
          )}
        </div>
      </div>
      {overrideMode && (
        <>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <div className="space-y-1">
              <Label htmlFor={`min-${metric}`} className="text-xs">
                {t("thresholds.minLabel")}{" "}
                {t("thresholds.unitSuffix", { unit: bounds.unit })}
              </Label>
              <Input
                id={`min-${metric}`}
                type="number"
                inputMode={metric === "ACTIVITY_STEPS" ? "numeric" : "decimal"}
                enterKeyHint="next"
                step={metric === "ACTIVITY_STEPS" ? 100 : 0.1}
                min={bounds.min}
                max={bounds.max}
                value={minStr}
                onChange={(e) => setMinStr(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`max-${metric}`} className="text-xs">
                {t("thresholds.maxLabel")}{" "}
                {t("thresholds.unitSuffix", { unit: bounds.unit })}
              </Label>
              <Input
                id={`max-${metric}`}
                type="number"
                inputMode={metric === "ACTIVITY_STEPS" ? "numeric" : "decimal"}
                enterKeyHint="done"
                step={metric === "ACTIVITY_STEPS" ? 100 : 0.1}
                min={bounds.min}
                max={bounds.max}
                value={maxStr}
                onChange={(e) => setMaxStr(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button
                onClick={() => valid && onSave({ min: minNum, max: maxNum })}
                disabled={busy || !valid}
                size="sm"
              >
                {t("common.save")}
              </Button>
              {hasOverride && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onReset}
                  disabled={busy}
                >
                  {t("thresholds.resetAction")}
                </Button>
              )}
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            {t("thresholds.outOfBoundsHint", {
              min: bounds.min,
              max: bounds.max,
              unit: bounds.unit,
            })}
          </p>
          {hasOverride &&
            defaultRange &&
            (override!.min < defaultRange.greenMin * 0.7 ||
              override!.max > defaultRange.greenMax * 1.3) && (
              <div className="border-dracula-orange/50 bg-dracula-orange/5 flex items-start gap-2 rounded-md border-l-2 p-2 text-xs">
                <AlertTriangle className="text-dracula-orange mt-0.5 h-3 w-3 shrink-0" />
                <span>{t("thresholds.overrideWarning")}</span>
              </div>
            )}
        </>
      )}
    </div>
  );
}
