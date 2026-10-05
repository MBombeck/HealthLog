"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { useCountUp } from "@/hooks/use-count-up";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { bandForScore, clampScore, type ScoreBand } from "./band-tokens";
import { RING_GRADIENT, type RingHue } from "./ring-hues";

/**
 * v1.14.0 — the composite-score dial: a hand-rolled SVG arc gauge, 0 KB
 * runtime, no animation library. A score dial is a fixed-geometry gauge, not a
 * data chart, so SVG gives exact control over a thin round-cap arc, a
 * segmented same-hue track, a near-flat single-hue arc, and a faint "vs your
 * baseline" ghost arc.
 *
 * v1.18.7 — CALM by default. The earlier dial wore a token-tinted bloom, a
 * conic specular sheen, and a breathing pulse on the green ring; against the
 * flat 2-D Recharts charts that read as a glowing 3-D gauge. All three are
 * gone everywhere — the ring now paints a plain stroke in a muted single hue,
 * as quiet as a chart series. The only motion left is a subtle spring fill on
 * first reveal + a count-up, both gated on `prefers-reduced-motion`.
 *
 * Motion (CSS-first, gated on `prefers-reduced-motion`):
 *   • the arc sweeps from empty on mount via a `linear()` SPRING that
 *     overshoots ~6% then settles (`--ring-spring`); the spring is swapped for
 *     a plain ease-out above score 94 so a high arc never wraps past full;
 *   • `delayMs` staggers the sweep + the count-up so the strip reveals
 *     left-to-right and each number trails its arc;
 *   • the quiet tile rise lives in `globals.css`, gated on the strip's
 *     `data-revealed` flag (set once per session) so a background refetch
 *     never re-triggers it.
 *
 * The arc/track/ghost are real SVG JSX (`<linearGradient>` is NOT
 * `dangerouslySetInnerHTML`). The `<svg>` is rotated -90° so the arc starts at
 * 12 o'clock and sweeps clockwise without per-point trig. The centred number
 * is real DOM text so a long label never clips under the viewBox.
 *
 * `score === null` renders the provisional/empty state. a11y: `role="img"` +
 * an aria-label restating number + band, so the ring is never colour-only;
 * the band always rides `data-band` regardless of arc hue.
 */

// The SVG is a fixed 0 0 100 100 viewBox; CSS scales it to `dims.px`.
const VIEW = 100;
const STROKE = 9; // ~9% of size → Apple-class thinness.
const R = (VIEW - STROKE) / 2; // radius so the stroke sits inside the box.
const C = 2 * Math.PI * R; // circumference for the dash math.
const CX = VIEW / 2;
// Above this score the spring overshoot (~6% of the swept distance) would push
// the arc past a full circle and wrap — use a non-overshoot ease-out instead.
const SPRING_SAFE_MAX = 94;

const SIZE: Record<
  NonNullable<ScoreRingProps["size"]>,
  {
    /** Fixed edge length; null when `boxClass` sizes the ring per breakpoint. */
    px: number | null;
    boxClass?: string;
    numberClass: string;
    labelClass: string;
  }
> = {
  sm: { px: 120, numberClass: "text-3xl", labelClass: "text-2xs" },
  md: { px: 168, numberClass: "text-5xl", labelClass: "text-xs" },
  lg: { px: 232, numberClass: "text-7xl", labelClass: "text-sm" },
  // The dashboard hero: a compact 80 px dial beside the lead on a phone, the
  // `md` dial from the md breakpoint up. Below md the label is left out (the
  // number alone is legible at this size; the ring's aria-label and the
  // surrounding link still name it), so the centre never crowds.
  responsive: {
    px: null,
    boxClass: "size-20 md:size-42",
    numberClass: "text-2xl md:text-5xl",
    labelClass: "hidden text-xs md:block",
  },
};

export interface ScoreRingProps {
  /** The 0..100 score, or `null` for the provisional/empty state. */
  score: number | null;
  /** Band override; when omitted it is derived from the score via thresholds. */
  band?: ScoreBand;
  /** Short label rendered under the number (e.g. "Readiness", "/100"). */
  label?: string;
  /**
   * Render size. `sm` in a grid tile, `md`/`lg` on the anatomy view,
   * `responsive` on the dashboard hero (compact on a phone, `md` above).
   */
  size?: "sm" | "md" | "lg" | "responsive";
  /** Disable the sweep + count-up (e.g. when already revealed this session). */
  animate?: boolean;
  /**
   * Per-metric hue for the single-hue two-stop arc gradient. When omitted the
   * gradient falls back to the score's band token (green/yellow/red) — the
   * anatomy detail view keeps band semantics that way.
   */
  hue?: RingHue;
  /**
   * Stagger offset (ms): delays the arc sweep + the count-up start so a row of
   * rings reveals left-to-right and each number trails its own arc.
   */
  delayMs?: number;
  /**
   * v1.18.7 — the bloom / sheen / pulse are gone for every ring, so the only
   * thing `flat` still does is drop the spring-fill sweep + the count-up: the
   * dashboard-hero ring paints its final value at once, with no entrance
   * motion. The /insights strip + anatomy view keep the subtle sweep.
   */
  flat?: boolean;
  /**
   * Optional "your normal" reference (0..100). When set + finite, a faint
   * thinner ghost arc renders under the live arc so the user sees today vs
   * their baseline at a glance. Omit (null) when no trailing series exists.
   */
  baseline?: number | null;
  /**
   * Retained for API compatibility. The premium redesign drops the old
   * white-arc-on-dark-slab treatment in favour of the per-metric `hue`
   * gradient, so this no longer changes the paint; kept so existing call sites
   * + tests don't break.
   */
  variant?: "band" | "onGradient";
  /**
   * v1.27.x — optional centre-text override for rings whose number is a
   * tally rather than a score (the hero dose ring's "1/3"). The arc still
   * sweeps on `score` (the 0..100 progress); only the displayed text
   * changes, and the count-up is skipped. Pair with `ariaLabel` — the
   * default announcement reads score + band, which is wrong for a tally.
   */
  valueText?: string;
  /** Optional aria-label override (see `valueText`). */
  ariaLabel?: string;
  className?: string;
}

