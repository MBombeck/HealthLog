"use client";

import {
  Activity,
  Droplets,
  Flame,
  Gauge,
  HeartPulse,
  Moon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { isSurfaceVisible } from "@/lib/modules/surface";
import { healthScoreSetterLine } from "@/lib/score-config/labels";
import { metricHref, pageHref } from "@/lib/links/hrefs";
import { CycleRing } from "@/components/cycle/cycle-ring";
import { useCycleCalendar, useCycleWindow } from "@/components/cycle/use-cycle";
import { ScoreRingTile, type ScoreRingTileProps } from "./score-ring-tile";
import type { DerivedBatchRead } from "./use-derived-metric";
import { scoreOriginLabelKey } from "./band-tokens";
import { scoreShortLabel } from "@/lib/scores/registry";
// Type-only — the compute payloads never drag the server graph into the bundle.
import type { ReadinessValue } from "@/lib/insights/derived/readiness";
import type { SleepScoreValue } from "@/lib/insights/derived/sleep-score";
import type { WellnessScoreValue } from "@/lib/insights/derived/wellness-scores";
import type { HealthScoreReport } from "@/lib/analytics/score/types";

/**
 * The score rings at the head of Insights, in one row: Readiness ("today"),
 * Sleep score ("last night"), the Health score ("the long view"), Stress and
 * Strain where the record has them, and the cycle for an account that tracks
 * it. Every tile is the shared `ScoreRingTile` with the same three parts: the
 * ring, the short name and one line that says how the score stands. The short
 * name is the payload's `shortLabel`, worded by the server from the glossary;
 * the registry's same function stands in only for a body cached before it.
 *
 * The row never wraps. Its tiles share the width equally and keep at least
 * 9 rem each; when the window is narrower than that (a phone with three or
 * more scores) the row scrolls sideways and the next tile peeks in at the
 * edge, so nothing is cut off without a sign that more follows.
 *
 * Not a section on purpose. A section id a saved layout has hidden would take
 * the rings with it, and a layout that has never seen an id merges it in as
 * hidden. Each ring opens its own page.
 *
 * A readiness that rests on values from before today is not a statement about
 * today: its ring shows the stale face, no number, no band, the line says
 * "not from today" and the ring's accessible name "Last 81 on Nov 24".
 *
 * Readiness, sleep, stress and strain read from the ONE batched derived
 * request the page owns; the Health score from the analytics payload the page
 * already holds; the cycle from the calendar read the cycle card shares.
 * Nothing warms on visit.
 */

/** The row: equal widths, one line of tiles, sideways scroll when narrow. */
// The 4 px inset (`-m-1 p-1`) keeps the tiles' hover and focus rings inside
// the scroller, which would otherwise clip them; the layout is unchanged.
const ROW_CLASS =
  "-m-1 grid scroll-px-1 snap-x snap-mandatory auto-cols-[minmax(9rem,1fr)] grid-flow-col gap-4 overflow-x-auto overscroll-x-contain p-1 [scrollbar-width:none]";

interface ScoreHeadProps {
  /** The batched-read selector from the page's one derived query. */
  read: DerivedBatchRead;
  isLoading: boolean;
  /** The shared derived-batch error flag: an error row with Retry in place. */
  isError?: boolean;
  /** The batch query's error, which decides what the error row offers. */
  error?: unknown;
  /** Refetch the one shared batch query. */
  refetch?: () => void;
  /** The Health score report from the analytics payload, null without one. */
  healthScore: HealthScoreReport | null;
  /** True while that payload is in flight and nothing is cached. */
  healthPending: boolean;
  className?: string;
}

/** The two day scores, then (after the Health score) the two loads. */
const DAY_SCORES = [
  { id: "READINESS", kind: "readiness", icon: Gauge },
  { id: "SLEEP_SCORE", kind: "sleep", icon: Moon },
] as const;

const LOAD_SCORES = [
  { id: "STRESS_SCORE", kind: "stress", slug: "stress-score", icon: Activity },
  { id: "STRAIN_SCORE", kind: "strain", slug: "strain-score", icon: Flame },
] as const;

type Tile = Omit<ScoreRingTileProps, "size">;

/** The cycle as one more tile: its dial, the phase as the line. */
function useCycleTile(enabled: boolean): {
  tile: Tile | null;
  pending: boolean;
} {
  const { t } = useTranslations();
  const { from, to } = useCycleWindow();
  const calendar = useCycleCalendar(from, to, enabled);
  if (!enabled) return { tile: null, pending: false };
  // A failed or empty read leaves the tile out: the cycle card further down
  // says what went wrong, with its retry.
  if (!calendar.data) {
    return { tile: null, pending: calendar.isLoading };
  }
  const verdict = calendar.data.verdict;
  const phase = verdict?.phase ?? null;
  const day = verdict?.dayOfCycle ?? null;
  // Only a cycle the record tracks has a tile: without a current phase and
  // day the module is on but nothing is tracked, and the row stays scores.
  if (!phase || day === null) return { tile: null, pending: false };
  const phaseName = t(`cycle.phase.${phase}`);
  const title = t("cycle.title");
  return {
    pending: false,
    tile: {
      id: "CYCLE",
      href: pageHref("cycle"),
      icon: Droplets,
      label: title,
      shortLabel: title,
      score: null,
      band: undefined,
      stale: false,
      line: phaseName,
      ring: (
        <CycleRing
          dayOfCycle={day}
          cycleLength={verdict?.cycleLength ?? null}
          phase={phase}
          spans={verdict?.spans}
          size={80}
          className="shrink-0"
        />
      ),
    },
  };
}

export function WellnessScores({
  read,
  isLoading,
  isError = false,
  error = null,
  refetch,
  healthScore,
  healthPending,
  className,
}: ScoreHeadProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  // The cycle joins the row for an account that tracks it, the same gate as
  // the cycle card further down.
  const cycle = useCycleTile(
    user != null && isSurfaceVisible("overview:cycle-summary", user.modules),
  );

  const regionLabel = t("insights.scores.regionLabel");

  if (isLoading || (healthPending && !healthScore) || cycle.pending) {
    return (
      <section
        data-slot="wellness-scores"
        aria-label={regionLabel}
        className={className}
      >
        <div
          data-slot="wellness-scores-grid"
          // `status` names the loading region and implies the polite live
          // region; a bare <div> may not carry `aria-label`.
          role="status"
          aria-busy="true"
          aria-live="polite"
          aria-label={t("insights.scores.loadingLabel")}
          className={ROW_CLASS}
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton
              key={`wellness-skeleton-${i}`}
              data-slot="wellness-score-tile-skeleton"
              aria-hidden="true"
              className="h-42 rounded-xl"
            />
          ))}
        </div>
      </section>
    );
  }

  const tiles: Tile[] = [];

  for (const tile of DAY_SCORES) {
    const r = read<ReadinessValue | SleepScoreValue>({ metric: tile.id });
    if (r?.status !== "ok" || !r.value) continue;
    const v = r.value;
    const title = t(`insights.derived.composite.${tile.id}.title`);
    const stale = v.fresh === false;
    tiles.push({
      id: tile.id,
      href: `/insights/scores/${tile.kind}`,
      icon: tile.icon,
      label: title,
      shortLabel: r.shortLabel ?? scoreShortLabel(tile.id, t),
      score: stale ? null : v.score,
      band: stale ? undefined : v.band,
      stale,
      line: stale
        ? t("insights.scores.staleLast", {
            score: Math.round(v.score),
            date: fmt.dateShortSmartCalendar(
              "asOfDay" in v ? v.asOfDay : v.night,
            ),
          })
        : null,
    });
  }

  if (healthScore) {
    const composite = healthScore.composite;
    const ok = composite.status === "ok";
    const label = t("insights.healthScore.label");
    // A pillar withheld for safety signposting says nothing on the tile: the
    // score page names it in one sentence with the way to support.
    tiles.push({
      id: "HEALTH_SCORE",
      href: "/insights/scores/health",
      icon: HeartPulse,
      label,
      shortLabel: healthScore.shortLabel ?? scoreShortLabel("HEALTH_SCORE", t),
      score: ok ? composite.value.score : null,
      band: ok ? composite.value.numberBand : undefined,
      stale: !ok,
      line:
        healthScoreSetterLine(healthScore, t) ??
        (ok ? null : t("insights.derived.scoreRing.provisionalCaption")),
    });
  }

  for (const tile of LOAD_SCORES) {
    const r = read<WellnessScoreValue>({ metric: tile.id });
    if (r?.status !== "ok" || !r.value) continue;
    const v = r.value;
    const title = t(`insights.derived.scores.${tile.kind}`);
    // A strain the device served has no band: its ring is neutral, and its
    // line gives the device's own reading. Whose number it is (an estimate,
    // a device's value) rides the line.
    const origin = scoreOriginLabelKey(v.origin);
    const originLabel = origin ? t(origin) : null;
    const deviceValue = v.device
      ? t("insights.deviceScores.valueOfScale", {
          value: fmt.number(v.device.value, 1),
          max: v.device.scaleMax,
        })
      : null;
    tiles.push({
      id: tile.id,
      href: metricHref(tile.slug) ?? "",
      icon: tile.icon,
      label: title,
      shortLabel: r.shortLabel ?? scoreShortLabel(tile.id, t),
      score: v.score,
      band: v.device ? undefined : v.band,
      load: true,
      stale: false,
      line:
        [deviceValue, originLabel].filter((part) => part !== null).join(", ") ||
        null,
    });
  }

  if (cycle.tile) tiles.push(cycle.tile);

  // A failed shared batch reads as an error, not as "no scores". The Health
  // score comes from another read and still shows beside it.
  const errorRow = isError ? (
    <QueryErrorRow
      error={error}
      slot="wellness-scores-error"
      retrySlot="wellness-scores-retry"
      message={t("insights.scores.loadError")}
      onRetry={() => refetch?.()}
    />
  ) : null;

  if (tiles.length === 0 && !errorRow) return null;

  return (
    <section
      data-slot="wellness-scores"
      aria-label={regionLabel}
      className={cn("space-y-3", className)}
    >
      {errorRow}
      {tiles.length > 0 ? (
        <div
          data-slot="wellness-scores-grid"
          data-tile-count={tiles.length}
          className={ROW_CLASS}
        >
          {tiles.map((tile) => (
            <div key={tile.id} className="min-w-0 snap-start">
              <ScoreRingTile {...tile} size="compact" titleAs="h2" />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
