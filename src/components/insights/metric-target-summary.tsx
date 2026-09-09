"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Target } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";
import { resolveTargetUnitAdapter } from "@/lib/targets/target-unit-display";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { RangeBar } from "@/components/targets/range-bar";
import { ConsistencyStrip } from "@/components/targets/consistency-strip";
import { TargetStatusPill } from "@/components/targets/target-status-pill";
import { TileHeader } from "@/components/insights/tile-header";
import { useTargetAdjust } from "@/lib/insights/target-adjust-context";
import { getTargetSourceLink } from "@/lib/targets/source-link";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * v1.8.0 → v1.8.5 — surface the per-metric target reference panel on each
 * insights category page, directly beneath the chart / assessment.
 *
 * The data is the `/api/insights/targets` payload, read through the
 * shared `queryKeys.insightsTargets()` cache so warm sessions pay
 * nothing and a cold sub-page warms the cache its siblings reuse. We
 * never recompute the ranges here: the route is the single source of
 * truth for the age-based ESH blood-pressure band, the WHO weight / BMI
 * band, the CDC/NCHS percentile pulse band, the AASM sleep band, the
 * ADA / DDG glucose bands, and the medication / mood targets.
 *
 * The panel is a compact reference panel carrying the full target
 * context:
 *
 *   • Row 1: target range string + `<TargetStatusPill>` + source link
 *            (the "what is the band / what is it based on" answer).
 *   • Row 2: `<RangeBar>` — where today's value sits inside the band
 *            (the spatial answer). BP renders the second diastolic bar.
 *   • Row 3: in-target share % + the 30-day average.
 *   • Row 4: `<ConsistencyStrip>` — the last seven days at a glance.
 *   • Footer: the guideline source link.
 *
 * The panel is a read surface: editing the target range moved to a gear
 * button in the page header (`<SubPageShell>`). Each panel registers its
 * editable target with the `TargetAdjustProvider` (see
 * `target-adjust-context.tsx`); the header gear opens the per-metric
 * `<TargetEditSheet>` the provider owns.
 *
 * Each insights slug maps to one target `type`, except blood glucose
 * which maps to up to four per-context cards (fasting / postprandial /
 * random / bedtime) — those carry mg/dL canonical values that we convert
 * to the user's display unit.
 */

interface TargetRange {
  min: number;
  max: number;
}

interface TargetClassification {
  category: string;
  color: string;
}

interface TargetItem {
  type: string;
  label: string;
  current: number | null;
  average30: number | null;
  unit: string;
  range: TargetRange | null;
  classification: TargetClassification | null;
  source: string;
  daysInRange7d: number;
  daysLogged7d: number;
  daysInRange30d: number;
  daysLogged30d: number;
  insufficientData: boolean;
  consistency7d: ReadonlyArray<"in" | "near" | "out" | null>;
}

interface TargetsResponse {
  targets: TargetItem[];
  bpDiastolic: {
    current: number | null;
    average30: number | null;
    range: TargetRange | null;
  };
  profile?: {
    glucoseUnit?: string | null;
  };
}

/**
 * Map each insights category slug to the target `type` the route emits.
 * Slugs without a numeric target (HRV, oxygen saturation, body
 * temperature, active energy, workouts, resting HR) are absent — the
 * component renders nothing for them, so the sub-page collapses cleanly.
 *
 * Blood glucose is the one slug that fans out to several target types:
 * the route emits one card per logged context, so the summary renders a
 * reference panel for each.
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

/** Glucose context target types, in the route's emission order. */
const GLUCOSE_TARGET_TYPES = [
  "BLOOD_GLUCOSE_FASTING",
  "BLOOD_GLUCOSE_POSTPRANDIAL",
  "BLOOD_GLUCOSE_RANDOM",
  "BLOOD_GLUCOSE_BEDTIME",
  // #943 — readings whose source recorded no meal-time context. The route
  // emits this card whenever such rows exist, so the panel must list it or
  // an account with only untagged readings gets no reference band at all.
  "BLOOD_GLUCOSE_UNSPECIFIED",
];

interface MetricTargetSummaryProps {
  /** Insights category slug, e.g. `"blood-pressure"`. */
  slug: string;
}