export function ScoreRing({
  score,
  band,
  label,
  size = "md",
  animate = true,
  hue,
  delayMs = 0,
  baseline,
  flat = false,
  valueText,
  ariaLabel: ariaLabelOverride,
  className,
}: ScoreRingProps) {
  const { t } = useTranslations();
  const dims = SIZE[size];
  const gid = useId();

  const hasScore = score != null && Number.isFinite(score);
  const clamped = hasScore ? clampScore(score) : 0;
  const resolvedBand: ScoreBand = band ?? bandForScore(clamped);
  const hueKey = hue ?? resolvedBand;

  // Near-flat single-hue arc. The two stops sit a hair apart for a whisper of
  // depth; the per-metric `hue` leans the colour, with no `hue` the anatomy
  // view falls back to the muted band token.
  const [from, to] = RING_GRADIENT[hueKey];

  const reduced = prefersReducedMotion();
  // `flat` forces the calm static treatment regardless of the `animate` prop:
  // no sweep, no count-up, no pulse, no sheen, no bloom.
  const shouldAnimate = animate && hasScore && !reduced && !flat;
  const dash = (clamped / 100) * C;

  const hasBaseline = baseline != null && Number.isFinite(baseline) && hasScore;
  const baselineDash = hasBaseline ? (clampScore(baseline) / 100) * C : 0;

  // Arc starts empty (offset C) and sweeps to its fill on the next frame after
  // mount, so the spring transition actually plays on first paint (transitions
  // don't run on the initial commit). With motion off, it paints final at once.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!shouldAnimate) return;
    const raf = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(raf);
  }, [shouldAnimate]);
  const filled = !shouldAnimate || armed;

  const easing =
    clamped > SPRING_SAFE_MAX ? "var(--ring-ease)" : "var(--ring-spring)";

  const displayed = useCountUp(clamped, {
    enabled: shouldAnimate,
    durationMs: 1000,
    startDelayMs: delayMs + 180,
  });
  const displayedRounded = Math.round(displayed);

  const ariaLabel =
    ariaLabelOverride ??
    (hasScore
      ? t("insights.derived.scoreRing.aria", {
          score: Math.round(clamped),
          band: t(`insights.derived.scoreRing.band.${resolvedBand}`),
        })
      : t("insights.derived.scoreRing.ariaProvisional"));

  return (
    <div
      data-slot="score-ring"
      data-band={hasScore ? resolvedBand : "none"}
      data-provisional={hasScore ? undefined : "true"}
      role="img"
      aria-label={ariaLabel}
      className={cn("relative shrink-0", dims.boxClass, className)}
      style={
        dims.px === null
          ? undefined
          : ({
              width: dims.px,
              height: dims.px,
            } as React.CSSProperties)
      }
    >
      {/* The -90° rotation starts the arc at 12 o'clock so it sweeps clockwise
          without per-point trig. The arc now carries no bloom, so the SVG needs
          no `overflow-visible`. */}
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="h-full w-full -rotate-90"
        aria-hidden="true"
      >
        <defs>
          {/* Single-hue two-stop gradient — JSX SVG, not dangerouslySetInnerHTML. */}
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        {/* Segmented same-hue tick track — reads as an instrument, not a bar. */}
        <circle
          cx={CX}
          cy={CX}
          r={R}
          fill="none"
          stroke={`url(#${gid})`}
          strokeOpacity={0.16}
          strokeWidth={STROKE}
          strokeDasharray="0.5 4.2"
        />
        {/* "vs your baseline" ghost arc — thinner, faint, under the live arc. */}
        {hasBaseline ? (
          <circle
            cx={CX}
            cy={CX}
            r={R}
            fill="none"
            stroke={`url(#${gid})`}
            strokeOpacity={0.3}
            strokeWidth={STROKE * 0.42}
            strokeLinecap="round"
            strokeDasharray={C}
            style={{
              strokeDashoffset: filled ? C - baselineDash : C,
              transition: shouldAnimate
                ? `stroke-dashoffset 420ms var(--ring-ease) ${delayMs}ms`
                : undefined,
            }}
          />
        ) : null}
        {/* The progress arc — muted single hue, round cap, subtle spring sweep.
            No bloom / pulse: `.wellness-ring-arc` is a plain flat stroke. */}
        <circle
          className="wellness-ring-arc"
          cx={CX}
          cy={CX}
          r={R}
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={C}
          style={{
            strokeDashoffset: filled ? C - dash : C,
            transition: shouldAnimate
              ? `stroke-dashoffset 1150ms ${easing} ${delayMs}ms`
              : undefined,
          }}
        />
      </svg>
      {/* Centred number as real DOM text — design tokens + tabular-nums. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={cn(
            "font-semibold tracking-tight tabular-nums",
            dims.numberClass,
            hasScore ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {hasScore ? (valueText ?? displayedRounded) : "—"}
        </span>
        {label ? (
          <span className={cn("text-muted-foreground", dims.labelClass)}>
            {label}
          </span>
        ) : null}
      </div>
      {!hasScore && (
        <span
          data-slot="score-ring-provisional"
          className="text-muted-foreground text-2xs absolute inset-x-0 bottom-0 line-clamp-1 px-1 text-center leading-tight"
        >
          {t("insights.derived.scoreRing.provisionalCaption")}
        </span>
      )}
    </div>
  );
}
