"use client";

import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useCountUp } from "@/hooks/use-count-up";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import type { CyclePhase } from "./types";
import { PHASE_HUE } from "./phase-tokens";

/**
 * v1.15.0 — the cycle wheel: a hand-rolled SVG phase ring (0 KB runtime, no
 * chart lib) that carries the same premium "signature reveal" as the wellness
 * rings while keeping its own identity as a FULL-circle four-phase dial. The
 * four cycle phases render as proportional arc segments around the ring; a
 * marker dot sits at the current day-of-cycle; the day number is real centred
 * DOM text.
 *
 * Motion (all CSS-first, all gated on `prefers-reduced-motion` AND on the
 * host's `data-revealed`, which the view sets ONCE per session so a background
 * calendar refetch never re-triggers the moment):
 *   • a clockwise CLOCK-WIPE (`.cycle-ring-reveal`) draws the arcs on from the
 *     12-o'clock day-0 origin — the <svg> already carries `-rotate-90`, so the
 *     conic mask origin lines up with both the arcs and the marker;
 *   • the active phase arc carries the shared `.wellness-ring-arc` bloom,
 *     `--ring-glow` set inline to the active phase hue;
 *   • the shared `.wellness-ring-sheen` sweeps a single specular pass;
 *   • the day number eases up with `useCountUp`;
 *   • the marker gets a soft `.cycle-ring-marker-halo` pulse.
 *
 * a11y: `role="img"` + a phase-aware aria-label so the ring is never
 * colour-only. The arcs/marker are real SVG JSX (`<linearGradient>` would not
 * be `dangerouslySetInnerHTML`); the centred number is real DOM text.
 */

const VIEW = 100;
const STROKE = 8;
const R = (VIEW - STROKE) / 2;
const C = 2 * Math.PI * R;
const CX = VIEW / 2;
const GAP = 0.5; // unit gap between segments so phases read as distinct arcs.

const PHASE_ORDER: CyclePhase[] = [
  "MENSTRUAL",
  "FOLLICULAR",
  "OVULATORY",
  "LUTEAL",
];

export interface PhaseSpan {
  phase: CyclePhase;
  /** Proportion of the cycle this phase covers (0..1). Spans sum to ~1. */
  fraction: number;
}

export interface CycleRingProps {
  /** 1-based day of the current cycle, or null when no cycle is active. */
  dayOfCycle: number | null;
  /** Total length the ring represents (estimated cycle length, days). */
  cycleLength: number | null;
  /** The current phase (drives the centre label + aria). */
  phase: CyclePhase | null;
  /** Proportional phase spans around the ring. Omit for an even quarter split. */
  spans?: PhaseSpan[];
  /** Whether the once-per-session reveal plays (false = paint final). */
  animate?: boolean;
  size?: number;
  className?: string;
}

/** Below this edge length the dial shows the day without its caption. */
const SMALL_DIAL = 120;

function evenSpans(): PhaseSpan[] {
  return PHASE_ORDER.map((phase) => ({ phase, fraction: 0.25 }));
}

