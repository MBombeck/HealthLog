"use client";

import Link from "next/link";
import { toast } from "sonner";
import { Download, FileText, Share2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/relative-time";
import { cn } from "@/lib/utils";
import { SuggestedPrompts } from "./suggested-prompts";
import {
  HealthScoreCard,
  type HealthScoreCardProps,
} from "./health-score-card";
import type { DailyBriefing as DailyBriefingPayload } from "@/lib/ai/schema";

/**
 * v1.4.20 phase B1 — Insights redesign hero strip.
 *
 * Replaces the v1.4.16 `<InsightsPageHero>` with the wider band from
 * the design handoff (`prototype/artboard-fullpage.jsx → BriefingHero`):
 *
 *   - locale-aware time-of-day greeting line ("Good morning, …" /
 *     "Guten Morgen, …") + a narrative subtitle (the briefing
 *     paragraph when one is cached, else a fallback)
 *   - personal-baseline + "Generated <relative-time>" meta row
 *   - action row: "Generate weekly report" + "Ask the coach"
 *     (v1.4.25 W3 dropped the third "Re-run analysis" button — the
 *     regenerate affordance moved to `<InsightsTabStrip>` so the user
 *     can re-run the analysis from any scroll position without
 *     returning to the hero band).
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
   * v1.4.20 phase B4 — when the cached AI payload carries a fresh
   * weeklyReport block, the parent passes this so the hero paints a
   * slim banner card ("Your Week N report is ready" with Read · Share
   * · Export PDF actions). Omit to hide the banner.
   */
  weeklyReportReady?: {
    weekISO: string;
    href: string;
  };
  /**
   * v1.4.20 phase D reconcile — href to the current week's report. When
   * supplied, the action-row "Generate weekly report" button becomes a
   * real link instead of the disabled placeholder. B4 shipped the
   * route, so the button should not paint as disabled-primary anymore.
   */
  weeklyReportHref?: string;
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
  weeklyReportReady,
  weeklyReportHref,
  now,
  healthScore,
}: HeroStripProps) {
  const { t } = useTranslations();
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
       * v1.4.20 phase B5 — split layout. On `lg+` the title block sits
       * left, the Health Score panel sits right. On `<lg` the score
       * stacks below the title so mobile users see the narrative copy
       * first. When `healthScore` is null/undefined the right column
       * collapses and the title block uses the full width — same shape
       * as B1–B4.
       */}
      <div
        className={cn(
          "flex flex-col gap-5",
          healthScore && "lg:flex-row lg:items-start lg:gap-6",
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

          {weeklyReportReady && (
            <WeeklyReportBanner
              weekISO={weeklyReportReady.weekISO}
              href={weeklyReportReady.href}
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            {/*
             * v1.4.20 phase B4 shipped /insights/report/[week]; phase D
             * reconcile enables this button as a real link to the
             * current ISO week. Older parents that haven't adopted the
             * weeklyReportHref prop still get the disabled affordance.
             */}
            {(() => {
              // v1.4.22 W5 reconcile (S-02) — collapse the
              // enabled/disabled twin Buttons (variant, size, slot,
              // class, icon, label all identical) into a single
              // shared structure with the Link wrapping conditionally.
              const weeklyLabel = (
                <>
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{t("insights.heroActionWeeklyReport")}</span>
                </>
              );
              return weeklyReportHref ? (
                <Button
                  asChild
                  variant="default"
                  size="sm"
                  data-slot="insights-hero-strip-action-weekly-report"
                  className="gap-1.5"
                >
                  <Link href={weeklyReportHref}>{weeklyLabel}</Link>
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled
                  title={comingSoon}
                  data-slot="insights-hero-strip-action-weekly-report"
                  className="gap-1.5"
                >
                  {weeklyLabel}
                </Button>
              );
            })()}
            {/* B2b wires this into the Coach drawer. The button is
              enabled whenever the parent supplies an `onAskCoach`
              handler; older parents that haven't adopted B2b yet
              still get the disabled "Coming soon" affordance so the
              hero doesn't break. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
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
             * without scrolling back to the hero band. The hero's
             * action row is now Weekly-report + Ask-the-Coach only.
             */}
          </div>

          <div
            data-slot="insights-hero-strip-prompts"
            className="border-border/50 border-t pt-4"
          >
            {/*
             * v1.4.20 phase B2b — chip clicks open the Coach drawer
             * with the localised prompt pre-filled in the composer.
             * The parent owns drawer state so the chip strip stays
             * presentational.
             */}
            <SuggestedPrompts onPick={onPickPrompt ?? (() => undefined)} />
          </div>
        </div>

        {healthScore && (
          <HealthScoreCard
            score={healthScore.score}
            band={healthScore.band}
            components={healthScore.components}
            delta={healthScore.delta}
            onAskCoach={
              onAskCoach ? (prefill: string) => onAskCoach(prefill) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

/**
 * v1.4.20 phase B4 — slim banner card surfacing the fresh weekly report.
 *
 * Sits between the hero's title block and the action row. The banner
 * carries three actions:
 *   - Read → in-app navigation to `/insights/report/[week]`.
 *   - Share → `navigator.share` when supported, else clipboard fallback
 *     with a sonner toast acknowledgement.
 *   - Export PDF → opens the report URL with `?print=1` so the report
 *     page auto-fires `window.print()` after first paint.
 */
function WeeklyReportBanner({
  weekISO,
  href,
}: {
  weekISO: string;
  href: string;
}) {
  const { t } = useTranslations();
  const printHref = href.includes("?") ? `${href}&print=1` : `${href}?print=1`;
  const shareUrl =
    typeof window !== "undefined"
      ? new URL(href, window.location.origin).toString()
      : href;

  async function handleShare() {
    const title = t("insights.heroBanner.shareTitle");
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await navigator.share({ url: shareUrl, title });
        return;
      } catch (err) {
        // Web Share rejects with AbortError when the user cancels —
        // not an error worth surfacing. Other failures fall through to
        // the clipboard fallback below.
        if ((err as DOMException)?.name === "AbortError") return;
      }
    }
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(shareUrl);
        toast.success(t("insights.heroBanner.shareCopied"));
        return;
      } catch {
        // fallthrough
      }
    }
    toast.error(t("insights.heroBanner.shareFailed"));
  }

  return (
    <div
      data-slot="insights-hero-strip-weekly-banner"
      className="border-dracula-purple/30 bg-dracula-purple/10 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5 sm:px-4"
    >
      <Sparkles
        className="text-dracula-purple h-4 w-4 shrink-0"
        aria-hidden="true"
      />
      <p
        data-slot="insights-hero-strip-weekly-banner-label"
        className="min-w-0 flex-1 text-sm leading-snug"
      >
        {t("insights.heroBanner.ready", { week: weekISO })}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          asChild
          size="sm"
          variant="default"
          data-slot="insights-hero-strip-weekly-banner-read"
          className="gap-1.5"
        >
          <Link href={href}>
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t("insights.heroBanner.read")}</span>
          </Link>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={handleShare}
          data-slot="insights-hero-strip-weekly-banner-share"
          className="gap-1.5"
        >
          <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t("insights.heroBanner.share")}</span>
        </Button>
        <Button
          asChild
          size="sm"
          variant="ghost"
          data-slot="insights-hero-strip-weekly-banner-export"
          className="gap-1.5"
        >
          <Link href={printHref}>
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t("insights.heroBanner.exportPdf")}</span>
          </Link>
        </Button>
      </div>
    </div>
  );
}
