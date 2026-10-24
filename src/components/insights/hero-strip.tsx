"use client";

import { Sparkles } from "lucide-react";
import {
  useTranslations,
  useFormatters,
  useDisplayTimezone,
} from "@/lib/i18n/context";
import { formatUpdatedLabel } from "@/lib/i18n/relative-time";
import { useAuth } from "@/hooks/use-auth";
import { hourInTz, DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { ProseBlocks } from "@/components/insights/prose-blocks";
import {
  HealthScoreCard,
  HealthScoreCardSkeleton,
  type ReadinessContributorKey,
} from "@/components/insights/health-score-card";
import { cn } from "@/lib/utils";
import type { DailyBriefing as DailyBriefingPayload } from "@/lib/ai/schema";
import type { HealthScoreReport, ScoreBand } from "@/lib/analytics/score/types";

/**
 * Insights redesign hero strip.
 *
 * The wider band lifted from the design handoff
 * (`prototype/artboard-fullpage.jsx → BriefingHero`):
 *
 *   - locale-aware time-of-day greeting line ("Good morning, …" /
 *     "Guten Morgen, …") + a narrative subtitle (the briefing
 *     paragraph when one is cached, else a fallback)
 *   - personal-baseline + "Generated <relative-time>" meta row
 *   - Dracula gradient + soft purple glow via the new `.hero-gradient`
 *     + `.glow-purple` utilities in `globals.css`
 *
 * v1.18.7 — the overview "Ask the coach" action row + guided-questions
 * chip strip were removed from the band. The Coach lives in the
 * bottom-right drawer (mounted by the insights layout shell); the
 * overview now leads with the present-focused daily briefing, not a
 * coach prompt.
 *
 * The Health Score is back in the band's right column, where it lived for
 * eleven weeks. It is the score's ONLY mount on the overview — there is no
 * second card below the greeting any more. The band splits into two columns
 * from `md` up, and only when there is a score (or one on its way): an
 * account without a score keeps the full-width greeting exactly as it is.
 * Below `md` the panel stacks under the greeting at full width.
 *
 * Pure presentational — the page owns the briefing and the score data.
 */

interface HeroStripProps {
  /** Briefing payload — its paragraph drives the hero subtitle. */
  briefing: DailyBriefingPayload | null;
  /** ISO timestamp of the freshest cached payload. */
  updatedAt?: string | null;
  /**
   * Display name for the greeting; defaults to no-name greeting
   * ("Good morning,") when omitted so the hero never paints "Good
   * morning, undefined".
   */
  userName?: string | null;
  /**
   * Now() override for tests so the greeting bucket is deterministic.
   * Defaults to `new Date()`. Production callers omit this.
   */
  now?: Date;
  /**
   * The Health Score report. Non-null paints the right column; null with
   * `scorePending` paints the reserve; null without it keeps the band
   * full-width, which is the shape an account without a score already had.
   */
  healthScore?: HealthScoreReport | null;
  /** True while the analytics payload is in flight and nothing is cached. */
  scorePending?: boolean;
  /** Server-resolved Tension Verdict, forwarded to the panel. */
  tension?: {
    band: ScoreBand;
    positive: ReadinessContributorKey[];
    negative: ReadinessContributorKey[];
  } | null;
  /** Server-resolved return-to-baseline, forwarded to the panel. */
  returnToBand?: { metricType: string; daysInside: number } | null;
  /** Retry for a pillar whose read failed — refetches the whole payload. */
  onScoreRetry?: () => void;
}

/**
 * Bucketed time-of-day greeting:
 *   05:00–11:59 → morning
 *   12:00–17:59 → afternoon
 *   18:00–22:59 → evening
 *   23:00–04:59 → night (mapped to "evening" for both locales — it's
 *                        rare to see /insights at 03:00 and "Guten
 *                        Morgen" pre-5am reads odd)
 */
function resolveGreetingKey(hour: number): string {
  if (hour >= 5 && hour < 12) return "insights.heroGreetingMorning";
  if (hour >= 12 && hour < 18) return "insights.heroGreetingAfternoon";
  // 18:00-22:59 maps to "Good evening"; 23:00-04:59 also maps to
  // "Good evening" — reading "Good morning" pre-5am felt off, and
  // German has the same fall-through. Drop the duplicate Night key.
  return "insights.heroGreetingEvening";
}

export function HeroStrip({
  briefing,
  updatedAt,
  userName,
  now,
  healthScore = null,
  scorePending = false,
  tension = null,
  returnToBand = null,
  onScoreRetry,
}: HeroStripProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  // Issue #490 — the SAME resolved zone `fmt.time` renders in (mirror →
  // Berlin), so the today/yesterday boundary and the clock can never split.
  const displayTz = useDisplayTimezone();

  // Greeting hour in the user's configured zone, not the browser's — a
  // traveller / VPN user / wrong device clock otherwise sees the wrong
  // salutation. Mirrors the dashboard hero (`hourInTimezone(now, userTz)`).
  const greetingHour = hourInTz(
    now ?? new Date(),
    user?.timezone ?? DEFAULT_TIMEZONE,
  );
  const greetingKey = resolveGreetingKey(greetingHour);
  const greetingBase = t(greetingKey);
  const greeting = userName ? `${greetingBase}, ${userName}` : greetingBase;
  const subtitle = briefing?.paragraph ?? t("insights.heroFallbackSubtitle");
  // v1.22 — calendar-bucketed freshness label ("Updated today, HH:MM" /
  // "yesterday" / "on DD.MM."), matching the briefing + per-metric cards so the
  // hero no longer reads relative while the cards below it read absolute. The
  // day boundary follows the user's profile timezone.
  // The caption dates the SUBTITLE, so it shows only when the subtitle is a
  // briefing. The cache stamp moves on every warm, including one that keeps
  // yesterday's text, which the read then withholds: without a briefing it
  // put "Updated today" under the generic fallback sentence.
  const generatedLine =
    briefing && updatedAt
      ? formatUpdatedLabel(updatedAt, t, fmt.dateShort, fmt.time, displayTz)
      : null;

  return (
    <div
      data-slot="insights-hero-strip"
      className={cn(
        "hero-gradient glow-purple animate-insight-in",
        // `isolate` creates a new stacking context so the purple glow
        // box-shadow stays z-trapped inside the hero band — without
        // it the shadow bled through the sticky section nav below
        // (the nav uses bg-background/80 + backdrop-blur, which the
        // shadow leaked through).
        "relative isolate overflow-hidden rounded-xl px-4 py-4 md:px-6 md:py-6",
      )}
    >
      {/* Two columns from `md` up, and only when the score column has
          something to show. Without a score the band stays one column, which
          is the shape it already had for an account that has none. */}
      <div
        className={cn(
          "flex min-w-0 flex-col gap-4",
          (healthScore || scorePending) &&
            "md:flex-row md:items-stretch md:gap-6",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-center gap-2">
            {/* Header glyph stays in the foreground tier — ui-standards.md §1
                  reserves primary/accent for actions, not decorative header
                  icons. */}
            <Sparkles
              className="text-foreground h-5 w-5 shrink-0"
              aria-hidden="true"
            />
            <h1
              data-slot="insights-hero-strip-greeting"
              className="text-2xl leading-tight font-bold tracking-tight sm:text-3xl"
            >
              {greeting}
            </h1>
          </div>
          {/* v1.22 — the briefing paragraph renders through ProseBlocks
                so a multi-paragraph verdict-first briefing shows real paragraph
                spacing (still plain text children, no markdown). */}
          <div
            data-slot="insights-hero-strip-subtitle"
            className="text-foreground max-w-3xl text-sm"
          >
            <ProseBlocks text={subtitle} />
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {/* The baseline line describes where the SUBTITLE came from, so it
                may only show when the subtitle IS a briefing. Without one the
                subtitle falls back to generic copy derived from nothing, and
                this line went on claiming a personal baseline underneath it —
                the one part of the row that was ungated while both its
                siblings already checked for their own data first. */}
            {briefing && (
              <span data-slot="insights-hero-strip-baseline">
                {t("insights.heroPersonalBaseline")}
              </span>
            )}
            {generatedLine && (
              <>
                <span aria-hidden="true" className="opacity-50">
                  ·
                </span>
                <span data-slot="insights-hero-strip-generated">
                  {generatedLine}
                </span>
              </>
            )}
          </div>
        </div>

        {/*
         * v1.18.7 — the overview "Ask the coach" action row + the
         * guided-questions chip strip were removed from the hero band.
         * The Coach is the bottom-right drawer (mounted in the insights
         * layout shell); the overview leads with the present-focused
         * daily briefing, not a coach prompt. The drawer itself is
         * untouched — only the hero entry points are gone, so the band
         * is now greeting + subtitle + baseline meta.
         */}

        {/* The score column. The reserve holds the column's footprint while
            the payload is in flight so the greeting beside it does not shift
            when the score lands. Both wear the same width classes. */}
        {healthScore ? (
          <HealthScoreCard
            report={healthScore}
            tension={tension}
            returnToBand={returnToBand}
            onRetry={onScoreRetry}
          />
        ) : scorePending ? (
          <HealthScoreCardSkeleton />
        ) : null}
      </div>
    </div>
  );
}