export function MetricTargetSummary({ slug }: MetricTargetSummaryProps) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const isGlucose = slug === "blood-glucose";
  const targetType = SLUG_TO_TARGET_TYPE[slug];

  const { data } = useQuery({
    queryKey: queryKeys.insightsTargets(),
    queryFn: async () => {
      return apiGet<TargetsResponse>("/api/insights/targets");
    },
    enabled: isAuthenticated && (targetType != null || isGlucose),
  });

  // No numeric target for this slug, or the payload hasn't resolved yet.
  if ((!targetType && !isGlucose) || !data) return null;

  // Glucose: one panel per logged context, converting the canonical
  // mg/dL values to the user's display unit. The route's per-context
  // labels are i18n keys, so resolve them.
  if (isGlucose) {
    const displayUnit = resolveGlucoseUnit(data.profile?.glucoseUnit ?? null);
    const convert = (v: number | null) =>
      v == null ? null : convertGlucose(v, displayUnit);
    const panels = GLUCOSE_TARGET_TYPES.map((type) =>
      data.targets.find((entry) => entry.type === type),
    )
      .filter(
        (entry): entry is TargetItem => entry != null && entry.range != null,
      )
      .map((entry) => ({
        ...entry,
        label: t(entry.label),
        unit: displayUnit,
        current: convert(entry.current),
        average30: convert(entry.average30),
        range: entry.range
          ? {
              min: convertGlucose(entry.range.min, displayUnit),
              max: convertGlucose(entry.range.max, displayUnit),
            }
          : null,
      }));

    if (panels.length === 0) return null;

    // Glucose fans out to up to four per-context panels. Each context
    // maps to its own editable threshold and registers with the
    // `TargetAdjustProvider`; the header gear opens the primary
    // (first-registered) context's editor.
    return (
      <div className="space-y-2" data-slot="metric-target-summary-group">
        {panels.map((panel) => (
          <TargetReferencePanel
            key={panel.type}
            target={panel}
            heading={panel.label}
          />
        ))}
      </div>
    );
  }

  const target = data.targets.find((entry) => entry.type === targetType);
  if (!target || !target.range) return null;

  return (
    <TargetReferencePanel
      target={target}
      bpDiastolic={
        targetType === "BLOOD_PRESSURE" ? data.bpDiastolic : undefined
      }
    />
  );
}

interface TargetReferencePanelProps {
  target: TargetItem;
  bpDiastolic?: TargetsResponse["bpDiastolic"];
  /** Optional sub-heading shown above the panel (used for glucose contexts). */
  heading?: string;
}

/**
 * One compact reference panel: range + status pill + source, a range
 * bar (plus a diastolic bar for BP), the in-target share + 30-day
 * average, the 7-day consistency strip, and the guideline source.
 * All fields come from the `/api/insights/targets` payload — nothing is
 * recomputed here.
 *
 * Editing the range is a header action: the panel registers its
 * editable target with the `TargetAdjustProvider` and the header gear
 * opens the per-metric `<TargetEditSheet>` (seeded with this metric's
 * type / unit / range, plus the diastolic range for BP). The sheet
 * writes `PUT /api/user/thresholds` and invalidates the
 * `insightsTargets()` cache on save, so the panel repaints in place.
 */
