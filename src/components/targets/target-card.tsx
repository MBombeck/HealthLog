"use client";

import { useState } from "react";
import {
  AlertCircle,
  Activity,
  Droplet,
  ExternalLink,
  Heart,
  Minus,
  Moon,
  Percent,
  Scale,
  Settings2,
  Smile,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { moodStabilityLabel } from "@/lib/targets/mood-stability-label";
import { ConsistencyStrip } from "./consistency-strip";
import { RangeBar } from "./range-bar";
import { TargetCoachButton } from "./target-coach-button";
import { TargetEditSheet } from "./target-edit-sheet";
import { buildTargetPrompt } from "@/lib/ai/coach/target-prompts";
import { coachScopeForTarget } from "@/lib/ai/coach/target-scope";
import type { CoachScope } from "@/lib/ai/coach/types";

/**
 * v1.4.25 W3e — `<TargetCard>` extracted from `src/app/targets/page.tsx`
 * with a Marc-directive redesign. Visual rationale:
 *
 *  • Headline row pairs the metric label with a verbal status pill —
 *    Q1 ("am I on track right now?") answered before the user's eye
 *    moves below the title.
 *  • Big value with the unit small + muted; the inline trend chevron
 *    sits next to the value, not in a separate row.
 *  • Range bar carries the precise placement; the bar is the
 *    "spatial" answer to Q2 (delta to goal).
 *  • Consistency strip beneath the bar answers Q7 ("how consistent
 *    am I?"). Hidden when `insufficientData` is true so cold-start
 *    accounts don't see a dead-grey row.
 *  • Recency caption ("last met goal: 2 days ago") + streak chip
 *    when ≥ 3 days. Both are conditional on real data — no empty
 *    placeholders.
 *  • Footer row: per-card Coach CTA on the left (only when the user
 *    has an AI provider configured), guideline-source link on the
 *    right.
 *
 * Per Marc's "muss nicht so sein wie die KI Sache": the card stays
 * quiet. No gradients, no chips with emoji, no animation. Editorial
 * spacing rhythm; one decisive number and one decisive status pill.
 */

const TYPE_ICONS: Record<string, LucideIcon> = {
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

const STATUS_CATEGORY_KEY: Record<string, string> = {
  Underweight: "underweight",
  Normal: "normal",
  Overweight: "overweight",
  "Obesity Grade I": "obesityGrade1",
  "Obesity Grade II": "obesityGrade2",
  "Obesity Grade III": "obesityGrade3",
  Optimal: "optimal",
  "High-normal": "highNormal",
  "Hypertension Grade 1": "hypertensionGrade1",
  "Hypertension Grade 2": "hypertensionGrade2",
  "Hypertension Grade 3": "hypertensionGrade3",
  Bradycardia: "bradycardia",
  Elevated: "elevated",
  Tachycardia: "tachycardia",
  "Significantly low": "significantlyLow",
  "Slightly low": "slightlyLow",
  "On target": "onTarget",
  "Slightly elevated": "slightlyElevated",
  "Significantly elevated": "significantlyElevated",
  "Far too short": "farTooShort",
  "Too short": "tooShort",
  "Slightly long": "slightlyLong",
  "Far too long": "farTooLong",
  "Below essential": "belowEssential",
  Essential: "essential",
  Athletic: "athletic",
  Fitness: "fitness",
  Acceptable: "acceptable",
  Obese: "obese",
  "Very low": "veryLow",
  "Low active": "lowActive",
  "Moderately active": "moderatelyActive",
  Active: "active",
  "Very active": "veryActive",
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
  if (!key) return category;
  return t(`targets.status.${key}`);
}

/**
 * Map an in-band classification category to one of three semantic
 * groups. Used to drive the status-pill style without re-classifying
 * the value from scratch; the server's category is canonical.
 *
 * "in" = inside the green band ("On target", "Normal", "Optimal", …).
 * "near" = inside the orange band ("Slightly elevated", "Overweight",
 *   …) or a step inside an obesity / hypertension grade-1 band.
 * "out" = outside all bands ("Hypertension Grade 3", "Obesity Grade
 *   III", "Tachycardia" away from the target band, …).
 *
 * When the category is unmapped we fall back to "near" — the safe
 * middle, which paints the pill in the neutral amber tone rather than
 * lighting up a false-positive green/red.
 */
function statusGroupForCategory(category: string): "in" | "near" | "out" {
  const greenCategories = new Set([
    "Normal",
    "Optimal",
    "On target",
    "Good",
    "Very good",
    "Very stable",
    "Stable",
    "Athletic",
    "Fitness",
    "Acceptable",
    "Active",
    "Very active",
    "Moderately active",
    "Essential",
  ]);
  const redCategories = new Set([
    "Obesity Grade III",
    "Hypertension Grade 3",
    "Significantly elevated",
    "Significantly low",
    "Far too short",
    "Far too long",
    "Tachycardia",
    "Bradycardia",
    "Low",
    "High",
    "Fluctuating",
    "Below essential",
    "Very low",
  ]);
  if (greenCategories.has(category)) return "in";
  if (redCategories.has(category)) return "out";
  return "near";
}

// Use the Tailwind v4 parenthesised CSS-variable shorthand
// (bg-VAR-PAREN-FORM-/N) instead of the legacy bracketed VAR-form. The
// bracketed form combined with an opacity modifier emits an escaped
// class selector that Turbopack's CSS parser rejects with
// "Unexpected token Delim('.')" because the scanner picks the literal
// string out of source files (including this comment) and emits a CSS
// rule for it. The parenthesised shorthand produces a clean selector
// that parses cleanly. See the Tailwind v4 upgrade guide for the
// migration from bracket-form to paren-form for CSS-variable values.
const STATUS_PILL_STYLES: Record<"in" | "near" | "out", string> = {
  in: "bg-(--dracula-green)/12 text-(--dracula-green) ring-(--dracula-green)/30",
  near: "bg-(--dracula-orange)/14 text-(--dracula-orange) ring-(--dracula-orange)/30",
  out: "bg-(--dracula-red)/12 text-(--dracula-red) ring-(--dracula-red)/30",
};

interface TargetClassification {
  category: string;
  color: string;
}

interface BpDiastolic {
  current: number | null;
  average30: number | null;
  range: { min: number; max: number } | null;
}

export interface TargetCardData {
  type: string;
  label: string;
  current: number | null;
  average30: number | null;
  trend: "up" | "down" | "stable" | null;
  unit: string;
  range: { min: number; max: number } | null;
  classification: TargetClassification | null;
  source: string;
  daysInRange7d?: number;
  daysLogged7d?: number;
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

export interface TargetCardProps {
  target: TargetCardData;
  bpDiastolic?: BpDiastolic;
  /**
   * AI gate. When false, the per-card Coach CTA is suppressed entirely
   * (no greyed-out button, no tooltip placeholder). The parent reads
   * `/api/insights/provider-chain` and threads this flag.
   */
  aiEnabled: boolean;
  /**
   * Drawer handoff. Receives the pre-formatted prefill + the
   * narrowed scope (single source for 1:1 metrics, derived source
   * for BMI / mood stability, all sources for the rest).
   */
  onAskCoach: (payload: { prefill: string; scope: CoachScope }) => void;
  /**
   * Optional source URL for the guideline link. Threaded from the
   * page rather than computed in the card so the resolution stays
   * declarative + testable.
   */
  sourceLink?: string | null;
}

function TrendIcon({ trend }: { trend: "up" | "down" | "stable" | null }) {
  if (trend === "up") {
    return (
      <TrendingUp
        className="text-dracula-orange size-4"
        aria-hidden="true"
        data-slot="target-trend-icon"
        data-trend="up"
      />
    );
  }
  if (trend === "down") {
    return (
      <TrendingDown
        className="text-dracula-cyan size-4"
        aria-hidden="true"
        data-slot="target-trend-icon"
        data-trend="down"
      />
    );
  }
  if (trend === "stable") {
    return (
      <Minus
        className="text-dracula-green size-4"
        aria-hidden="true"
        data-slot="target-trend-icon"
        data-trend="stable"
      />
    );
  }
  return null;
}

function formatRelativeDay(
  isoDate: string,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  // `isoDate` is a Berlin-tz day key (YYYY-MM-DD). Compare to today's
  // Berlin-tz day by parsing both as local Date midnight; we only need
  // a day-resolution delta so timezone math is unnecessary.
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (isoDate === todayKey) return t("targets.relativeDay.today");
  const [y, m, d] = isoDate.split("-").map(Number);
  const target = new Date(y, (m ?? 1) - 1, d ?? 1);
  const todayMid = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const diffDays = Math.round(
    (todayMid.getTime() - target.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diffDays === 1) return t("targets.relativeDay.yesterday");
  if (diffDays < 0) return t("targets.relativeDay.today"); // future, shouldn't happen
  return t("targets.relativeDay.daysAgo", { count: String(diffDays) });
}

export function TargetCard({
  target,
  bpDiastolic,
  aiEnabled,
  onAskCoach,
  sourceLink,
}: TargetCardProps) {
  const { t, locale } = useTranslations();

  // v1.4.25 W3f — per-card edit affordance. Cog top-right of every
  // card opens the edit dialog; the dialog handles the read-only path
  // for derived metrics (BMI, MOOD_*, MEDICATION_COMPLIANCE,
  // BLOOD_PRESSURE_IN_TARGET) by showing an explanatory caption.
  const [editOpen, setEditOpen] = useState(false);

  const Icon = TYPE_ICONS[target.type] ?? Activity;
  const iconColor = TYPE_COLORS[target.type] ?? "text-primary";
  const isBp = target.type === "BLOOD_PRESSURE";
  const isMedicationCompliance = target.type === "MEDICATION_COMPLIANCE";
  const medicationBreakdown = target.details?.medications ?? [];

  const localisedLabel = t(`targets.label.${target.type}`);
  const titleLabel =
    localisedLabel === `targets.label.${target.type}`
      ? target.label
      : localisedLabel;

  const statusGroup = target.classification
    ? statusGroupForCategory(target.classification.category)
    : "near";
  const statusPillStyle = STATUS_PILL_STYLES[statusGroup];
  const statusLabel = target.classification
    ? translateStatus(target.classification.category, t)
    : null;

  // MOOD_STABILITY headline switches from numeric σ to a verbal label.
  // The numeric stays as a tooltip behind the pill so power users can
  // still see the σ value.
  const moodStabilityValue =
    target.type === "MOOD_STABILITY" && target.current != null
      ? moodStabilityLabel(target.current)
      : null;
  const moodStabilityCopy =
    moodStabilityValue != null
      ? t(`targets.mood.stability.${moodStabilityValue}`)
      : null;

  const showConsistency =
    !target.insufficientData &&
    target.consistency7d != null &&
    target.consistency7d.length > 0;

  const showLastMet = target.lastMetGoalAt != null && !target.insufficientData;

  const showStreak =
    target.streakDays != null &&
    target.streakDays >= 3 &&
    !target.insufficientData;

  // Coach prefill is built from the live state of the card; the helper
  // file owns the per-metric template + locale resolution.
  const coachPrefill = buildTargetPrompt({
    type: target.type,
    locale,
    current: target.current,
    range: target.range,
    unit: target.unit,
    status: statusLabel ?? null,
    streakDays: target.streakDays ?? 0,
    daysInRange7d: target.daysInRange7d ?? 0,
  });
  const coachSources = coachScopeForTarget(target.type);

  return (
    <Card
      data-slot="target-card"
      data-target-type={target.type}
      data-status={statusGroup}
      className="flex h-full flex-col"
    >
      <CardHeader className="gap-2 pb-3 sm:gap-3">
        {/* Row 1: icon + label (left) ⋯ status pill + edit-cog (right
            on sm+, stacked on mobile). Stacking on mobile keeps the
            headline number visible at sub-380px viewports where an
            inline pill would push the value below the fold.

            v1.4.25 W3f — the per-card cog renders on EVERY card
            (consistency rule across Dashboard → Insights → Zielwerte),
            with no insufficient-data gate. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Icon
              className={cn("size-4 shrink-0", iconColor)}
              aria-hidden="true"
            />
            <h3
              className="text-muted-foreground text-[0.6875rem] font-medium tracking-[0.08em] uppercase"
              data-slot="target-card-title"
            >
              {titleLabel}
            </h3>
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            {statusLabel ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      data-slot="target-status-pill"
                      data-status={statusGroup}
                      className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1",
                        statusPillStyle,
                      )}
                    >
                      {statusLabel}
                    </span>
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
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground -mr-2 min-h-11 min-w-11 px-0"
              onClick={() => setEditOpen(true)}
              aria-label={t("targets.edit.openLabel", {
                metric: titleLabel,
              })}
              data-slot="target-edit-cog"
              data-target-type={target.type}
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex h-full flex-col gap-4">
        {/* Row 2: big-number headline + trend chevron + unit */}
        {target.current != null ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              {moodStabilityValue && moodStabilityCopy ? (
                // v1.4.25 W3e — verbal label is the headline; the raw σ
                // moves into a tooltip so power users keep the precise
                // number one hover away without forcing every visitor
                // to read "0.42 σ" and decode it.
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="text-foreground cursor-help text-2xl leading-none font-semibold capitalize sm:text-3xl"
                        data-slot="target-headline-value"
                        data-mood-stability={moodStabilityValue}
                      >
                        {moodStabilityCopy}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs">
                        σ ={" "}
                        {target.current != null
                          ? target.current.toFixed(2)
                          : "—"}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : isBp && bpDiastolic?.current != null ? (
                <span
                  className="text-foreground flex items-baseline gap-1 text-2xl leading-none font-semibold sm:text-3xl"
                  data-slot="target-headline-value"
                >
                  <span>{Math.round(target.current)}</span>
                  <span className="text-muted-foreground text-lg">/</span>
                  <span>{Math.round(bpDiastolic.current)}</span>
                </span>
              ) : (
                <span
                  className="text-foreground text-2xl leading-none font-semibold sm:text-3xl"
                  data-slot="target-headline-value"
                >
                  {target.type === "BODY_FAT"
                    ? target.current.toFixed(1)
                    : Math.round(target.current * 10) / 10}
                </span>
              )}
              {!moodStabilityValue && (
                <span className="text-muted-foreground text-sm">
                  {target.unit}
                </span>
              )}
              <span className="ml-auto">
                <TrendIcon trend={target.trend} />
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
            <AlertCircle className="size-4" aria-hidden="true" />
            <span className="text-sm">{t("targets.noMeasurementYet")}</span>
          </div>
        )}

        {/* Row 3: primary range bar (only for cards whose underlying
            metric has a defined band — the helper drops the bar
            gracefully for derived ones without a range). */}
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

        {/* Row 3b: BP diastolic range bar */}
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

        {/* Row 4: consistency strip (hidden when insufficient data) */}
        {showConsistency && target.consistency7d ? (
          <ConsistencyStrip
            days={target.consistency7d}
            daysInRange={target.daysInRange7d ?? 0}
            daysLogged={target.daysLogged7d ?? 0}
          />
        ) : target.insufficientData ? (
          <p
            className="text-muted-foreground text-xs italic"
            data-slot="target-insufficient-data"
          >
            {t("targets.consistency.insufficientData")}
          </p>
        ) : null}

        {/* Row 5: recency + streak chips. Both conditional. */}
        {(showLastMet || showStreak) && (
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {showLastMet && target.lastMetGoalAt && (
              <span data-slot="target-last-met">
                {t("targets.card.lastMet", {
                  when: formatRelativeDay(target.lastMetGoalAt, t),
                })}
              </span>
            )}
            {showStreak && (
              <span
                className="text-foreground inline-flex items-center gap-1.5 rounded-full bg-(--dracula-green)/12 px-2 py-0.5 font-medium ring-1 ring-(--dracula-green)/30"
                data-slot="target-streak"
              >
                <span
                  className="size-1.5 rounded-full bg-(--dracula-green)"
                  aria-hidden="true"
                />
                {t("targets.card.streak", { count: String(target.streakDays) })}
              </span>
            )}
          </div>
        )}

        {/* Medication breakdown (regimen-specific detail) */}
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

        {/* Row 6: footer. Mobile-first reflow:
              - default (<640px): stack vertically; the Coach CTA
                spans full width so the touch target is generous, the
                source link sits beneath it right-aligned.
              - sm+ (≥640px): horizontal row, Coach left + source right.
            `mt-auto` pins to card bottom so grid cells align. */}
        <div className="mt-auto flex flex-col items-stretch gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          {aiEnabled && (
            <TargetCoachButton
              prefill={coachPrefill}
              sources={coachSources}
              onAskCoach={onAskCoach}
              aiEnabled={aiEnabled}
              className="w-full justify-center sm:-ml-2 sm:w-auto sm:justify-start"
            />
          )}
          {sourceLink ? (
            <a
              href={sourceLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-end text-xs sm:ml-auto sm:self-auto"
            >
              <span>{target.source}</span>
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          ) : (
            <span className="text-muted-foreground self-end text-xs sm:ml-auto sm:self-auto">
              {target.source}
            </span>
          )}
        </div>
      </CardContent>
      {/* v1.4.25 W3f — edit dialog mounted alongside the card. The
          dialog is portalled by Radix so it isn't constrained by the
          card's overflow / z-index. Only one card's dialog ever opens
          at a time (each card owns its own boolean state). */}
      <TargetEditSheet
        targetType={target.type}
        targetLabel={titleLabel}
        unit={target.unit}
        initialRange={target.range}
        initialDiastolicRange={bpDiastolic?.range ?? null}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </Card>
  );
}
