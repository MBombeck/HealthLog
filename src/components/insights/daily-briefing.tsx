"use client";

import Link from "next/link";
import {
  Activity,
  FileText,
  Flame,
  Footprints,
  Heart,
  HeartPulse,
  Mountain,
  Moon,
  Pill,
  Route,
  Scale,
  Smile,
  Sparkles,
  Thermometer,
  Wind,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/relative-time";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { cn } from "@/lib/utils";
import type {
  DailyBriefing as DailyBriefingPayload,
  DailyBriefingKeyFinding,
} from "@/lib/ai/schema";

/**
 * v1.4.27 MB7 / CF-68 — per-metric routing target for the briefing
 * key findings. Maps the schema's `sourceMetric` discriminator to the
 * sub-page slug that owns the deeper view. Metrics that don't have a
 * dedicated routed sub-page yet (hrv, resting_hr, steps, …) fall
 * through to `null` and render as a plain row (no link wrap).
 */
const METRIC_HREF: Record<DailyBriefingKeyFinding["sourceMetric"], string | null> = {
  bp: "/insights/blood-pressure",
  weight: "/insights/weight",
  pulse: "/insights/pulse",
  mood: "/insights/mood",
  compliance: "/insights/medications",
  // Apple Health / GLP-1 additive metrics — no dedicated sub-page yet.
  // They render as static rows; v1.4.28 can wire each as they ship.
  hrv: null,
  sleep: "/insights/sleep",
  resting_hr: null,
  steps: null,
  active_energy: null,
  flights: null,
  distance: null,
  vo2_max: "/insights/pulse",
  body_temp: null,
  glp1_plateau: "/insights/medications",
};

/**
 * v1.4.20 phase B1 — full-width Daily Briefing card.
 *
 * Renders the narrative paragraph + 0-5 key-finding rows synthesised
 * by the AI insight pipeline. Lives directly below the hero strip on
 * `/insights`. Keeps the existing per-section advisor + status cards
 * untouched — this card is additive, not a replacement.
 *
 * Loading state: shimmer skeleton via Tailwind's `animate-pulse` so
 * it matches the rest of the app.
 *
 * Empty state: when `briefing === null && !loading`, renders an
 * <EmptyState> with a "Generate briefing" CTA wired through
 * `onRegenerate`. The CTA hides cleanly when no handler is supplied.
 */

interface DailyBriefingProps {
  /** Briefing payload — null when the cache has none. */
  briefing: DailyBriefingPayload | null;
  /** ISO timestamp of the briefing's generation, surfaced as a meta line. */
  updatedAt?: string | null;
  /** Loading state — shimmer skeleton replaces content. */
  loading?: boolean;
  /** Optional CTA wiring for the empty-state generate button. */
  onRegenerate?: () => void;
  /** Disables the regenerate CTA while a generation is in flight. */
  regenerating?: boolean;
  /**
   * Optional slot for a meta control mounted in the card header — the
   * comparison toggle migrates here from the hero in commit 5.
   */
  metaSlot?: React.ReactNode;
}

const METRIC_ICON: Record<
  DailyBriefingKeyFinding["sourceMetric"],
  React.ComponentType<{ className?: string }>
> = {
  bp: Heart,
  weight: Scale,
  pulse: Activity,
  mood: Smile,
  compliance: Pill,
  // ── v1.4.23 Apple Health additive ──
  // Icon picks track the metric domain rather than the brand. Web-only
  // accounts never receive findings keyed to these metrics, so the
  // mapping is only exercised on iOS-connected snapshots.
  hrv: Wind,
  sleep: Moon,
  resting_hr: HeartPulse,
  steps: Footprints,
  active_energy: Flame,
  flights: Mountain,
  distance: Route,
  vo2_max: Zap,
  body_temp: Thermometer,
  // ── v1.4.25 W4d GLP-1 additive ──
  // Plateau finding inherits the Pill icon since it's an
  // adherence-context observation about the user's GLP-1 therapy.
  // Non-GLP-1 accounts never see this finding type.
  glp1_plateau: Pill,
};

const TONE_BAR_CLASSNAME: Record<DailyBriefingKeyFinding["tone"], string> = {
  good: "bg-dracula-green",
  watch: "bg-dracula-orange",
  info: "bg-dracula-cyan",
};

const TONE_TEXT_CLASSNAME: Record<DailyBriefingKeyFinding["tone"], string> = {
  good: "text-dracula-green",
  watch: "text-dracula-orange",
  info: "text-dracula-cyan",
};

function DeltaBadge({
  delta,
  tone,
}: {
  delta: string | null;
  tone: DailyBriefingKeyFinding["tone"];
}) {
  if (!delta) return null;
  return (
    <span
      data-slot="daily-briefing-delta"
      className={cn(
        "text-xs font-semibold tabular-nums",
        TONE_TEXT_CLASSNAME[tone],
      )}
    >
      {delta}
    </span>
  );
}

function KeyFindingRow({ finding }: { finding: DailyBriefingKeyFinding }) {
  const Icon = METRIC_ICON[finding.sourceMetric];
  const href = METRIC_HREF[finding.sourceMetric];
  // v1.4.27 MB7 / CF-68 — when the briefing's `sourceMetric` maps to
  // a routed sub-page, wrap the entire row in a `<Link>` so the
  // whole card is tappable on mobile instead of the user having to
  // hit the small headline text. Hover + focus paint a subtle bg
  // shift; metrics that don't have a sub-page yet render the
  // original static row.
  const rowContent = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-3 bottom-3 left-0 w-[3px] rounded-r",
          TONE_BAR_CLASSNAME[finding.tone],
        )}
      />
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          TONE_TEXT_CLASSNAME[finding.tone],
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm leading-snug font-medium">
            {stripChartTokens(finding.headline)}
          </p>
          <DeltaBadge delta={finding.delta} tone={finding.tone} />
        </div>
        <p className="text-muted-foreground text-xs leading-snug">
          {stripChartTokens(finding.detail)}
        </p>
      </div>
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        data-slot="daily-briefing-finding"
        data-metric={finding.sourceMetric}
        className={cn(
          "border-border/60 bg-card/40 relative flex items-start gap-3 rounded-md border p-3",
          "hover:bg-accent/40 transition-colors",
          "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
        )}
      >
        {rowContent}
      </Link>
    );
  }
  return (
    <div
      data-slot="daily-briefing-finding"
      data-metric={finding.sourceMetric}
      className="border-border/60 bg-card/40 relative flex items-start gap-3 rounded-md border p-3"
    >
      {rowContent}
    </div>
  );
}

