"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Activity, Flame, Gauge, HeartPulse, Moon } from "lucide-react";

import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { useAuth } from "@/hooks/use-auth";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { healthScoreSetterLine } from "@/lib/score-config/labels";
import { ScoreRing } from "./score-ring";
import { RING_GRADIENT, TILE_HUE, type RingHue } from "./ring-hues";
import type { DerivedBatchRead } from "./use-derived-metric";
import {
  scoreBandWordKey,
  scoreOriginLabelKey,
  type ScoreBand,
} from "./band-tokens";
// Type-only — the compute payloads never drag the server graph into the bundle.
import type { ReadinessValue } from "@/lib/insights/derived/readiness";
import type { SleepScoreValue } from "@/lib/insights/derived/sleep-score";
import type { WellnessScoreValue } from "@/lib/insights/derived/wellness-scores";
import type { HealthScoreReport } from "@/lib/analytics/score/types";
import { TileHeader } from "@/components/insights/tile-header";
import { Card } from "@/components/ui/card";
import { TagChip } from "@/components/ui/tag-chip";
import { metricHref } from "@/lib/links/hrefs";

/**
 * The score rings at the head of Insights: Readiness ("today"), Sleep score
 * ("last night"), the Health score ("the long view"), then Stress and Strain,
 * in that order, above every customisable section. Every 0..100 score wears
 * the same tile; whose number it is (an estimate, a device's value) is a
 * label on the tile from the server's `origin`, not a section of its own.
 *
 * Not a section on purpose. A section id a saved layout has hidden would
 * take the rings with it, and a layout that has never seen an id merges it
 * in as hidden; the Health score has lived outside the sections for that
 * reason since it moved onto this page. Each ring opens its anatomy page,
 * the Health score's carries the full panel unchanged.
 *
 * A readiness that rests on values from before today is not a statement
 * about today: its ring shows the bare track, no number, no band and no
 * sentence, and below it "Last 81 on Nov 24". A pillar a questionnaire
 * answer withholds is said on the Health score's page, not on its tile.
 *
 * Readiness and the sleep score read from the ONE batched derived request
 * the page owns; the Health score from the analytics payload the page
 * already holds. Nothing warms on visit.
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

/** The Health score's course on its tile, the window its page opens on. */
const HEALTH_HISTORY_DAYS = 30;

/** Mean of the trailing series excluding the newest point = "your normal". */
export function baselineOf(series: number[] | undefined): number | null {
  if (!series || series.length < 3) return null;
  const past = series.slice(0, -1); // exclude today (newest)
  if (past.length === 0) return null;
  const mean = past.reduce((sum, v) => sum + v, 0) / past.length;
  return Number.isFinite(mean) ? mean : null;
}

/**
 * One score tile: the ring with its band word, an optional note and the
 * score's course, all one link to the score's page. On a phone the ring sits
 * beside its text; from `md` up the tile stacks.
 */
