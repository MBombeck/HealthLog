"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SlidersHorizontal, RotateCcw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmButton, ConfirmDialog } from "@/components/ui/confirm-button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { SettingsInfoTile } from "./_info-tile";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys, refetchInactiveDailyReads } from "@/lib/query-keys";
import {
  METRIC_BOUNDS,
  type ThresholdMetric,
  type EffectiveRange,
} from "@/lib/analytics/effective-range";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { resolveTargetUnitAdapter } from "@/lib/targets/target-unit-display";
import { SettingsCard } from "@/components/settings/settings-card";

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
      return apiGet<ThresholdsApiResponse>("/api/user/thresholds");
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (
      payload: Partial<Record<ThresholdMetric, { min: number; max: number }>>,
    ) => {
      const res = await apiFetchRaw("/api/user/thresholds", {
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
      // The dashboard bands + score context read the same thresholds through
      // the daily reads, which are unmounted on Settings — force the refetch.
      void refetchInactiveDailyReads(queryClient);
      toast.success(t("thresholds.saveSuccess"));
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t("thresholds.saveError"),
      ),
  });

  const resetMutation = useMutation({
    mutationFn: async (metric: ThresholdMetric | null) => {
      // `metric === null` is the reset-everything arm behind the confirm
      // dialog at the foot of the card. The server asks for the same decision
      // in the body, so the dialog's answer is what gets sent — the wide form
      // is not reachable by dropping the query parameter.
      const res = metric
        ? await apiFetchRaw(`/api/user/thresholds?metric=${metric}`, {
            method: "DELETE",
          })
        : await apiFetchRaw("/api/user/thresholds", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirm: "RESET_THRESHOLDS" }),
          });
      if (!res.ok) throw new Error("reset failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userThresholds() });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
      // Same daily-reads truth as the save arm above.
      void refetchInactiveDailyReads(queryClient);
      toast.success(t("thresholds.resetSuccess"));
    },
    onError: () => toast.error(t("thresholds.saveError")),
  });

  return (
    <SettingsCard id={id} className="scroll-mt-28">
      {/* The card carries a real title. It used to render a naked icon and
          a reset button, on the grounds that the page header already said
          the same thing — which left one card in the tree with no heading
          at all. The page subtitle is the one that goes. */}
      <SettingsCardHeader
        icon={SlidersHorizontal}
        title={t("thresholds.cardTitle")}
      />

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

      {data && Object.keys(data.overrides).length > 0 ? (
        <SettingsCardActions>
          <ConfirmButton
            slot="settings-thresholds-reset-all"
            variant="outline"
            size="sm"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            label={t("thresholds.resetAllAction")}
            title={t("thresholds.resetAllTitle")}
            body={t("thresholds.resetAllBody")}
            confirmLabel={t("thresholds.resetAllConfirm")}
            pending={resetMutation.isPending}
            onConfirm={() => resetMutation.mutate(null)}
          />
        </SettingsCardActions>
      ) : null}
    </SettingsCard>
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
  const { preference, glucoseUnit } = useUnitDisplay();
  const canonicalBounds = METRIC_BOUNDS[metric];

  // v1.32.27 — the row reads and writes in the user's preferred unit
  // while `User.thresholdsJson` stays canonical SI. Everything the row
  // receives (`override`, `effective.default`, `METRIC_BOUNDS`) is
  // canonical, so it converts on the way into the fields and inverts on
  // the way back out in `onSave`. Guardrails round inward so a value
  // typed at the displayed limit still passes the server's canonical
  // check. The glucose thresholds read in the reader's glucose unit the
  // same way. Metrics without a transform — and every metric on the default
  // preferences — take the adapter's identity path untouched.
  const units = resolveTargetUnitAdapter(
    metric,
    canonicalBounds.unit,
    preference,
    glucoseUnit,
  );
  const bounds = { ...units.bounds(canonicalBounds), unit: units.unit };

  /** Canonical seed → the string the field shows, falling back to the bound. */
  const seedString = (canonical: number | undefined, fallback: number) =>
    String(canonical == null ? fallback : units.toDisplay(canonical));

  const hasOverride = override !== null;
  const [overrideMode, setOverrideMode] = useState(hasOverride);
  const [confirmSwitchOff, setConfirmSwitchOff] = useState(false);
  const [minStr, setMinStr] = useState(
    seedString(override?.min ?? effective?.default?.greenMin, bounds.min),
  );
  const [maxStr, setMaxStr] = useState(
    seedString(override?.max ?? effective?.default?.greenMax, bounds.max),
  );

  // v1.30.1 M9 — the row is keyed on the stable `metric`, so a per-row
  // reset (or "reset all") that lands a NEW `override` (typically
  // `null`) never re-runs the `useState` initializers above: the
  // component instance survives the refetch. Pre-fix the switch and
  // min/max fields kept showing the stale override after the server
  // confirmed it was cleared, while the "Überschrieben" badge (driven
  // straight off the `hasOverride` prop, not state) vanished — a
  // contradictory row until a hard reload. Re-derive an identity string
  // from the override prop and resync local state during render
  // whenever it actually changes; typing in the fields never changes
  // `overrideIdentity`, so this never fights a live edit.
  const overrideIdentity = override
    ? `${override.min}:${override.max}`
    : "unset";
  const [syncedIdentity, setSyncedIdentity] = useState(overrideIdentity);
  if (overrideIdentity !== syncedIdentity) {
    setSyncedIdentity(overrideIdentity);
    setOverrideMode(hasOverride);
    setMinStr(
      seedString(override?.min ?? effective?.default?.greenMin, bounds.min),
    );
    setMaxStr(
      seedString(override?.max ?? effective?.default?.greenMax, bounds.max),
    );
  }

  const minNum = parseFloat(minStr);
  const maxNum = parseFloat(maxStr);
  const valid =
    Number.isFinite(minNum) &&
    Number.isFinite(maxNum) &&
    minNum >= bounds.min &&
    maxNum <= bounds.max &&
    minNum < maxNum;

  const defaultRange = effective?.default;
  // A bound reads at its own precision: "120–129 mmHg", "8,000–15,000 steps",
  // "61.3–82.5 kg". A fixed one decimal printed "120.0–129.0" and
  // "8,000.0–15,000.0" for metrics that are whole numbers by nature.
  const formatBound = (value: number) => {
    const rounded = Math.round(value * 10) / 10;
    return fmt.number(rounded, Number.isInteger(rounded) ? 0 : 1);
  };

  return (
    <div className="border-border space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t(METRIC_LABEL_KEYS[metric])}</p>
          <p className="text-muted-foreground text-xs">
            {defaultRange
              ? `${t("thresholds.defaultLabel")}: ${formatBound(units.toDisplay(defaultRange.greenMin))}–${formatBound(units.toDisplay(defaultRange.greenMax))} ${bounds.unit}`
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
          {/* Flipping this off DELETES the stored override — the same
              irreversible write the Reset control performs, reached by a
              control that reads as a display toggle. It gets the same
              confirmation, and a dismissal leaves the switch on. */}
          <Switch
            id={`override-${metric}`}
            checked={overrideMode}
            onCheckedChange={(next) => {
              if (!next && hasOverride) {
                setConfirmSwitchOff(true);
                return;
              }
              setOverrideMode(next);
            }}
            disabled={busy}
          />
          <ConfirmDialog
            slot={`settings-thresholds-override-off-${metric}`}
            open={confirmSwitchOff}
            onOpenChange={setConfirmSwitchOff}
            title={t("thresholds.resetTitle")}
            body={t("thresholds.resetBody")}
            confirmLabel={t("thresholds.resetConfirm")}
            pending={busy}
            onConfirm={() => {
              setOverrideMode(false);
              onReset();
            }}
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
                step={units.step}
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
                step={units.step}
                min={bounds.min}
                max={bounds.max}
                value={maxStr}
                onChange={(e) => setMaxStr(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button
                onClick={() =>
                  valid &&
                  onSave({
                    min: units.toCanonical(minNum),
                    max: units.toCanonical(maxNum),
                  })
                }
                disabled={busy || !valid}
                size="sm"
                className="min-h-11 sm:min-h-9"
              >
                {t("common.save")}
              </Button>
              {hasOverride && (
                <ConfirmButton
                  slot={`settings-thresholds-reset-${metric}`}
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  label={t("thresholds.resetAction")}
                  title={t("thresholds.resetTitle")}
                  body={t("thresholds.resetBody")}
                  confirmLabel={t("thresholds.resetConfirm")}
                  pending={busy}
                  onConfirm={onReset}
                />
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
              <SettingsInfoTile tone="warning" icon={AlertTriangle}>
                {t("thresholds.overrideWarning")}
              </SettingsInfoTile>
            )}
        </>
      )}
    </div>
  );
}
