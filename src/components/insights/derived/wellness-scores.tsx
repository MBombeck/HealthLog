"use client";

import { useState, type ComponentType } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  Activity,
  Flame,
  Gauge,
  HeartPulse,
  Moon,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { SectionHeading } from "@/components/ui/section-heading";
import { ScoreRing } from "./score-ring";
import { RING_GRADIENT, TILE_HUE, type RingHue } from "./ring-hues";
import type { DerivedBatchRead } from "./use-derived-metric";
import type { ScoreBand } from "./band-tokens";
// Type-only — the compute payloads never drag the server graph into the bundle.
import type { ReadinessValue } from "@/lib/insights/derived/readiness";
import type { SleepScoreValue } from "@/lib/insights/derived/sleep-score";
import type { WellnessScoreValue } from "@/lib/insights/derived/wellness-scores";

/**
 * v1.10.0 — the wellness-scores strip.
 *
 * A row of score rings for the composite + persisted wellness scores, each
 * data-availability-gated: a score the user has no data for simply does not
 * render (never an apologetic empty ring). All five composites/scores now
 * route to a `ScoreAnatomyView` detail page (`/insights/scores/<slug>`) so
 * every ring carries its inputs + method + cited standard one tap away — the
 * three persisted scores (Recovery, Stress, Strain) are no longer read-only
 * dead-ends. The band word renders under each ring so a less-technical user
 * reads "low 62", not a bare reddish 62.
 *
 * Every ring reads from the ONE batched `/api/insights/derived/batch`
 * request the parent dashboard owns (passed in via `read`) — no per-ring
 * request, no cold-mount fan-out. The reads are already-computed
 * rollup/persisted values; nothing warms on visit.
 */

// The tile's history line loads through the shared chart-runtime boundary, so
// the strip carries no recharts in its own chunk. The tile owns the fixed
// 40 px band, so the async gap paints an empty band of the same size.
const DeltaSparkline = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.DeltaSparkline,
    })),
  { ssr: false, loading: () => null },
);

interface ScoreStripProps {
  /** The batched-read selector from the parent dashboard's one query. */
  read: DerivedBatchRead;
  isLoading: boolean;
  /**
   * The shared derived-batch error flag. On a failed batch the strip renders
   * a compact error + Retry in place instead of vanishing silently (the strip
   * is now top-of-page, so its only Retry must live here, not far below in the
   * Vitals slot).
   */
  isError?: boolean;
  /** Refetch the one shared batch query. Recovers both strips at once. */
  refetch?: () => void;
  /**
   * An optional extra tile rendered as the LAST sibling inside the same scores
   * grid (e.g. the gated cycle ring). It participates in the column-count math
   * so it never leaves a dangling empty cell, and it keeps the strip mounted
   * even when no wellness score has data (a cycle-only account still sees its
   * dial). The caller owns the gating — the strip just slots whatever it gets.
   * The element is expected to render `null` on its own when it has nothing to
   * show, so the strip subtracts it from the count in that case.
   */
  extraTile?: React.ReactNode;
  /**
   * Drop the Strain score tile from the rendered strip. Set when the cycle ring
   * takes Strain's slot (cycle-tracking accounts) so the row stays compact at
   * the same column count instead of growing a sixth tile. Strain stays
   * available for non-cycle accounts; it is only hidden, never removed.
   */
  hideStrain?: boolean;
  className?: string;
}

/** Mean of the trailing series excluding the newest point = "your normal". */
function baselineOf(series: number[] | undefined): number | null {
  if (!series || series.length < 3) return null;
  const past = series.slice(0, -1); // exclude today (newest)
  if (past.length === 0) return null;
  const mean = past.reduce((sum, v) => sum + v, 0) / past.length;
  return Number.isFinite(mean) ? mean : null;
}