export function RingTile({
  score,
  band,
  label,
  bandWord,
  note,
  ariaLabel,
  href,
  metricSlot,
  hue,
  icon,
  index,
  animate,
  baseline,
  history,
  titleAs = "h2",
  originLabel = null,
}: {
  /** The 0..100 score; null draws the bare track (see `note`). */
  score: number | null;
  band?: ScoreBand;
  label: string;
  /** The band word under the ring; null when the score carries no band. */
  bandWord: string | null;
  /** One line beside or under the ring ("Last 81 on Nov 24"). */
  note?: ReactNode;
  /**
   * The ring's accessible name, when its default ("score, band word") would
   * say the wrong thing: a ring without a number, or a load.
   */
  ariaLabel?: string;
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
  /**
   * The score's course (oldest → newest) and the window it covers. Fewer
   * than two points draws nothing.
   */
  history?: { series: number[]; windowDays: number } | null;
  /** The tile title's heading level: `h3` inside a section with its own. */
  titleAs?: "h2" | "h3";
  /** Whose number it is ("Estimate", "Device value"), from `value.origin`. */
  originLabel?: string | null;
}) {
  const Icon = icon;
  const delayMs = index * 75;
  return (
    <Link
      href={href}
      data-slot="wellness-score-tile"
      data-metric={metricSlot}
      // The gentle `.wellness-tile` surface: a low-opacity mix of the
      // metric's `--tile-hue` over `--card`. The per-metric arc is the only
      // saturated thing on the tile; the band stays conveyed by the word
      // below and the ring's `data-band` + aria-label.
      style={
        {
          "--tile-hue": TILE_HUE[hue],
          "--reveal-delay": `${delayMs}ms`,
        } as React.CSSProperties
      }
      className={cn(
        "wellness-tile focus-visible:ring-ring flex flex-col gap-3 rounded-xl p-4 focus-visible:ring-2 focus-visible:outline-none md:gap-4 md:p-6",
        animate && "wellness-tile-rise",
      )}
    >
      <TileHeader
        icon={Icon}
        title={label}
        titleAs={titleAs}
        right={
          originLabel ? (
            <TagChip data-slot="wellness-score-origin">{originLabel}</TagChip>
          ) : undefined
        }
      />
      <div className="flex items-center gap-4 md:flex-col md:items-stretch">
        <div className="flex shrink-0 flex-col items-center gap-1.5">
          <ScoreRing
            score={score}
            // No band word means the score carries no band (a device's own
            // value): the ring is drawn neutral, never in a guessed band.
            band={bandWord === null ? null : band}
            size="tile"
            animate={animate}
            delayMs={delayMs}
            baseline={baseline}
            emptyFace={score === null && ariaLabel !== undefined}
            ariaLabel={ariaLabel}
          />
          {bandWord ? (
            <span
              data-slot="wellness-score-band-word"
              className="text-muted-foreground text-center text-xs"
            >
              {bandWord}
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {note ? (
            <p
              data-slot="wellness-score-note"
              className="text-foreground text-xs md:text-center"
            >
              {note}
            </p>
          ) : null}
          {history && history.series.length >= 2 ? (
            <ScoreHistoryLine
              series={history.series}
              windowDays={history.windowDays}
              strokeVar={RING_GRADIENT[hue][1]}
            />
          ) : null}
        </div>
      </div>
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
      <p className="text-muted-foreground text-xs md:text-center">
        {t("insights.scores.historyWindow", { days: windowDays })}
      </p>
    </div>
  );
}

/** The course a score value carries, if any, paired with its window. */
export function historyOf(
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
 * Loading placeholder in `RingTile`'s footprint, so the head reserves its
 * height while its reads land. Decorative — `aria-hidden`.
 */
function WellnessScoreTileSkeleton() {
  return (
    <Card
      data-slot="wellness-score-tile-skeleton"
      aria-hidden="true"
      className="gap-3 px-4 md:gap-4 md:px-6"
    >
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-5 rounded" />
        <Skeleton className="h-4 w-20" />
      </div>
      <div className="flex items-center gap-4 md:flex-col md:items-stretch">
        <div className="flex flex-col items-center gap-1.5">
          <Skeleton className="size-20 rounded-full md:size-30" />
          <Skeleton className="h-3 w-12" />
        </div>
        <div className="flex-1 space-y-1">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-3 w-20 md:mx-auto" />
        </div>
      </div>
    </Card>
  );
}

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

/** The Health score's daily course, the read its page's chart makes. */
function useHealthScoreCourse(enabled: boolean): number[] | null {
  const { isAuthenticated } = useAuth();
  const query = useQuery({
    queryKey: queryKeys.insightsScoreHistory(
      "HEALTH_SCORE",
      HEALTH_HISTORY_DAYS,
    ),
    queryFn: () => {
      const params = new URLSearchParams({
        score: "HEALTH_SCORE",
        days: String(HEALTH_HISTORY_DAYS),
      });
      return apiGet<{ points: Array<{ value: number }> }>(
        `/api/insights/score-history?${params.toString()}`,
      );
    },
    enabled: enabled && isAuthenticated,
    staleTime: 60_000,
    retry: 0,
  });
  const points = query.data?.points;
  return points ? points.map((p) => p.value) : null;
}

/**
 * The two day scores. One that is not about today (`fresh` false; an older
 * cached payload without the field keeps its ring) shows no number, no band
 * and no word, only "Last 81 on Nov 24".
 */
const DAY_SCORES = [
  { id: "READINESS", kind: "readiness", icon: Gauge },
  { id: "SLEEP_SCORE", kind: "sleep", icon: Moon },
] as const;

/** The two loads, after the Health score: a heavy one reads "high". */
const LOAD_SCORES = [
  { id: "STRESS_SCORE", kind: "stress", slug: "stress-score", icon: Activity },
  { id: "STRAIN_SCORE", kind: "strain", slug: "strain-score", icon: Flame },
] as const;

/**
 * A stress or strain tile, labelled by the server's `origin`. A strain the
 * device served (no computed strain yet) shows the device's own reading in
 * place of a band word.
 */
function loadTile(
  tile: (typeof LOAD_SCORES)[number],
  v: WellnessScoreValue,
  history: ReturnType<typeof historyOf>,
  ctx: {
    t: ReturnType<typeof useTranslations>["t"];
    fmt: ReturnType<typeof useFormatters>;
    index: number;
    play: boolean;
  },
): ReactNode {
  const { t, fmt } = ctx;
  const title = t(`insights.derived.scores.${tile.kind}`);
  const word = v.device ? null : t(scoreBandWordKey(tile.kind, v.band));
  const deviceLine = v.device
    ? t("insights.derived.composite.STRAIN_SCORE.deviceCaption", {
        value: fmt.number(v.device.value, 1),
        max: v.device.scaleMax,
      })
    : null;
  const originKey = scoreOriginLabelKey(v.origin);
  return (
    <RingTile
      key={tile.id}
      score={v.score}
      band={v.band}
      label={title}
      bandWord={word}
      note={deviceLine}
      ariaLabel={`${title}: ${v.score}, ${word ?? deviceLine}`}
      href={metricHref(tile.slug) ?? ""}
      metricSlot={tile.id}
      hue={tile.kind}
      icon={tile.icon}
      history={history}
      index={ctx.index}
      animate={ctx.play}
      baseline={baselineOf(v.series)}
      originLabel={originKey ? t(originKey) : null}
    />
  );
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
  const healthCourse = useHealthScoreCourse(healthScore !== null);

  // The reveal plays ONCE per browser session. A background sync refetch
  // re-renders the head repeatedly; replaying the cascade every time would
  // read as janky. The head only renders after the client-side batch
  // resolves (the page loads it without SSR), so there is no server tile to
  // mismatch.
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

  const regionLabel = t("insights.scores.regionLabel");

  if (isLoading || (healthPending && !healthScore)) {
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
          className="grid grid-cols-1 gap-3 md:grid-cols-3"
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <WellnessScoreTileSkeleton key={`wellness-skeleton-${i}`} />
          ))}
        </div>
      </section>
    );
  }

  const bandWord = (kind: "readiness" | "sleep" | "health", band: ScoreBand) =>
    t(scoreBandWordKey(kind, band));

  const tiles: ReactNode[] = [];

  for (const tile of DAY_SCORES) {
    const r = read<ReadinessValue | SleepScoreValue>({ metric: tile.id });
    if (r?.status !== "ok" || !r.value) continue;
    const v = r.value;
    const title = t(`insights.derived.composite.${tile.id}.title`);
    const stale = v.fresh === false;
    const lastLine = stale
      ? t("insights.scores.staleLast", {
          score: Math.round(v.score),
          date: fmt.dateShortSmartCalendar(
            "asOfDay" in v ? v.asOfDay : v.night,
          ),
        })
      : null;
    tiles.push(
      <RingTile
        key={tile.id}
        score={stale ? null : v.score}
        band={stale ? undefined : v.band}
        label={title}
        bandWord={stale ? null : bandWord(tile.kind, v.band)}
        note={lastLine}
        ariaLabel={stale ? `${title}. ${lastLine}` : undefined}
        href={`/insights/scores/${tile.kind}`}
        metricSlot={tile.id}
        hue={tile.kind}
        icon={tile.icon}
        history={historyOf(r)}
        index={tiles.length}
        animate={play}
        baseline={null}
      />,
    );
  }
  if (healthScore) {
    const composite = healthScore.composite;
    const ok = composite.status === "ok";
    // A pillar withheld for safety signposting says nothing on the tile: the
    // score page names it in one sentence with the way to support, and a
    // one-line slot would only make it sound like a fault.
    tiles.push(
      <RingTile
        key="HEALTH_SCORE"
        score={ok ? composite.value.score : null}
        band={ok ? composite.value.numberBand : undefined}
        label={t("insights.healthScore.label")}
        bandWord={ok ? bandWord("health", composite.value.numberBand) : null}
        note={healthScoreSetterLine(healthScore, t)}
        href="/insights/scores/health"
        metricSlot="HEALTH_SCORE"
        hue="health"
        icon={HeartPulse}
        history={
          healthCourse && healthCourse.length >= 2
            ? { series: healthCourse, windowDays: HEALTH_HISTORY_DAYS }
            : null
        }
        index={tiles.length}
        animate={play}
        baseline={null}
      />,
    );
  }

  for (const tile of LOAD_SCORES) {
    const r = read<WellnessScoreValue>({ metric: tile.id });
    if (r?.status === "ok" && r.value) {
      tiles.push(
        loadTile(tile, r.value, historyOf(r), {
          t,
          fmt,
          index: tiles.length,
          play,
        }),
      );
    }
  }

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

  // The row fills its width whatever the count: two scores take half each
  // rather than leaving an empty third cell that reads as a missing tile, and
  // four stand two by two so none hangs alone under three.
  const MD_COLS: Record<number, string> = {
    1: "md:grid-cols-1",
    2: "md:grid-cols-2",
    3: "md:grid-cols-3",
    4: "md:grid-cols-2",
  };

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
          // `data-revealed` triggers the CSS tile-rise keyframes on the
          // fresh-session reveal; absent on later mounts (paint final).
          data-revealed={play ? "true" : undefined}
          className={cn(
            "grid grid-cols-1 gap-3",
            MD_COLS[tiles.length] ?? MD_COLS[3],
          )}
        >
          {tiles}
        </div>
      ) : null}
    </section>
  );
}
