"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";

import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import {
  METRIC_BOUNDS,
  type ThresholdMetric,
  type EffectiveRange,
} from "@/lib/analytics/effective-range";

/**
 * v1.4.25 W3f — per-card edit affordance for the Zielwerte cards.
 *
 * Marc directive 2026-05-14: the per-card cog pattern (Dashboard charts →
 * Insights sub-pages → now Zielwerte) must be consistent. After the W3e
 * redesign the target cards lost their edit entry point — this dialog
 * closes that gap. Tapping the cog top-right of any TargetCard opens
 * this sheet; the user adjusts the min/max for the underlying threshold
 * metric, hits Save, and every surface that consumes
 * `getEffectiveRange()` (dashboard bands, doctor-report, /targets
 * itself) updates on the next query refetch.
 *
 * Server contract: PUT /api/user/thresholds with a partial map
 * `{ [metric]: { min, max } }`. The endpoint validates the values
 * against `METRIC_BOUNDS` and persists them under
 * `User.thresholdsJson`. The cached query `["user", "thresholds"]` is
 * invalidated on success so the same dialog re-opens with the new
 * values.
 *
 * Visual contract: a small Dialog (not a Sheet drawer) so the
 * interaction reads as "I'm editing one specific metric, not a global
 * settings page". Mobile-first: full-width buttons under sm:, inline
 * row from sm: up.
 *
 * Mapping target-card type → ThresholdMetric:
 *   BLOOD_PRESSURE_IN_TARGET / BMI / MOOD_SCORE / MOOD_STABILITY /
 *   MEDICATION_COMPLIANCE / BLOOD_GLUCOSE_RANDOM
 *     → no editable threshold (the metric is a derived score). The
 *       cog still renders (consistency rule) but disables the Save
 *       button + shows an explanatory caption that this card derives
 *       from other metrics.
 *   BLOOD_PRESSURE
 *     → edits BOTH BLOOD_PRESSURE_SYS and BLOOD_PRESSURE_DIA in a
 *       single Save round-trip; the parent page receives the
 *       diastolic range from the targets API.
 *   Everything else maps 1:1 to the same enum literal.
 */

const TARGET_TYPE_TO_METRIC: Record<string, ThresholdMetric | null> = {
  WEIGHT: "WEIGHT",
  PULSE: "PULSE",
  SLEEP_DURATION: "SLEEP_DURATION",
  BODY_FAT: "BODY_FAT",
  ACTIVITY_STEPS: "ACTIVITY_STEPS",
  BLOOD_GLUCOSE_FASTING: "BLOOD_GLUCOSE_FASTING",
  BLOOD_GLUCOSE_POSTPRANDIAL: "BLOOD_GLUCOSE_POSTPRANDIAL",
  BLOOD_GLUCOSE_RANDOM: "BLOOD_GLUCOSE_RANDOM",
  BLOOD_GLUCOSE_BEDTIME: "BLOOD_GLUCOSE_BEDTIME",
  // BLOOD_PRESSURE handled specially with both sys + dia.
  // BMI / MOOD_SCORE / MOOD_STABILITY / MEDICATION_COMPLIANCE /
  // BLOOD_PRESSURE_IN_TARGET — derived, no editable threshold.
};

interface CurrentRange {
  min: number;
  max: number;
}

interface ThresholdsApiResponse {
  effective: Record<ThresholdMetric, EffectiveRange>;
  overrides: Partial<Record<ThresholdMetric, CurrentRange>>;
}