/** A score ring wrapped in a link to its anatomy detail page. */
function RingTile({
  score,
  band,
  label,
  bandWord,
  href,
  metricSlot,
  hue,
  icon,
  index,
  animate,
  baseline,
  history,
}: {
  /**
   * v1.42 — the score's course (oldest → newest) and the window it covers,
   * drawn under the band word so each tile shows where the number came from.
   * Fewer than two points draws nothing.
   */
  history?: { series: number[]; windowDays: number } | null;
  score: number;
  band: ScoreBand;
  label: string;
  bandWord: string;
  href: string;
  metricSlot: string;
  hue: RingHue;
  icon: ComponentType<{ className?: string }>;
  /** Position in the rendered strip — drives the left-to-right stagger. */
  index: number;
  /** Whether the once-per-session reveal plays (false = paint final). */
  animate: boolean;
  /** "Your normal" reference for the ghost arc, or null when no series. */
  baseline: number | null;
}) {
  const Icon = icon;
  const delayMs = index * 75;
  return (
    <Link
      href={href}
      data-slot="wellness-score-tile"
      data-metric={metricSlot}
      // v1.14.0 — gentle, hero-family `.wellness-tile`: a low-opacity mix of
      // the metric's `--tile-hue` over the theme `--card`, with a faint film
      // grain (::after) for material depth. The per-metric `hue` arc is the
      // only saturated thing on the tile. On a fresh session the tile rises +
      // fades in staggered (`wellness-tile-rise` + `--reveal-delay`), gated by
      // the strip's `data-revealed`; the band stays conveyed by the word below
      // + the ring's `data-band` + aria-label.
      style={
        {
          "--tile-hue": TILE_HUE[hue],
          "--reveal-delay": `${delayMs}ms`,
        } as React.CSSProperties
      }
      className={cn(
        "wellness-tile focus-visible:ring-ring flex flex-col gap-4 rounded-xl p-4 focus-visible:ring-2 focus-visible:outline-none md:p-6",
        animate && "wellness-tile-rise",
      )}
    >
      <div className="text-foreground flex items-center gap-2">
        <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span className="truncate text-base leading-none font-semibold">
          {label}
        </span>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        {/* The ring keeps just the number centred; the metric name lives in
            the header above. The per-metric `hue` gradient leans the arc
            colour; the band stays conveyed by the word label below + the
            ring's `data-band` + aria-label. */}
        <ScoreRing
          score={score}
          band={band}
          size="sm"
          hue={hue}
          animate={animate}
          delayMs={delayMs}
          baseline={baseline}
        />
        <span
          data-slot="wellness-score-band-word"
          className="text-muted-foreground text-center text-xs"
        >
          {bandWord}
        </span>
      </div>
      {history && history.series.length >= 2 ? (
        <ScoreHistoryLine
          series={history.series}
          windowDays={history.windowDays}
          strokeVar={RING_GRADIENT[hue][1]}
        />
      ) : null}
    </Link>
  );
}

/**
 * The tile's history: a fixed 40 px line of the score over its window, with
 * the window named beneath it. Decorative to assistive tech — the tile's link
 * leads to the detail page, where the full course is readable.
 */
function ScoreHistoryLine({
  series,
  windowDays,
  strokeVar,
}: {
  series: number[];
  windowDays: number;
  strokeVar: string;
}) {
  const { t } = useTranslations();
  return (
    <div data-slot="wellness-score-history" className="space-y-1">
      <div className="h-10 w-full" aria-hidden="true">
        <DeltaSparkline
          data={series.map((v, i) => ({ i, v }))}
          strokeVar={strokeVar}
          domain={[0, 100]}
        />
      </div>
      <p className="text-muted-foreground text-center text-xs">
        {t("insights.derived.scores.historyWindow", { days: windowDays })}
      </p>
    </div>
  );
}

/** The course a score value carries, if any, paired with its window. */
function historyOf(
  read: {
    value: { series?: number[] } | null;
    provenance: { windowDays: number };
  } | null,
): { series: number[]; windowDays: number } | null {
  const series = read?.value?.series;
  if (!read || !series || series.length < 2) return null;
  return { series, windowDays: read.provenance.windowDays };
}

/**
 * Loading placeholder mirroring `RingTile`'s footprint (icon+label row, the
 * `size="sm"` 120 px ring, band word) so the strip reserves its final height
 * while the shared derived batch loads — matching the `VitalsTileSkeleton`
 * pattern instead of the strip vanishing (`return null`) and popping in once
 * data resolves. Decorative — `aria-hidden`.
 */
function WellnessScoreTileSkeleton() {
  return (
    <div
      data-slot="wellness-score-tile-skeleton"
      aria-hidden="true"
      className="bg-card border-border flex flex-col gap-4 rounded-xl border p-4 md:p-6"
    >
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-5 rounded" />
        <Skeleton className="h-4 w-20" />
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <Skeleton className="size-[120px] rounded-full" />
        <Skeleton className="h-3 w-12" />
      </div>
      {/* The history line's band, so a tile that gains one does not grow. */}
      <div className="space-y-1">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="mx-auto h-3 w-20" />
      </div>
    </div>
  );
}