export function CycleRing({
  dayOfCycle,
  cycleLength,
  phase,
  spans,
  animate = false,
  size = 220,
  className,
}: CycleRingProps) {
  const { t } = useTranslations();
  const reduced = prefersReducedMotion();
  const shouldAnimate = animate && !reduced;

  const resolvedSpans = useMemo(() => {
    const raw = spans && spans.length > 0 ? spans : evenSpans();
    const total = raw.reduce((s, x) => s + x.fraction, 0) || 1;
    return raw.map((x) => ({ ...x, fraction: x.fraction / total }));
  }, [spans]);

  // Build each phase arc as a dash segment around the ring. The running
  // start-offset is carried through `reduce` rather than mutating a closure
  // variable inside `map` (the latter trips the render-immutability rule).
  const segments = useMemo(
    () =>
      resolvedSpans.reduce<{
        offset: number;
        segs: {
          phase: CyclePhase;
          dashArray: string;
          dashOffset: number;
          active: boolean;
        }[];
      }>(
        (acc, span) => {
          const len = Math.max(span.fraction * C - GAP, 0);
          acc.segs.push({
            phase: span.phase,
            dashArray: `${len} ${C - len}`,
            dashOffset: -acc.offset,
            active: span.phase === phase,
          });
          return {
            offset: acc.offset + span.fraction * C,
            segs: acc.segs,
          };
        },
        { offset: 0, segs: [] },
      ).segs,
    [resolvedSpans, phase],
  );

  // The marker sits at the cycle-day proportion around the circle. The
  // surrounding <svg> already carries `-rotate-90`, so 0 rad here maps to
  // 12 o'clock — day 0 must NOT subtract another π/2 (the prior double-rotate
  // bug parked the marker at 9 o'clock). Day 1 is treated as the 12-o'clock
  // origin (1-based dayOfCycle → 0-based progress).
  const markerProgress =
    dayOfCycle != null && cycleLength != null && cycleLength > 0
      ? Math.min((dayOfCycle - 1) / cycleLength, 1)
      : null;
  const markerAngle =
    markerProgress != null ? markerProgress * 2 * Math.PI : null;
  const markerX = markerAngle != null ? CX + R * Math.cos(markerAngle) : 0;
  const markerY = markerAngle != null ? CX + R * Math.sin(markerAngle) : 0;

  // The day number eases up on the reveal, mirroring the score-ring count-up.
  const displayedDay = useCountUp(dayOfCycle ?? 0, {
    enabled: shouldAnimate && dayOfCycle != null,
    durationMs: 900,
    startDelayMs: 220,
  });

  const phaseLabel = phase ? t(`cycle.phase.${phase}`) : t("cycle.phase.none");

  const ariaLabel =
    dayOfCycle != null
      ? t("cycle.ring.ariaPhase", { day: dayOfCycle, phase: phaseLabel })
      : t("cycle.ring.ariaUnknown");

  const markerHue = phase ? PHASE_HUE[phase] : "var(--foreground)";

  return (
    <div
      data-slot="cycle-ring"
      data-phase={phase ?? "none"}
      role="img"
      aria-label={ariaLabel}
      // v1.15.10 — responsive width. The ring used a fixed `width: size` +
      // `shrink-0`, so at the 120 px tile size it overflowed grid cells on
      // ≤360 px Android widths. It now caps at `size` (`maxWidth`) but is free
      // to shrink to fill its cell (`w-full`, square via `aspect-square`), so it
      // never pushes the page wider than the viewport. The day number + phase
      // caption scale with the box; the SVG already paints `h-full w-full`.
      className={cn("relative aspect-square w-full", className)}
      style={
        {
          maxWidth: size,
          // The bloom on the active arc is tinted to the live phase hue.
          "--ring-glow": markerHue,
        } as React.CSSProperties
      }
    >
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="cycle-ring-reveal h-full w-full -rotate-90"
        aria-hidden="true"
      >
        {/* Faint segmented tick track — reads as an instrument. */}
        <circle
          cx={CX}
          cy={CX}
          r={R}
          fill="none"
          stroke="var(--muted-foreground)"
          strokeOpacity={0.12}
          strokeWidth={STROKE}
          strokeDasharray="0.5 4.2"
        />
        {/* Phase arcs — one calm hue per phase, the active phase fully opaque
            and carrying the shared wellness-ring bloom. */}
        {segments.map((seg) => (
          <circle
            key={seg.phase}
            className={cn(seg.active && "wellness-ring-arc")}
            cx={CX}
            cy={CX}
            r={R}
            fill="none"
            stroke={PHASE_HUE[seg.phase]}
            strokeOpacity={seg.active ? 1 : 0.32}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={seg.dashArray}
            strokeDashoffset={seg.dashOffset}
            style={{
              transition: reduced ? undefined : "stroke-opacity 400ms ease",
            }}
          />
        ))}
        {/* Current-day marker: a soft halo pulse behind a solid dot. */}
        {markerAngle != null ? (
          <>
            <circle
              className="cycle-ring-marker-halo"
              cx={markerX}
              cy={markerY}
              r={STROKE / 1.4}
              fill="none"
              stroke={markerHue}
              strokeWidth={1.5}
              strokeOpacity={0.6}
            />
            <circle
              cx={markerX}
              cy={markerY}
              r={STROKE / 1.7}
              fill="var(--background)"
              stroke={markerHue}
              strokeWidth={2}
            />
          </>
        ) : null}
      </svg>
      {/* Conic specular sheen — sweeps the dial once on the reveal. */}
      <div className="wellness-ring-sheen" aria-hidden="true" />
      {/* Centred day number + phase caption as real DOM text. A small dial
          (a score tile, the overview card) has no room for the caption: the
          day stands alone, the phase is said beside the ring and in the
          ring's aria-label. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span
          className={cn(
            "text-foreground font-semibold tracking-tight tabular-nums",
            size < SMALL_DIAL ? "text-2xl" : "text-4xl",
          )}
        >
          {dayOfCycle != null
            ? Math.round(displayedDay)
            : t("cycle.ring.dayUnknown")}
        </span>
        {size < SMALL_DIAL ? null : (
          <span className="text-muted-foreground mt-0.5 text-xs">
            {phaseLabel}
          </span>
        )}
      </div>
    </div>
  );
}
