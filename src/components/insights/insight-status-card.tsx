"use client";

import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { cn } from "@/lib/utils";
import { useFeatureFlags } from "@/hooks/use-feature-flags";

// ─── Types ────────────────────────────────────────────────

interface InsightStatusCardProps {
  title: string;
  icon: React.ReactNode;
  text: string | null;
  hasProvider: boolean;
  cached: boolean;
  updatedAt: string | null;
  loading?: boolean;
}

// ─── Main Component ───────────────────────────────────────

export function InsightStatusCard({
  title,
  icon,
  text,
  hasProvider,
  cached,
  updatedAt,
  loading = false,
}: InsightStatusCardProps) {
  const { t } = useTranslations();
  const flags = useFeatureFlags();
  // v1.4.31 — operator can hide every per-metric status card
  // app-wide. The delta number stays; the LLM narration card is
  // suppressed in full so the layout collapses naturally.
  if (!flags.insightStatus) return null;

  if (loading) {
    // v1.4.37 — structured skeleton over the centred spinner. When the
    // per-metric status route had to fall back to the 20 s provider
    // race the user used to stare at a single centred spinner with
    // "Lade…" copy, which gave no sense of progress and pinned the
    // card to a flat dot. The skeleton paints the actual rendered
    // geometry (icon dot, title bar, three text lines, footer) so the
    // loading state previews where the assessment will land. Heights
    // mirror `<CardTitle>` (`text-base` → 1 rem) and the prose
    // (`text-sm` → 0.875 rem) so the post-load swap reflows by less
    // than a row.
    return (
      <Card aria-busy="true" aria-live="polite" data-testid="insight-status-card-loading">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <div className="bg-muted h-5 w-5 animate-pulse rounded motion-reduce:animate-none" />
            <div className="bg-muted h-4 w-32 animate-pulse rounded motion-reduce:animate-none" />
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="bg-muted h-3.5 w-full animate-pulse rounded motion-reduce:animate-none" />
          <div className="bg-muted h-3.5 w-11/12 animate-pulse rounded motion-reduce:animate-none" />
          <div className="bg-muted h-3.5 w-9/12 animate-pulse rounded motion-reduce:animate-none" />
          <div className="bg-muted/70 h-3 w-1/3 animate-pulse rounded motion-reduce:animate-none" />
          <span className="sr-only">{t("common.loading")}</span>
        </CardContent>
      </Card>
    );
  }

  if (!hasProvider) {
    return (
      <Card className="opacity-60">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {t("insights.noProviderConfigured")}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!text) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {t("insights.noAnalysisYet")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    // v1.4.38 W-D P2-2 — `aria-live="polite"` so screen readers
    // announce the assessment when it swaps into the same slot the
    // structured skeleton occupied. The skeleton card already carries
    // `aria-busy="true" aria-live="polite"`; mirroring the live region
    // on the success card closes the load→loaded transition signal.
    <Card
      aria-live="polite"
      className="animate-insight-in border-l-dracula-purple border-l-2"
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          {cached && (
            <span className="text-muted-foreground text-xs">
              {t("insights.cached")}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* v1.4.27 — defence-in-depth strip. Cached status text from
            pre-v1.4.27 rows can still carry literal `metric:<TYPE>`
            tokens the model embedded on the assumption a chart would
            render inline. The sub-page never mounts the chart, so the
            token surfaces verbatim. The producer side now strips too;
            this consumer-side wrap keeps existing caches clean while
            they roll forward. */}
        <StatusBody text={stripChartTokens(text)} />
        <LastUpdatedFooter updatedAt={updatedAt} />
      </CardContent>
    </Card>
  );
}

/**
 * v1.4.27 MB7 / CF-39 — collapsible status copy. The assessment text
 * routinely lands at 3-5 paragraphs of dense narrative which dominates
 * the surface on phones. The default collapses to 3 lines via
 * `line-clamp-3`; a "Show more" toggle reveals the full body. Desktop
 * users see the full text immediately because the clamp + toggle only
 * mount when the source string is long enough to actually clip.
 */
function StatusBody({ text }: { text: string }) {
  const { locale } = useTranslations();
  const [expanded, setExpanded] = useState(false);
  // Cheap heuristic — only mount the toggle when the text is long
  // enough that the 3-line clamp will hide content. ~220 characters
  // covers the worst-case sm-viewport line at typical insights text
  // density; below that we render plain so the user never sees a
  // useless "Show more" affordance.
  const isLong = text.length > 220;
  if (!isLong) {
    return (
      <p className="text-muted-foreground text-sm leading-relaxed">{text}</p>
    );
  }
  // v1.4.27 MB7 / CF-39 — toggle copy is two short strings; rather
  // than reach into the catalogue (which this bucket cannot edit per
  // the dispatch brief), the labels resolve against the locale prefix
  // inline. The translation catalogue can claim these strings in a
  // later cycle without breaking the contract.
  const isDe = locale.startsWith("de");
  const showMoreLabel = isDe ? "Mehr anzeigen" : "Show more";
  const showLessLabel = isDe ? "Weniger anzeigen" : "Show less";
  return (
    <div className="space-y-1">
      <p
        className={cn(
          "text-muted-foreground text-sm leading-relaxed",
          !expanded && "line-clamp-3",
        )}
      >
        {text}
      </p>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className={cn(
          "text-foreground/80 hover:text-foreground inline-flex text-xs font-medium",
          "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
        )}
      >
        {expanded ? showLessLabel : showMoreLabel}
      </button>
    </div>
  );
}

function LastUpdatedFooter({ updatedAt }: { updatedAt: string | null }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  if (!updatedAt) return null;
  return (
    <p className="text-muted-foreground text-xs">
      {t("insights.lastUpdated")}: {fmt.dateTime(updatedAt)}
    </p>
  );
}
