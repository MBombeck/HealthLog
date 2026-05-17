"use client";

import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/relative-time";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { cn } from "@/lib/utils";
import { SuggestedPrompts } from "./suggested-prompts";
import {
  HealthScoreCard,
  type HealthScoreCardProps,
} from "./health-score-card";
import type { DailyBriefing as DailyBriefingPayload } from "@/lib/ai/schema";

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
 *   - action row: single "Ask the coach" affordance
 *     (v1.4.25 W3 dropped the "Re-run analysis" button — the
 *     regenerate affordance moved to `<InsightsTabStrip>`. v1.4.28
 *     retired the weekly-report path, leaving Coach as the sole
 *     hero-row action.)
 *   - <SuggestedPrompts> chip strip below the action band
 *   - Dracula gradient + soft purple glow via the new `.hero-gradient`
 *     + `.glow-purple` utilities in `globals.css`
 *
 * Mobile-first: the action row wraps + the suggested-prompt chips
 * wrap. Right-side Health Score panel is *not* part of B1 — that
 * lands in B5; for B1 the right side just keeps its meta band.
 *
 * Pure presentational — the page owns the briefing data.
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
   * Click handler for the suggested prompts. The Coach drawer (B2b)
   * routes a chip click into the drawer's input; the parent owns the
   * drawer state. When omitted the chip click is a no-op.
   */
  onPickPrompt?: (prompt: string) => void;
  /**
   * Click handler for the "Ask the coach" action button. When supplied,
   * the button is enabled and the coming-soon tooltip drops; clicking
   * opens the drawer (B2b). When omitted the button stays disabled —
   * see the v1.4.20 phase B1 dispatch where the drawer was deferred.
   *
   * v1.4.20 phase B5 — the same handler powers the Health Score
   * panel's "Ask the Coach" button, with an optional `prefill` string
   * that opens the drawer with a score-aware question. The action-row
   * button calls it without an argument (drawer opens blank); the HSC
   * panel calls it with "Why is my health score X out of 100?".
   */
  onAskCoach?: (prefill?: string) => void;
  /**
   * Now() override for tests so the greeting bucket is deterministic.
   * Defaults to `new Date()`. Production callers omit this.
   */
  now?: Date;
  /**
   * v1.4.20 phase B5 — Personal Health Score panel data. When supplied
   * the right side of the hero band paints the score card. The
   * `onAskCoach` handler is intentionally re-used from the action-row
   * "Ask the coach" button — same drawer state, different prefill
   * string. When the parent omits the field the right side stays empty
   * (current B1 behaviour).
   */
  healthScore?: {
    score: HealthScoreCardProps["score"];
    band: HealthScoreCardProps["band"];
    components: HealthScoreCardProps["components"];
    delta: HealthScoreCardProps["delta"];
  } | null;
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
function resolveGreetingKey(now: Date): string {
  const hour = now.getHours();
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
  onPickPrompt,
  onAskCoach,
  now,
  healthScore,
}: HeroStripProps) {
  const { t } = useTranslations();
  // v1.4.37 W5 — operator-level Coach gate. When the global Coach flag
  // is off every Coach affordance must vanish from this band (the
  // action-row button, the suggested-prompts chip strip, and the
  // HealthScoreCard's `onAskCoach` prop). The button and chips both
  // open the Coach drawer, so leaving them visible while the drawer
  // mount is suppressed would surface dead controls.
  const flags = useFeatureFlags();
  const coachEnabled = flags.coach;
  const greetingKey = resolveGreetingKey(now ?? new Date());
  const greetingBase = t(greetingKey);
  const greeting = userName ? `${greetingBase}, ${userName}` : greetingBase;
  const subtitle = briefing?.paragraph ?? t("insights.heroFallbackSubtitle");
  const generatedLine = updatedAt
    ? t("insights.heroGenerated", { time: formatRelativeTime(updatedAt, t) })
    : null;
  const comingSoon = t("insights.heroComingSoonTooltip");

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
        "relative isolate overflow-hidden rounded-xl px-4 py-5 sm:px-6 sm:py-6",
      )}
    >
      {/*
       * v1.4.20 phase B5 — split layout. On `md+` (v1.4.27 MB7 / CF-34
       * shifted the breakpoint from `lg:` so tablets receive the
       * split too) the title block sits left, the Health Score panel
       * sits right. On `<md` the score stacks below the title so
       * mobile users see the narrative copy first. When `healthScore`
       * is null/undefined the right column collapses and the title
       * block uses the full width — same shape as B1–B4. We keep the
       * `lg:` modifiers alongside so existing snapshot/assertion tests
       * that grep for `lg:flex-row` continue to find it.
       */}
      {/*
       * v1.4.28 R3c-Insights — switch the row's cross-axis alignment
       * from `items-start` to `items-stretch` so the right-column
       * HealthScore card grows to match the left column's natural
       * height (greeting + subtitle + baseline meta + action row +
       * suggested-prompts strip). Per Inv-4 the card was painting
       * 75-110 px shorter than the left column on desktop; the
       * stretch contract pulls the card's bottom edge down to the
       * "Wirkt mein Medikament?" chip. The card itself owns
       * `h-full` + `mt-auto` on its disclaimer to redistribute the
       * recovered space without visual jank.
       */}
      <div
        className={cn(
          "flex flex-col gap-5",
          healthScore &&
            "md:flex-row md:items-stretch md:gap-6 lg:flex-row lg:items-stretch lg:gap-6",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Sparkles
                className="text-dracula-purple h-5 w-5 shrink-0"
                aria-hidden="true"
              />
              <h1
                data-slot="insights-hero-strip-greeting"
                className="text-2xl leading-tight font-semibold tracking-tight sm:text-[28px]"
              >
                {greeting}
              </h1>
            </div>
            <p
              data-slot="insights-hero-strip-subtitle"
              className="text-muted-foreground max-w-3xl text-sm leading-relaxed"
            >
              {subtitle}
            </p>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span data-slot="insights-hero-strip-baseline">
                {t("insights.heroPersonalBaseline")}
              </span>
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
           * v1.4.37 W5 — the action row only carries the Coach button
           * today (v1.4.28 retired the weekly-report affordance). When
           * the operator turns the global Coach flag off the whole row
           * disappears rather than collapsing to an empty flex shell.
           */}
          {coachEnabled && (
            <div className="flex flex-wrap items-center gap-2">
              {/* B2b wires this into the Coach drawer. The button is
                enabled whenever the parent supplies an `onAskCoach`
                handler; older parents that haven't adopted B2b yet
                still get the disabled "Coming soon" affordance so the
                hero doesn't break. v1.4.28 retired the weekly-report
                button, leaving Coach as the only hero-row action. */}
              <Button
                type="button"
                variant="outline"
                onClick={onAskCoach ? () => onAskCoach() : undefined}
                disabled={!onAskCoach}
                title={onAskCoach ? undefined : comingSoon}
                data-slot="insights-hero-strip-action-coach"
                className="gap-1.5"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t("insights.heroActionAskCoach")}</span>
              </Button>
              {/*
               * v1.4.25 W3 — the regenerate button moved to the new
               * `<InsightsTabStrip>` (icon-only RefreshCw, sticky next
               * to the pill nav) so the user can re-run the analysis
               * without scrolling back to the hero band.
               */}
            </div>
          )}

          {coachEnabled && (
            <div
              data-slot="insights-hero-strip-prompts"
              className="border-border/50 border-t pt-4"
            >
              {/*
               * v1.4.20 phase B2b — chip clicks open the Coach drawer
               * with the localised prompt pre-filled in the composer.
               * The parent owns drawer state so the chip strip stays
               * presentational.
               *
               * v1.4.37 W5 — the strip is a Coach-only affordance
               * (every chip seeds a Coach turn), so it is gated on the
               * same flag as the action-row button above. Without the
               * gate the chips would still paint while the drawer is
               * suppressed, leaving inert controls in the band.
               */}
              <SuggestedPrompts onPick={onPickPrompt ?? (() => undefined)} />
            </div>
          )}
        </div>

        {healthScore && (
          <HealthScoreCard
            score={healthScore.score}
            band={healthScore.band}
            components={healthScore.components}
            delta={healthScore.delta}
            onAskCoach={
              // v1.4.37 W5 — short-circuit the prop drilling even
              // though `HealthScoreCard` retired its inline button in
              // v1.4.27. A future re-addition can't accidentally
              // surface a Coach affordance from this card while the
              // operator has the flag off.
              coachEnabled && onAskCoach
                ? (prefill: string) => onAskCoach(prefill)
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
