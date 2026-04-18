"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SlidersHorizontal, RotateCcw, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
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
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "BLOOD_GLUCOSE_FASTING",
  "BLOOD_GLUCOSE_POSTPRANDIAL",
  "BLOOD_GLUCOSE_RANDOM",
  "BLOOD_GLUCOSE_BEDTIME",
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
};

export function ThresholdsSection({ id }: { id: string }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["user", "thresholds"],
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
      queryClient.invalidateQueries({ queryKey: ["user", "thresholds"] });
      // Every chart/band depends on these thresholds — invalidate everything.
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
      toast.success(t("thresholds.saveSuccess"));
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : t("thresholds.saveError")),
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
      queryClient.invalidateQueries({ queryKey: ["user", "thresholds"] });
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
      toast.success(t("thresholds.resetSuccess"));
    },
    onError: () => toast.error(t("thresholds.saveError")),
  });

  return (
    <div
      id={id}
      className="bg-card border-border scroll-mt-28 rounded-xl border p-6 space-y-5"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("thresholds.title")}</h2>
        </div>
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
      <p className="text-muted-foreground text-sm">
        {t("thresholds.subtitle")}
      </p>

      {isLoading || !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("common.loading")}
        </div>
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
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t(METRIC_LABEL_KEYS[metric])}</p>
          <p className="text-muted-foreground text-xs">
            {defaultRange
              ? `${t("thresholds.defaultLabel")}: ${fmt.number(defaultRange.greenMin, 1)}–${fmt.number(defaultRange.greenMax, 1)} ${bounds.unit}`
              : t("thresholds.unsetExplanation")}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Label htmlFor={`override-${metric}`} className="text-xs">
            {overrideMode
              ? t("thresholds.overrideModeLabel")
              : t("thresholds.autoModeLabel")}
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
              <div className="flex items-start gap-2 rounded-md border-l-2 border-dracula-orange/50 bg-dracula-orange/5 p-2 text-xs">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-dracula-orange" />
                <span>{t("thresholds.overrideWarning")}</span>
              </div>
            )}
        </>
      )}
    </div>
  );
}