export function WellnessScores({
  read,
  isLoading,
  isError = false,
  refetch,
  extraTile,
  hideStrain = false,
  className,
}: ScoreStripProps) {
  const { t } = useTranslations();

  // The signature reveal plays ONCE per browser session. A background
  // Apple-Health-sync refetch re-renders this strip repeatedly (the v1.8.7
  // lesson — sync evicted the derived cache all day); replaying the cascade on
  // every refetch would read as cheap + janky. The sessionStorage flag is set
  // on the first Insights visit; subsequent mounts paint the final state with
  // no stagger/sweep/sheen. Lazily computed once on the client (the strip only
  // renders after the client-side batch resolves, so there is no SSR tile to
  // mismatch).
  const [play] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      if (sessionStorage.getItem("wellness-strip-revealed")) return false;
      sessionStorage.setItem("wellness-strip-revealed", "1");
      return true;
    } catch {
      return true;
    }
  });

  // While the shared derived batch loads, every per-score gate below is
  // `!isLoading && …`, so `tiles` stays empty and the strip used to
  // `return null` — a late pop-in that pushed the briefing + everything
  // below it down on every cold visit. Render the section heading + a row
  // of tile-shaped skeletons instead, the same shape `VitalsDashboard`
  // already uses for its grid.
  if (isLoading) {
    return (
      <section
        data-slot="wellness-scores"
        aria-label={t("insights.derived.scores.sectionTitle")}
        className={cn("space-y-3", className)}
      >
        <SectionHeading
          icon={Activity}
          title={t("insights.derived.scores.sectionTitle")}
          subtitle={t("insights.derived.scores.sectionSubtitle")}
        />
        <div
          data-slot="wellness-scores-grid"
          // `aria-label` needs a role to name; a bare <div> may not carry one
          // (axe: aria-prohibited-attr). `status` is the loading region's
          // role and already implies the polite live region.
          role="status"
          aria-busy="true"
          aria-live="polite"
          aria-label={t("insights.derived.scores.loadingLabel")}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
        >
          {Array.from({ length: 5 }).map((_, i) => (
            <WellnessScoreTileSkeleton key={`wellness-skeleton-${i}`} />
          ))}
        </div>
      </section>
    );
  }

  // A failed shared batch must read as an error, not as "no scores" — the
  // strip is top-of-page, so the only Retry lives here (mirrors the Vitals
  // error card styling; one Retry recovers both strips).
  if (isError) {
    return (
      <section
        data-slot="wellness-scores"
        aria-label={t("insights.derived.scores.sectionTitle")}
        className={cn("space-y-3", className)}
      >
        <SectionHeading
          icon={Activity}
          title={t("insights.derived.scores.sectionTitle")}
          subtitle={t("insights.derived.scores.sectionSubtitle")}
        />
        <div
          data-slot="wellness-scores-error"
          role="alert"
          className="bg-card border-border text-muted-foreground flex flex-col items-start gap-3 rounded-xl border p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span>{t("insights.derived.scores.loadError")}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => refetch?.()}
            data-slot="wellness-scores-retry"
            className="gap-1.5"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t("common.retry")}</span>
          </Button>
        </div>
      </section>
    );
  }

  const readiness = read<ReadinessValue>({ metric: "READINESS" });
  const sleep = read<SleepScoreValue>({ metric: "SLEEP_SCORE" });
  const recovery = read<WellnessScoreValue>({ metric: "RECOVERY_SCORE" });
  const stress = read<WellnessScoreValue>({ metric: "STRESS_SCORE" });
  const strain = read<WellnessScoreValue>({ metric: "STRAIN_SCORE" });

  const bandWord = (band: ScoreBand) =>
    t(`insights.derived.scoreRing.band.${band}`);

  const tiles: React.ReactNode[] = [];

  if (!isLoading && readiness?.status === "ok" && readiness.value) {
    tiles.push(
      <RingTile
        key="READINESS"
        score={readiness.value.score}
        band={readiness.value.band}
        label={t("insights.derived.composite.READINESS.title")}
        bandWord={bandWord(readiness.value.band)}
        href="/insights/scores/readiness"
        metricSlot="READINESS"
        hue="readiness"
        icon={Gauge}
        history={historyOf(readiness)}
        index={tiles.length}
        animate={play}
        baseline={null}
      />,
    );
  }
  if (!isLoading && recovery?.status === "ok" && recovery.value) {
    tiles.push(
      <RingTile
        key="RECOVERY_SCORE"
        score={recovery.value.score}
        band={recovery.value.band}
        label={t("insights.derived.scores.recovery")}
        bandWord={bandWord(recovery.value.band)}
        href="/insights/scores/recovery"
        metricSlot="RECOVERY_SCORE"
        hue="recovery"
        icon={HeartPulse}
        history={historyOf(recovery)}
        index={tiles.length}
        animate={play}
        baseline={baselineOf(recovery.value.series)}
      />,
    );
  }
  if (!isLoading && sleep?.status === "ok" && sleep.value) {
    tiles.push(
      <RingTile
        key="SLEEP_SCORE"
        score={sleep.value.score}
        band={sleep.value.band}
        label={t("insights.derived.composite.SLEEP_SCORE.title")}
        bandWord={bandWord(sleep.value.band)}
        href="/insights/scores/sleep"
        metricSlot="SLEEP_SCORE"
        hue="sleep"
        icon={Moon}
        history={historyOf(sleep)}
        index={tiles.length}
        animate={play}
        baseline={null}
      />,
    );
  }
  if (!isLoading && stress?.status === "ok" && stress.value) {
    tiles.push(
      <RingTile
        key="STRESS_SCORE"
        score={stress.value.score}
        band={stress.value.band}
        label={t("insights.derived.scores.stress")}
        bandWord={bandWord(stress.value.band)}
        href="/insights/scores/stress"
        metricSlot="STRESS_SCORE"
        hue="stress"
        icon={Activity}
        history={historyOf(stress)}
        index={tiles.length}
        animate={play}
        baseline={baselineOf(stress.value.series)}
      />,
    );
  }
  // When the cycle ring takes the slot (cycle-tracking accounts), the Strain
  // tile is dropped so the row stays compact rather than growing a sixth tile.
  // Strain renders normally for everyone else.
  if (!hideStrain && !isLoading && strain?.status === "ok" && strain.value) {
    tiles.push(
      <RingTile
        key="STRAIN_SCORE"
        score={strain.value.score}
        band={strain.value.band}
        label={t("insights.derived.scores.strain")}
        bandWord={bandWord(strain.value.band)}
        href="/insights/scores/strain"
        metricSlot="STRAIN_SCORE"
        hue="strain"
        icon={Flame}
        history={historyOf(strain)}
        index={tiles.length}
        animate={play}
        baseline={baselineOf(strain.value.series)}
      />,
    );
  }

  // The optional caller-supplied tile (e.g. the gated cycle ring) slots in as
  // the last sibling. It is counted toward the grid column math so it never
  // leaves a dangling cell, and its presence keeps the strip mounted even when
  // no wellness score has data (a cycle-only account still sees its dial). The
  // tile renders `null` on its own when it has nothing to show; the grid has
  // no background, so a transient empty trailing cell shows nothing — never a
  // "missing tile" frame.
  if (extraTile != null) {
    tiles.push(
      <div
        key="EXTRA"
        data-slot="wellness-extra-tile-slot"
        className="contents"
      >
        {extraTile}
      </div>,
    );
  }

  // Whole strip un-mounts when no score has data AND no extra tile — never an
  // empty section.
  if (tiles.length === 0) return null;

  // v1.12.4 — the strip used a fixed `lg:grid-cols-5`, so the common case of
  // four active scores left one empty cell on the right and read as "a tile
  // is missing". Track the desktop column count to the actual number of tiles
  // (capped at 5) so the row always fills its full width. The static class
  // map keeps every variant in the Tailwind output (no purge surprise).
  const LG_COLS: Record<number, string> = {
    1: "lg:grid-cols-1",
    2: "lg:grid-cols-2",
    3: "lg:grid-cols-3",
    4: "lg:grid-cols-4",
    5: "lg:grid-cols-5",
  };
  const lgCols = LG_COLS[Math.min(tiles.length, 5)] ?? "lg:grid-cols-5";
  // The sm/md row caps at 3 columns; track the actual tile count there too so
  // two or four active scores don't leave an empty cell that reads as a
  // missing tile (the same fill rule the lg row already follows).
  const SM_COLS: Record<number, string> = {
    1: "sm:grid-cols-1",
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
  };
  const smCols = SM_COLS[Math.min(tiles.length, 3)] ?? "sm:grid-cols-3";

  return (
    <section
      data-slot="wellness-scores"
      aria-label={t("insights.derived.scores.sectionTitle")}
      className={cn("space-y-3", className)}
    >
      <SectionHeading
        icon={Activity}
        title={t("insights.derived.scores.sectionTitle")}
        subtitle={t("insights.derived.scores.sectionSubtitle")}
      />
      <div
        data-slot="wellness-scores-grid"
        // `data-revealed` triggers the CSS tile-rise + sheen keyframes on the
        // fresh-session reveal; absent on subsequent mounts (paint final).
        data-revealed={play ? "true" : undefined}
        className={cn("grid grid-cols-2 gap-3", smCols, lgCols)}
      >
        {tiles}
      </div>
    </section>
  );
}