function BriefingSkeleton() {
  return (
    <div
      data-slot="daily-briefing-skeleton"
      className="space-y-4 motion-reduce:animate-none"
      aria-hidden="true"
    >
      <div className="space-y-2">
        <div className="bg-muted/60 h-3 w-11/12 animate-pulse motion-reduce:animate-none rounded" />
        <div className="bg-muted/60 h-3 w-10/12 animate-pulse motion-reduce:animate-none rounded" />
        <div className="bg-muted/60 h-3 w-9/12 animate-pulse motion-reduce:animate-none rounded" />
        <div className="bg-muted/60 h-3 w-8/12 animate-pulse motion-reduce:animate-none rounded" />
      </div>
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="border-border/40 bg-card/30 flex h-16 items-center rounded-md border p-3"
          >
            <div className="bg-muted/60 h-3 w-1/3 animate-pulse motion-reduce:animate-none rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function DailyBriefing({
  briefing,
  updatedAt,
  loading = false,
  onRegenerate,
  regenerating = false,
  metaSlot,
}: DailyBriefingProps) {
  const { t } = useTranslations();

  return (
    <Card data-slot="daily-briefing" className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles
              className="text-dracula-purple h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <CardTitle className="text-base font-semibold">
              {t("insights.dailyBriefing.title")}
            </CardTitle>
          </div>
          {metaSlot && (
            <div
              data-slot="daily-briefing-meta-slot"
              className="flex items-center gap-2"
            >
              {metaSlot}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <>
            <span className="sr-only" aria-live="polite">
              {t("insights.dailyBriefing.loadingLabel")}
            </span>
            <BriefingSkeleton />
          </>
        ) : briefing ? (
          <div className="space-y-4">
            {/* v1.4.27 B1 — the leading narrative paragraph dropped.
                The hero strip subtitle on `/insights` already renders
                the same `briefing.paragraph` text directly above this
                card, so the user used to read the same string twice
                within 200 px. The card now opens straight on the
                structured key-findings list, which is the part the
                hero subtitle cannot surface. */}
            {briefing.keyFindings.length > 0 && (
              <div className="space-y-2">
                <p
                  data-slot="daily-briefing-findings-title"
                  className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase"
                >
                  {t("insights.dailyBriefing.keyFindingsTitle")}
                </p>
                <div data-slot="daily-briefing-findings" className="space-y-2">
                  {briefing.keyFindings.map((finding, index) => (
                    <KeyFindingRow
                      key={`${finding.sourceMetric}-${index}`}
                      finding={finding}
                    />
                  ))}
                </div>
              </div>
            )}
            {updatedAt && (
              <p
                data-slot="daily-briefing-updated"
                className="text-muted-foreground border-border/60 border-t pt-3 text-xs"
              >
                {t("insights.heroGenerated", {
                  time: formatRelativeTime(updatedAt, t),
                })}
              </p>
            )}
          </div>
        ) : (
          <EmptyState
            data-slot="daily-briefing-empty"
            variant="plain"
            icon={<FileText className="size-5" />}
            title={t("insights.dailyBriefing.emptyTitle")}
            description={t("insights.dailyBriefing.emptyDescription")}
            action={
              onRegenerate ? (
                // v1.4.28 BK-M2 — switch the empty-state CTA from
                // `variant="outline"` to the default (filled) variant
                // so the briefing card matches the dashboard
                // empty-state CTA shape. Empty-state actions on a card
                // surface read as the single primary affordance and
                // earn the filled chip across surfaces in v1.4.28.
                <Button
                  type="button"
                  size="sm"
                  onClick={onRegenerate}
                  disabled={regenerating}
                  data-slot="daily-briefing-empty-cta"
                  className="gap-1.5"
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>
                    {regenerating
                      ? t("insights.heroRegenerating")
                      : t("insights.dailyBriefing.emptyAction")}
                  </span>
                </Button>
              ) : null
            }
          />
        )}
      </CardContent>
    </Card>
  );
}