function TargetReferencePanel({
  target,
  bpDiastolic,
  heading,
}: TargetReferencePanelProps) {
  const { t } = useTranslations();
  const adjust = useTargetAdjust();
  const { preference } = useUnitDisplay();

  // v1.32.27 — the panel renders in the user's preferred unit. The
  // `/api/insights/targets` payload is canonical (kg for weight); the
  // adapter converts it once, here, and everything downstream — the
  // range bar, the status pill, the 30-day average, and the edit
  // sheet's seed — consumes the converted pair. Glucose contexts are
  // pre-converted by the caller above and carry no display transform,
  // so they take the adapter's identity path and are never scaled
  // twice. For a metric account the adapter is the exact identity, so
  // this panel is byte-identical to the previous release.
  const units = resolveTargetUnitAdapter(target.type, target.unit, preference);
  const unit = units.unit;
  const range = target.range
    ? {
        min: units.toDisplay(target.range.min),
        max: units.toDisplay(target.range.max),
      }
    : null;
  const currentValue =
    target.current == null ? null : units.toDisplay(target.current);
  const average30 =
    target.average30 == null ? null : units.toDisplay(target.average30);

  // Register this metric as the header gear's edit target. The effect
  // re-runs when the seeded range / unit / label changes (e.g. a glucose
  // unit-preference swap), keeping the sheet seed current, and the
  // cleanup unregisters when the panel unmounts so a metric without a
  // band never leaves a dead gear behind.
  const registerAdjust = adjust?.register;
  const adjustType = target.type;
  const adjustLabel = heading ?? target.label;
  const rangeMin = range?.min ?? null;
  const rangeMax = range?.max ?? null;
  const diaMin = bpDiastolic?.range?.min ?? null;
  const diaMax = bpDiastolic?.range?.max ?? null;
  useEffect(() => {
    if (!registerAdjust || rangeMin == null || rangeMax == null) return;
    return registerAdjust({
      type: adjustType,
      label: adjustLabel,
      unit,
      range: { min: rangeMin, max: rangeMax },
      diastolicRange:
        diaMin != null && diaMax != null ? { min: diaMin, max: diaMax } : null,
    });
  }, [
    registerAdjust,
    adjustType,
    adjustLabel,
    unit,
    rangeMin,
    rangeMax,
    diaMin,
    diaMax,
  ]);

  if (!range) return null;

  const isBp = target.type === "BLOOD_PRESSURE";
  const isMedicationCompliance = target.type === "MEDICATION_COMPLIANCE";

  const sourceLink = getTargetSourceLink(target);

  // v1.12.0 — the in-target share (% of logged days in band) and the
  // 30-day average moved UP to `<MetricPrimaryTile>`, the canonical home
  // for the headline + 30-day average + "Im Zielbereich" bar (the
  // no-duplicate-info rule). This panel stays the band reference: the
  // range string, the status pill, the positional range bar (where
  // today's value sits inside the band — distinct from the % bar), the
  // 7-day consistency strip, and the guideline source. Blood pressure is
  // the exception: it has no `<MetricPrimaryTile>` (this richer panel IS
  // its primary tile), so it keeps the stitched S/D 30-day average inline.
  let averageLabel: string | null = null;
  if (isBp && average30 != null) {
    const avgValue =
      bpDiastolic?.average30 != null
        ? `${Math.round(average30)}/${Math.round(bpDiastolic.average30)}`
        : String(Math.round(average30 * 10) / 10);
    averageLabel = `${t("targets.average30d")} ${avgValue} ${unit}`;
  }

  const showConsistency =
    !target.insufficientData &&
    target.consistency7d != null &&
    target.consistency7d.length > 0;

  return (
    // Card-wrapped at the compact density so the header-to-body offset
    // matches the assessment / read-strip / stat-strip tiles on the same
    // subpage spine. The body keeps its inter-row `space-y-3` inside
    // `CardContent`; every data-slot is preserved.
    <Card
      data-slot="metric-target-summary"
      data-target-type={target.type}
      className="gap-2 py-3 md:py-4"
    >
      {/* Row 1: the canonical tile header — a single-word "Ziel" / "Target"
          heading (the range numbers live on the range bar below, so the
          old "Target: 120–129 mmHg" string would just duplicate them) with
          the status pill pinned to the trailing edge. For glucose the
          per-context label (Fasting / Postprandial / …) carries real,
          non-duplicative info, so it stays as a sub-caption under the
          header. */}
      <CardHeader>
        <TileHeader
          icon={Target}
          title={t("insights.target.heading")}
          // L3 — top-level section on every metric sub-page, sibling of the
          // already-`h2` stat strip directly under the page `h1`.
          titleAs="h2"
          right={
            target.classification ? (
              <TargetStatusPill
                classification={target.classification}
                range={range}
                unit={unit}
                source={target.source}
              />
            ) : null
          }
        />
        {heading ? (
          <p className="text-muted-foreground text-xs font-medium tracking-[0.06em] uppercase">
            {heading}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Row 2: range bar — where today's value sits inside the band. */}
        {currentValue != null ? (
          <RangeBar
            value={currentValue}
            min={range.min}
            max={range.max}
            unit={unit}
            orangeMin={isMedicationCompliance ? 70 : undefined}
            orangeMax={isMedicationCompliance ? 100 : undefined}
          />
        ) : null}

        {/* Row 2b: diastolic range bar for blood pressure. */}
        {isBp && bpDiastolic?.range && bpDiastolic.current != null ? (
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
        ) : null}

        {/* Row 3: 30-day average (blood pressure only — every other metric
          surfaces its 30-day average in `<MetricPrimaryTile>` above the
          chart, so repeating it here would duplicate the figure). */}
        {averageLabel ? (
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
            <span>{averageLabel}</span>
          </div>
        ) : null}

        {/* Row 4: 7-day consistency strip. */}
        {showConsistency && target.consistency7d ? (
          <ConsistencyStrip
            days={target.consistency7d}
            daysInRange={target.daysInRange7d ?? 0}
            daysLogged={target.daysLogged7d ?? 0}
          />
        ) : null}

        {/* Footer: guideline source link. The adjust-target affordance
          moved to the header gear (see `TargetAdjustProvider`); this
          panel registers itself as that gear's edit target above. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5">
          {sourceLink ? (
            <a
              href={sourceLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
            >
              <span>{t("targets.sourceLabel", { source: target.source })}</span>
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          ) : (
            <span className="text-muted-foreground text-xs">
              {t("targets.sourceLabel", { source: target.source })}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
