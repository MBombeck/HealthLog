"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";

import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys, refetchInactiveDailyReads } from "@/lib/query-keys";
import {
  METRIC_BOUNDS,
  type ThresholdMetric,
  type EffectiveRange,
} from "@/lib/analytics/effective-range";
import { convertGlucose, toCanonicalMgdl } from "@/lib/glucose";
import { resolveTargetUnitAdapter } from "@/lib/targets/target-unit-display";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { apiDelete, apiGet, apiPut } from "@/lib/api/api-fetch";

/**
 * Per-metric target editor, mounted inline on the Insights metric
 * reference panel (`<MetricTargetSummary>`). The user adjusts the
 * min/max for the underlying threshold metric, hits Save, and every
 * surface that consumes `getEffectiveRange()` (dashboard bands,
 * doctor-report, the Insights panels themselves) updates on the next
 * query refetch.
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
  // BLOOD_GLUCOSE_UNSPECIFIED (#943) — deliberately absent. The untagged
  // bucket is judged against the RANDOM band; giving it its own editor row
  // would offer two controls that write one threshold, so the cog renders
  // disabled the same way it does for a derived card.
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
  // Only mount the body (and its TanStack Query hooks) when the dialog
  // is open. This keeps the parent reference panel test-friendly:
  // callers can render the panel without standing up a
  // QueryClientProvider, and the hooks only execute once the user
  // actually opens the editor.
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

  // Glucose is the one metric whose display unit can differ from the
  // canonical storage unit: HealthLog stores mg/dL, but a user on the
  // mmol/L preference sees — and types — mmol/L. The parent already
  // hands us `unit="mmol/L"` and a `initialRange` pre-converted to that
  // unit. We must therefore (a) seed the mg/dL persisted override into
  // the display unit, (b) validate the typed value against bounds
  // expressed in the display unit, and (c) convert the typed value back
  // to canonical mg/dL before the PUT — otherwise a `5.5 mmol/L` target
  // is rejected by the 40–400 mg/dL bounds or stored verbatim as 5.5.
  const isGlucoseMmol =
    metric != null && metric.startsWith("BLOOD_GLUCOSE") && unit === "mmol/L";

  // v1.32.27 — the same coupled treatment now covers the metric/imperial
  // preference. Weight-class thresholds are stored in kg; an imperial
  // user seeds, validates, and types in lb, and the adapter inverts the
  // typed number back to kg before the PUT. Glucose keeps its own
  // mg/dL ↔ mmol/L dialect (it carries no display transform, so the two
  // never compose); every other metric takes the adapter's identity
  // path and is numerically untouched.
  const { preference } = useUnitDisplay();
  const units = resolveTargetUnitAdapter(
    isBp ? "BLOOD_PRESSURE_SYS" : (metric ?? ""),
    unit,
    preference,
  );

  const toDisplay = (canonical: number) =>
    isGlucoseMmol
      ? convertGlucose(canonical, "mmol/L")
      : units.toDisplay(canonical);
  const toCanonical = (displayValue: number) =>
    isGlucoseMmol
      ? toCanonicalMgdl(displayValue, "mmol/L")
      : units.toCanonical(displayValue);
  // Guardrails the typed value is checked against, expressed in the
  // display unit. Glucose projects its mg/dL window through the same
  // conversion the fields use; every other metric rounds the window
  // INWARD so a value typed at the display bound never inverts to a
  // canonical value the server rejects.
  const toDisplayBounds = (canonical: { min: number; max: number }) =>
    isGlucoseMmol
      ? { min: toDisplay(canonical.min), max: toDisplay(canonical.max) }
      : units.bounds(canonical);

  // Lazy-load the thresholds payload so the dialog also catches any
  // already-persisted override even when the seeded `initialRange`
  // came from the targets API (which can paint a different in-band
  // tone vs. the persisted override). The body only mounts when the
  // dialog is open, so we don't need a separate `enabled` flag.
  const { data: thresholdsData } = useQuery({
    queryKey: queryKeys.userThresholds(),
    queryFn: async () => {
      return apiGet<ThresholdsApiResponse>("/api/user/thresholds");
    },
  });

  // Seed input strings from override → initialRange → default bound.
  // We use strings so the user can type a partial number (e.g. "12") without
  // the input snapping back to a parsed value.
  const seedRange = (
    m: ThresholdMetric | null,
    fallback: CurrentRange | null,
  ) => {
    // The persisted override is canonical (mg/dL for glucose); the
    // parent-provided `fallback` (initialRange) is already in the
    // display unit. Convert the override into the display unit so the
    // seeded inputs always read in the unit the label announces.
    if (m && thresholdsData?.overrides?.[m]) {
      const override = thresholdsData.overrides[m]!;
      return { min: toDisplay(override.min), max: toDisplay(override.max) };
    }
    if (fallback) return fallback;
    if (m) return toDisplayBounds(METRIC_BOUNDS[m]);
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
  // v1.16.4 — the body is a real form and the footer save button
  // associates via the `form` attribute (the footer renders in a
  // separate slot), so Enter in any numeric field saves.
  const formId = useId();
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
      await apiPut("/api/user/thresholds", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userThresholds() });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsTargets() });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
      // The dashboard bands + score context read the same thresholds through
      // the daily reads, which are unmounted here — force their refetch.
      void refetchInactiveDailyReads(queryClient);
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
          await apiDelete(`/api/user/thresholds?metric=${m}`);
        }
        return;
      }
      if (!metric) return;
      await apiDelete(`/api/user/thresholds?metric=${metric}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userThresholds() });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsTargets() });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
      // Same daily-reads truth as the save arm above.
      void refetchInactiveDailyReads(queryClient);
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

  const canonicalPrimaryBounds = isBp
    ? METRIC_BOUNDS.BLOOD_PRESSURE_SYS
    : metric
      ? METRIC_BOUNDS[metric]
      : null;
  const secondaryBounds = isBp ? METRIC_BOUNDS.BLOOD_PRESSURE_DIA : null;

  // Bounds the user is validated/clamped against — expressed in the
  // display unit so a mmol/L glucose entry is checked against the
  // mmol/L-projected 40–400 mg/dL window, not the raw mg/dL numbers.
  const primaryBounds = canonicalPrimaryBounds
    ? { ...toDisplayBounds(canonicalPrimaryBounds), unit }
    : null;

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

  // Per-field validity so the inputs can carry `aria-invalid` and the
  // disabled Save button gets a spoken explanation instead of greying out
  // silently. The order check (min < max) flags both ends of the pair.
  const primaryOrderInvalid =
    Number.isFinite(minNum) && Number.isFinite(maxNum) && minNum >= maxNum;
  const primaryMinInvalid =
    primaryBounds != null &&
    (!Number.isFinite(minNum) ||
      minNum < primaryBounds.min ||
      minNum > primaryBounds.max ||
      primaryOrderInvalid);
  const primaryMaxInvalid =
    primaryBounds != null &&
    (!Number.isFinite(maxNum) ||
      maxNum < primaryBounds.min ||
      maxNum > primaryBounds.max ||
      primaryOrderInvalid);

  const secondaryOrderInvalid =
    isBp &&
    Number.isFinite(diaMinNum) &&
    Number.isFinite(diaMaxNum) &&
    diaMinNum >= diaMaxNum;
  const secondaryMinInvalid =
    isBp &&
    secondaryBounds != null &&
    (!Number.isFinite(diaMinNum) ||
      diaMinNum < secondaryBounds.min ||
      diaMinNum > secondaryBounds.max ||
      secondaryOrderInvalid);
  const secondaryMaxInvalid =
    isBp &&
    secondaryBounds != null &&
    (!Number.isFinite(diaMaxNum) ||
      diaMaxNum < secondaryBounds.min ||
      diaMaxNum > secondaryBounds.max ||
      secondaryOrderInvalid);

  let validationMessage: string | null = null;
  if (!isDerivedMetric && primaryBounds && (!primaryValid || !secondaryValid)) {
    validationMessage =
      primaryOrderInvalid || secondaryOrderInvalid
        ? t("targets.edit.validationOrder")
        : t("targets.edit.validationBounds");
  }

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
    // Convert the typed display-unit value back to canonical mg/dL for
    // glucose on the mmol/L preference; a no-op for every other metric.
    updateMutation.mutate({
      [metric]: { min: toCanonical(minNum), max: toCanonical(maxNum) },
    });
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
            <ConfirmButton
              slot="target-edit-reset"
              variant="ghost"
              size="sm"
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              label={t("targets.edit.resetToDefault")}
              title={t("targets.edit.resetTitle")}
              body={
                isBp
                  ? t("targets.edit.resetBodyBp")
                  : t("targets.edit.resetBody")
              }
              confirmLabel={t("targets.edit.resetConfirm")}
              disabled={busy && !resetMutation.isPending}
              pending={resetMutation.isPending}
              onConfirm={() => resetMutation.mutate()}
            />
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
              type="submit"
              form={formId}
              size="sm"
              disabled={!canSave}
              data-slot="target-edit-save"
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      }
    >
      <form
        id={formId}
        data-slot="target-edit-sheet"
        data-target-type={targetType}
        aria-describedby={dialogContentId}
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
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
                  step={units.step}
                  min={primaryBounds.min}
                  max={primaryBounds.max}
                  value={displayMin}
                  onChange={(e) => setMinStr(e.target.value)}
                  disabled={busy}
                  aria-invalid={primaryMinInvalid}
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
                  step={units.step}
                  min={primaryBounds.min}
                  max={primaryBounds.max}
                  value={displayMax}
                  onChange={(e) => setMaxStr(e.target.value)}
                  disabled={busy}
                  aria-invalid={primaryMaxInvalid}
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
                    aria-invalid={secondaryMinInvalid}
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
                    aria-invalid={secondaryMaxInvalid}
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

            {validationMessage && (
              <p
                role="alert"
                data-slot="target-edit-validation"
                className="text-destructive text-xs"
              >
                {validationMessage}
              </p>
            )}
          </div>
        )}
      </form>
    </ResponsiveSheet>
  );
}