export interface TargetEditSheetProps {
  targetType: string;
  targetLabel: string;
  unit: string;
  /**
   * Current sys/dia ranges for BP. Threaded from the page; the dialog
   * uses them to seed BOTH inputs when target.type === BLOOD_PRESSURE.
   */
  initialRange: CurrentRange | null;
  initialDiastolicRange?: CurrentRange | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TargetEditSheet(props: TargetEditSheetProps) {
  // v1.4.25 W3f — only mount the body (and its TanStack Query hooks)
  // when the dialog is open. This keeps the parent <TargetCard>
  // test-friendly: existing tests can render the card without
  // standing up a QueryClientProvider, and the hooks only execute
  // once the user actually clicks the cog.
  //
  // v1.4.27 R4 RC2 — migrated raw <Dialog> → <ResponsiveSheet> so the
  // bottom-sheet branch sticky-pins reset + cancel + save above the
  // soft keyboard on phones. The lazy-mount toggle stays at this layer
  // so closed renders never instantiate the TanStack Query hooks.
  if (!props.open) return null;
  return <TargetEditSheetBody {...props} />;
}

function TargetEditSheetBody({
  targetType,
  targetLabel,
  unit,
  initialRange,
  initialDiastolicRange,
  onOpenChange,
}: TargetEditSheetProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const isBp = targetType === "BLOOD_PRESSURE";
  const metric = TARGET_TYPE_TO_METRIC[targetType] ?? null;
  const isDerivedMetric = !isBp && metric == null;

  // Lazy-load the thresholds payload so the dialog also catches any
  // already-persisted override even when the seeded `initialRange`
  // came from the targets API (which can paint a different in-band
  // tone vs. the persisted override). The body only mounts when the
  // dialog is open, so we don't need a separate `enabled` flag.
  const { data: thresholdsData } = useQuery({
    queryKey: ["user", "thresholds"],
    queryFn: async () => {
      const res = await fetch("/api/user/thresholds");
      if (!res.ok) throw new Error("failed");
      const json = await res.json();
      return json.data as ThresholdsApiResponse;
    },
  });

  // Seed input strings from override → initialRange → default bound.
  // We use strings so the user can type a partial number (e.g. "12") without
  // the input snapping back to a parsed value.
  const seedRange = (
    m: ThresholdMetric | null,
    fallback: CurrentRange | null,
  ) => {
    if (m && thresholdsData?.overrides?.[m]) {
      return thresholdsData.overrides[m]!;
    }
    if (fallback) return fallback;
    if (m) {
      const bounds = METRIC_BOUNDS[m];
      return { min: bounds.min, max: bounds.max };
    }
    return { min: 0, max: 100 };
  };

  const primary = seedRange(isBp ? "BLOOD_PRESSURE_SYS" : metric, initialRange);
  const secondary = isBp
    ? seedRange("BLOOD_PRESSURE_DIA", initialDiastolicRange ?? null)
    : null;

  // The body only mounts when open=true (see the wrapper above), so
  // the initial useState seed is already correct — no setState-inside-
  // useEffect dance needed. When `thresholdsData` arrives async, we
  // use it as the *displayed* fallback whenever the user hasn't typed
  // anything yet, via the `??` chain below.
  const [minStr, setMinStr] = useState<string | null>(null);
  const [maxStr, setMaxStr] = useState<string | null>(null);
  const [diaMinStr, setDiaMinStr] = useState<string | null>(null);
  const [diaMaxStr, setDiaMaxStr] = useState<string | null>(null);

  // Display values: user-edited string (if any) wins, otherwise we
  // surface the freshest seeded value derived from the
  // `thresholdsData` query + the parent-provided `initialRange`.
  const displayMin = minStr ?? String(primary.min);
  const displayMax = maxStr ?? String(primary.max);
  const displayDiaMin = diaMinStr ?? (secondary ? String(secondary.min) : "");
  const displayDiaMax = diaMaxStr ?? (secondary ? String(secondary.max) : "");

  // Focus management — the first input gets focus when the sheet
  // opens, matching the Dashboard chart cog's open-on-focus pattern.
  // v1.4.27 R4 RC2 — under the ResponsiveSheet primitive we no longer
  // hook Radix's `onOpenAutoFocus`; a mount effect lands focus on the
  // primary input as soon as the portal paints.
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const dialogContentId = useId();
  useEffect(() => {
    // Defer one frame so Radix has finished placing the portal before
    // we steal focus — otherwise the focus jumps to the close-X on
    // some browsers.
    const handle = window.requestAnimationFrame(() => {
      if (firstInputRef.current) {
        firstInputRef.current.focus();
        firstInputRef.current.select();
      }
    });
    return () => window.cancelAnimationFrame(handle);
  }, []);

  const updateMutation = useMutation({
    mutationFn: async (
      payload: Partial<Record<ThresholdMetric, CurrentRange>>,
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
      queryClient.invalidateQueries({ queryKey: ["insights", "targets"] });
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
      toast.success(t("targets.edit.saveSuccess"));
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t("targets.edit.saveError"),
      ),
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      if (isBp) {
        // Reset BOTH sys + dia.
        for (const m of ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"] as const) {
          const res = await fetch(`/api/user/thresholds?metric=${m}`, {
            method: "DELETE",
          });
          if (!res.ok) throw new Error("reset failed");
        }
        return;
      }
      if (!metric) return;
      const res = await fetch(`/api/user/thresholds?metric=${metric}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("reset failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user", "thresholds"] });
      queryClient.invalidateQueries({ queryKey: ["insights", "targets"] });
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
      toast.success(t("targets.edit.resetSuccess"));
      onOpenChange(false);
    },
    onError: () => toast.error(t("targets.edit.saveError")),
  });

  const busy = updateMutation.isPending || resetMutation.isPending;

  const minNum = parseFloat(displayMin);
  const maxNum = parseFloat(displayMax);
  const diaMinNum = parseFloat(displayDiaMin);
  const diaMaxNum = parseFloat(displayDiaMax);

  const primaryBounds = isBp
    ? METRIC_BOUNDS.BLOOD_PRESSURE_SYS
    : metric
      ? METRIC_BOUNDS[metric]
      : null;
  const secondaryBounds = isBp ? METRIC_BOUNDS.BLOOD_PRESSURE_DIA : null;

  const primaryValid =
    primaryBounds != null &&
    Number.isFinite(minNum) &&
    Number.isFinite(maxNum) &&
    minNum >= primaryBounds.min &&
    maxNum <= primaryBounds.max &&
    minNum < maxNum;

  const secondaryValid =
    !isBp ||
    (secondaryBounds != null &&
      Number.isFinite(diaMinNum) &&
      Number.isFinite(diaMaxNum) &&
      diaMinNum >= secondaryBounds.min &&
      diaMaxNum <= secondaryBounds.max &&
      diaMinNum < diaMaxNum);

  const canSave = !isDerivedMetric && primaryValid && secondaryValid && !busy;

  const handleSave = () => {
    if (!canSave) return;
    if (isBp) {
      updateMutation.mutate({
        BLOOD_PRESSURE_SYS: { min: minNum, max: maxNum },
        BLOOD_PRESSURE_DIA: { min: diaMinNum, max: diaMaxNum },
      });
      return;
    }
    if (!metric) return;
    updateMutation.mutate({ [metric]: { min: minNum, max: maxNum } });
  };

  const hasOverride = isBp
    ? Boolean(
        thresholdsData?.overrides?.BLOOD_PRESSURE_SYS ||
        thresholdsData?.overrides?.BLOOD_PRESSURE_DIA,
      )
    : metric
      ? Boolean(thresholdsData?.overrides?.[metric])
      : false;

  // v1.4.27 R4 RC2 — focus the first numeric input on mount instead of
  // relying on Radix's <Dialog>-specific onOpenAutoFocus. The body
  // only mounts once `open=true` (lazy mount above), so the effect
  // runs exactly when the surface comes into view.
  // Note: ResponsiveSheet does not currently expose onOpenAutoFocus —
  // we use a tiny mount effect to steal focus.
  return (
    <ResponsiveSheet
      open
      onOpenChange={onOpenChange}
      title={t("targets.edit.title", { metric: targetLabel })}
      description={
        isDerivedMetric
          ? t("targets.edit.derivedHint")
          : t("targets.edit.description", { unit })
      }
      className="sm:max-w-md"
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          {hasOverride ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => resetMutation.mutate()}
              disabled={busy}
              data-slot="target-edit-reset"
            >
              <RotateCcw className="mr-2 h-3.5 w-3.5" />
              {t("targets.edit.resetToDefault")}
            </Button>
          ) : (
            <span aria-hidden="true" />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!canSave}
              data-slot="target-edit-save"
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      }
    >
      <div
        data-slot="target-edit-sheet"
        data-target-type={targetType}
        aria-describedby={dialogContentId}
      >
        <p id={dialogContentId} className="sr-only">
          {isDerivedMetric
            ? t("targets.edit.derivedHint")
            : t("targets.edit.description", { unit })}
        </p>

        {!isDerivedMetric && primaryBounds && (
          <div className="space-y-4">
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            data-slot="target-edit-primary-row"
          >
            <div className="space-y-1">
              <Label htmlFor="target-edit-min" className="text-xs">
                {isBp
                  ? t("targets.edit.systolicMin")
                  : t("targets.edit.minLabel")}
              </Label>
              <Input
                id="target-edit-min"
                ref={firstInputRef}
                type="number"
                step={targetType === "ACTIVITY_STEPS" ? 100 : 0.1}
                min={primaryBounds.min}
                max={primaryBounds.max}
                value={displayMin}
                onChange={(e) => setMinStr(e.target.value)}
                disabled={busy}
                data-slot="target-edit-min-input"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="target-edit-max" className="text-xs">
                {isBp
                  ? t("targets.edit.systolicMax")
                  : t("targets.edit.maxLabel")}
              </Label>
              <Input
                id="target-edit-max"
                type="number"
                step={targetType === "ACTIVITY_STEPS" ? 100 : 0.1}
                min={primaryBounds.min}
                max={primaryBounds.max}
                value={displayMax}
                onChange={(e) => setMaxStr(e.target.value)}
                disabled={busy}
                data-slot="target-edit-max-input"
              />
            </div>
          </div>

          {isBp && secondaryBounds && (
            <div
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              data-slot="target-edit-secondary-row"
            >
              <div className="space-y-1">
                <Label htmlFor="target-edit-dia-min" className="text-xs">
                  {t("targets.edit.diastolicMin")}
                </Label>
                <Input
                  id="target-edit-dia-min"
                  type="number"
                  step={0.1}
                  min={secondaryBounds.min}
                  max={secondaryBounds.max}
                  value={displayDiaMin}
                  onChange={(e) => setDiaMinStr(e.target.value)}
                  disabled={busy}
                  data-slot="target-edit-dia-min-input"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="target-edit-dia-max" className="text-xs">
                  {t("targets.edit.diastolicMax")}
                </Label>
                <Input
                  id="target-edit-dia-max"
                  type="number"
                  step={0.1}
                  min={secondaryBounds.min}
                  max={secondaryBounds.max}
                  value={displayDiaMax}
                  onChange={(e) => setDiaMaxStr(e.target.value)}
                  disabled={busy}
                  data-slot="target-edit-dia-max-input"
                />
              </div>
            </div>
          )}

            <p className="text-muted-foreground text-xs">
              {t("targets.edit.boundsHint", {
                min: String(primaryBounds.min),
                max: String(primaryBounds.max),
                unit: primaryBounds.unit,
              })}
            </p>
          </div>
        )}
      </div>
    </ResponsiveSheet>
  );
}
