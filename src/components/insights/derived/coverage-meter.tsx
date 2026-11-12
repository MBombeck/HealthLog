"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type {
  DerivedConfidence,
  DerivedConfidenceBand,
  DerivedCoverage,
} from "@/lib/insights/derived/types";

/**
 * v1.10.0 — the single reusable data-confidence indicator.
 *
 * `●●●●○` filled/hollow dots driven by the `presentInputs / requiredInputs`
 * ratio off `Derived<T>.coverage`, tinted by the `confidence.band`, with an
 * accessible breakdown on a tap (present vs required inputs, history days,
 * and the named missing inputs). This is the one place the whole app speaks
 * data-confidence — every score tile, anatomy view, correlation card,
 * briefing and report header renders it identically.
 *
 * It is the load-bearing graceful-degradation primitive: a partial score is
 * shown WITH its confidence, never silently downgraded and never blank. The
 * dots read as intentional ("4 of 5 inputs · 80%"), not apologetic.
 *
 * CSS-only dots + a `Popover` for the breakdown: it opens on a tap, which a
 * hover tooltip never does on a phone.
 */

export interface CoverageMeterProps {
  coverage: DerivedCoverage;
  /**
   * Optional confidence facet. When present, the dots take the band tint
   * and the percent label reads the confidence score; when omitted the
   * meter falls back to the present/required ratio for both.
   */
  confidence?: DerivedConfidence;
  /** Total number of dots rendered. Defaults to 5 (the `●●●●○` grammar). */
  dots?: number;
  /** Visual size. `sm` rides inside a grid tile, `md` on the anatomy view. */
  size?: "sm" | "md";
  /**
   * Replaces the bare `{present}/{required}` fraction, in the visible
   * label, the `aria-label` and the breakdown heading alike.
   *
   * The default fraction reads as a proportion of the reader's own data,
   * and for one caller it is not: the Health Score's composite counts
   * DISTINCT DOMAINS against the three the score requires, and a scored
   * account has met that floor by definition, so the fraction is pinned
   * at "3/3" however much or little the person records. The dots and the
   * percentage stay meaningful there because they track history depth;
   * only the fraction lies. A caller in that position names its axis
   * instead. Everyone else leaves this alone and keeps the fraction.
   */
  axisLabel?: string;
  /** Optional className applied to the outer wrapper. */
  className?: string;
}

/**
 * Dot tint per confidence band. Points at the *semantic* feedback tokens
 * (`--success` / `--warning` / `--destructive`), not the raw `--dracula-*`
 * primitives, so the dots track the AA-safe `:root.light` overrides on the
 * white card. (The raw primitives now carry their own light overrides in
 * globals.css as well, so this is concept cohesion with the score language
 * rather than the only contrast-safe path it once was.) The four bands
 * collapse onto the three semantic severities (medium + low both ride the
 * caution `--warning`); the lit-dot count + the percent label carry the
 * medium↔low distinction, never colour alone.
 */
const BAND_DOT_CLASS: Record<DerivedConfidenceBand, string> = {
  high: "bg-success",
  medium: "bg-warning",
  low: "bg-warning",
  draft: "bg-destructive",
};

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function CoverageMeter({
  coverage,
  confidence,
  dots = 5,
  size = "sm",
  axisLabel,
  className,
}: CoverageMeterProps) {
  const { t } = useTranslations();

  const required = clampInt(coverage.requiredInputs, 0, 999);
  const present = clampInt(coverage.presentInputs, 0, required || 999);
  const totalDots = clampInt(dots, 1, 12);

  // The fill ratio prefers the explicit confidence score (so the meter
  // tracks the same number the band is derived from); without it, fall
  // back to the present/required ratio.
  const ratio =
    confidence != null
      ? clampInt(confidence.score, 0, 100) / 100
      : required > 0
        ? present / required
        : 0;
  const litDots = clampInt(ratio * totalDots, 0, totalDots);
  const percent = Math.round(ratio * 100);
  const band: DerivedConfidenceBand = confidence?.band ?? "low";
  const dotLit = BAND_DOT_CLASS[band];

  const dotSize = size === "md" ? "h-2.5 w-2.5" : "h-2 w-2";

  const summaryLabel = axisLabel
    ? t("insights.derived.coverage.summaryLabelled", {
        label: axisLabel,
        percent,
      })
    : t("insights.derived.coverage.summary", {
        present,
        required,
        percent,
      });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="coverage-meter"
          data-band={band}
          data-present={present}
          data-required={required}
          data-percent={percent}
          className={cn(
            // 44px hit target via padding while the dots stay optically
            // small; negative margin collapses the row back so the meter
            // doesn't inflate its host row.
            "-my-3 inline-flex min-h-11 items-center gap-2 rounded px-1 py-3",
            "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
            className,
          )}
        >
          <span
            data-slot="coverage-meter-dots"
            className="inline-flex items-center gap-[3px]"
            aria-hidden="true"
          >
            {Array.from({ length: totalDots }).map((_, i) => {
              const isLit = i < litDots;
              return (
                <span
                  key={i}
                  data-dot-index={i}
                  data-dot-state={isLit ? "lit" : "unlit"}
                  className={cn(
                    "rounded-full",
                    dotSize,
                    isLit ? dotLit : "bg-muted/40",
                  )}
                />
              );
            })}
          </span>
          <span
            data-slot="coverage-meter-label"
            className={cn(
              "text-muted-foreground tabular-nums",
              size === "md" ? "text-xs" : "text-2xs",
            )}
          >
            {axisLabel ??
              t("insights.derived.coverage.ratioLabel", {
                present,
                required,
              })}
          </span>
          {/* The visible ratio names the button; the sentence adds what it
                counts (WCAG 2.5.3: the name contains what is shown). */}
          <span className="sr-only">{summaryLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-slot="coverage-meter-tooltip"
        className="max-w-[15rem]"
      >
        <div className="space-y-1 text-xs">
          <p className="font-medium">{summaryLabel}</p>
          <p className="text-muted-foreground">
            {t("insights.derived.coverage.historyDays", {
              count: clampInt(coverage.historyDays, 0, 99999),
            })}
          </p>
          {coverage.missing.length > 0 && (
            <p
              data-slot="coverage-meter-missing"
              className="text-muted-foreground"
            >
              {t("insights.derived.coverage.missing", {
                list: coverage.missing.join(", "),
              })}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
