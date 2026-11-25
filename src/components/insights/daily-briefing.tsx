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
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  useTranslations,
  useFormatters,
  useDisplayTimezone,
} from "@/lib/i18n/context";
import { formatUpdatedLabel } from "@/lib/i18n/relative-time";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { metricHref } from "@/lib/links/hrefs";
import { cn } from "@/lib/utils";
import type {
  DailyBriefing as DailyBriefingPayload,
  DailyBriefingKeyFinding,
  DailyBriefingSignal,
} from "@/lib/ai/schema";
import type { BriefingFailureClass } from "@/lib/insights/briefing-failure-marker";
import { InsightSectionCard } from "./insight-section-card";

/**
 * v1.4.20 — full-width Daily Briefing card.
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
   * v1.25 — the most recent generation attempt failed (provider timeout /
   * error). The briefing keeps its last good text, so this never blanks a
   * shown card; it only adds an honest "couldn't refresh" hint to the footer
   * of a held briefing, and — when there is no briefing to show — swaps the
   * generic empty state for a "couldn't generate" one whose CTA retries.
   */
  generationFailed?: boolean;
  /**
   * v1.25.3 — coarse class of the most recent failure. When the empty state is
   * shown ("couldn't generate"), it lets the hint point at the right lever:
   * `timeout` → raise the AI response timeout, `auth` → re-check the provider.
   * Absent / null → the generic failed-description holds.
   */
  generationFailureClass?: BriefingFailureClass | null;
  /**
   * v1.28.28 (#470) — the last regenerate produced a briefing that restated a
   * figure the grounding gate could not verify against the user's data, so it
   * was withheld rather than shown. Renders a distinct, calm empty state
   * ("wasn't shown, try again") instead of the generic "no briefing yet",
   * which made the regenerate button read as doing nothing.
   */
  omittedReason?: "ungrounded" | null;
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
  // ── v1.10.0 derived-wellness additive ──
  readiness: Sparkles,
  recovery: HeartPulse,
};

const TONE_BAR_CLASSNAME: Record<DailyBriefingKeyFinding["tone"], string> = {
  good: "bg-success",
  watch: "bg-warning",
  info: "bg-info",
};

const TONE_TEXT_CLASSNAME: Record<DailyBriefingKeyFinding["tone"], string> = {
  good: "text-success",
  watch: "text-warning",
  info: "text-info",
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
        // `self-start` keeps the badge left-aligned + content-width when
        // the parent row stacks into a column below `sm`.
        "self-start text-xs font-semibold tabular-nums sm:shrink-0",
        TONE_TEXT_CLASSNAME[tone],
      )}
    >
      {delta}
    </span>
  );
}

/**
 * v1.18.7 — shared row layout for the key-finding row and the signal-of-the-day
 * row. Both render the same tone bar + metric icon + headline/body/delta and
 * the same "wrap in a `<Link>` when the metric owns a sub-page" behaviour; the
 * two only differ in their `data-slot` and the body copy they pass.
 */
function BriefingRow({
  sourceMetric,
  tone,
  headline,
  body,
  delta,
  dataSlot,
}: {
  sourceMetric: DailyBriefingKeyFinding["sourceMetric"];
  tone: DailyBriefingKeyFinding["tone"];
  headline: string;
  body: string;
  delta: string | null;
  dataSlot: "daily-briefing-finding" | "daily-briefing-signal";
}) {
  const Icon = METRIC_ICON[sourceMetric];
  // The metric's page, from the one table of metric pages.
  const href = metricHref(sourceMetric);
  const rowContent = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-3 bottom-3 left-0 w-[3px] rounded-r",
          TONE_BAR_CLASSNAME[tone],
        )}
      />
      <Icon
        className={cn("mt-0.5 h-4 w-4 shrink-0", TONE_TEXT_CLASSNAME[tone])}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-1">
        {/* Phone widths stack headline over delta (same treatment as the
            dashboard spotlight rows): side-by-side squeezed a long
            headline into a narrow multi-line column beside a long delta.
            At `sm+` the row layout returns. */}
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <p className="text-sm leading-snug font-medium">
            {stripChartTokens(headline)}
          </p>
          <DeltaBadge delta={delta} tone={tone} />
        </div>
        <p className="text-muted-foreground text-xs leading-snug">
          {stripChartTokens(body)}
        </p>
      </div>
    </>
  );
  if (href) {
    return (
      <ListRow
        asChild
        data-slot={dataSlot}
        data-metric={sourceMetric}
        className={cn(
          "border-border/60 bg-card/40 relative flex items-start gap-3",
          "hover:bg-accent/40 transition-colors",
          "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
        )}
      >
        <Link href={href}>{rowContent}</Link>
      </ListRow>
    );
  }
  return (
    <ListRow
      data-slot={dataSlot}
      data-metric={sourceMetric}
      className="border-border/60 bg-card/40 relative flex items-start gap-3"
    >
      {rowContent}
    </ListRow>
  );
}

// v1.4.27 — the whole row is tappable on mobile (wrapped in a
// `<Link>` by `BriefingRow`) so the user need not hit the small headline text.
function KeyFindingRow({ finding }: { finding: DailyBriefingKeyFinding }) {
  return (
    <BriefingRow
      sourceMetric={finding.sourceMetric}
      tone={finding.tone}
      headline={finding.headline}
      body={finding.detail}
      delta={finding.delta}
      dataSlot="daily-briefing-finding"
    />
  );
}

/**
 * v1.18.7 — "Signals of the day" row. The present-focused lead of the
 * briefing: a NOW-anchored headline + a concrete nudge the user can act on.
 * Shares `BriefingRow` with the key-finding row.
 */
function SignalRow({ signal }: { signal: DailyBriefingSignal }) {
  return (
    <BriefingRow
      sourceMetric={signal.sourceMetric}
      tone={signal.tone}
      headline={signal.headline}
      body={signal.nudge}
      delta={signal.delta}
      dataSlot="daily-briefing-signal"
    />
  );
}

function BriefingSkeleton() {
  return (
    <div
      data-slot="daily-briefing-skeleton"
      className="space-y-3 motion-reduce:animate-none"
      aria-hidden="true"
    >
      <div className="space-y-2">
        <Skeleton className="h-3 w-11/12 rounded" />
        <Skeleton className="h-3 w-10/12 rounded" />
        <Skeleton className="h-3 w-9/12 rounded" />
        <Skeleton className="h-3 w-8/12 rounded" />
      </div>
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="border-border/40 bg-card/30 flex h-16 items-center rounded-md border p-3"
          >
            <Skeleton className="h-3 w-1/3 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The empty-state hint for a failed generation, by its failure class. */
function failedDescriptionKeyFor(failureClass: BriefingFailureClass | null) {
  return failureClass === "timeout"
    ? "insights.dailyBriefing.failedDescriptionTimeout"
    : failureClass === "auth"
      ? "insights.dailyBriefing.failedDescriptionProvider"
      : failureClass === "rate-limit"
        ? "insights.dailyBriefing.failedDescriptionRateLimit"
        : failureClass === "format"
          ? "insights.dailyBriefing.failedDescriptionFormat"
          : "insights.dailyBriefing.failedDescription";
}

export function DailyBriefing({
  briefing,
  updatedAt,
  loading = false,
  onRegenerate,
  regenerating = false,
  generationFailed = false,
  generationFailureClass = null,
  omittedReason = null,
  metaSlot,
}: DailyBriefingProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // Issue #490 — the SAME resolved zone `fmt.time` renders in (mirror →
  // Berlin), so the today/yesterday boundary and the clock can never split.
  const displayTz = useDisplayTimezone();

  // v1.25.3 — when there is no last good text and the last attempt failed,
  // point the hint at the lever that matches the failure class. A timeout (the
  // dominant failure on a slow self-hosted model) → raise the AI response
  // timeout; an auth / config rejection → re-check the provider in Settings;
  // a reply the briefing could not show (invalid JSON, a briefing that fails
  // the shared reader) says the model answered in the wrong form, not that
  // the provider failed. Anything else keeps the calmer generic line.
  // Non-alarming by design.
  const failedDescriptionKey = failedDescriptionKeyFor(generationFailureClass);

  return (
    // v1.13.1 — heading-above-card pattern. The "Tagesbriefing" title
    // moves OUT of the card into an `<h2>` above it (mirroring the
    // TrendsRow / wellness-strip section headers) so the card opens
    // straight on its content and the surface reclaims the vertical
    // space the in-card header used to occupy.
    <section
      // Anchor target for the dashboard spotlight's heading link
      // (`/insights#daily-briefing`); `scroll-mt-28` is the app-wide
      // sticky-header offset token.
      id="daily-briefing"
      data-slot="daily-briefing-section"
      aria-label={t("insights.dailyBriefing.title")}
      className="scroll-mt-28 space-y-3"
    >
      <SectionHeading
        icon={Sparkles}
        title={t("insights.dailyBriefing.title")}
        action={
          metaSlot ? (
            <div data-slot="daily-briefing-meta-slot">{metaSlot}</div>
          ) : undefined
        }
      />
      <InsightSectionCard slot="daily-briefing" className="overflow-hidden">
        {loading ? (
          <>
            <span className="sr-only" aria-live="polite">
              {t("insights.dailyBriefing.loadingLabel")}
            </span>
            <BriefingSkeleton />
          </>
        ) : briefing ? (
          // v1.18.10 — body block rhythm matches the sibling insights cards
          // (`correlation-card` uses `space-y-3` between its chart /
          // interpretation / source blocks). The briefing card carried a
          // looser `space-y-4`, which read as taller than its neighbours on
          // the overview. One token, no new spacing scale.
          <div className="space-y-3">
            {/* The v1.21.2 recall/forward-look block is gone: the card
                  opens straight on "signals of the day". The narrative
                  memory read as a second briefing paragraph above the
                  structured list and pulled the card down; the server
                  still resolves `briefingMemory` for other consumers. */}
            {/* v1.4.27 — the leading narrative paragraph dropped.
                The hero strip subtitle on `/insights` already renders
                the same `briefing.paragraph` text directly above this
                card, so the user used to read the same string twice
                within 200 px. The card now opens straight on the
                structured signals + key-findings list, which is the part
                the hero subtitle cannot surface. */}
            {/* v1.18.7 — "Signals of the day": the present-focused lead.
                Renders above the longer-horizon key-findings list when the
                briefing carries fresh now-signals. */}
            {briefing.signalsOfDay && briefing.signalsOfDay.length > 0 && (
              <div className="space-y-2">
                <p
                  data-slot="daily-briefing-signals-title"
                  className="text-foreground text-xs font-semibold tracking-wide uppercase"
                >
                  {t("insights.dailyBriefing.signalsTitle")}
                </p>
                <div data-slot="daily-briefing-signals" className="space-y-2">
                  {briefing.signalsOfDay.map((signal, index) => (
                    <SignalRow
                      key={`${signal.sourceMetric}-${index}`}
                      signal={signal}
                    />
                  ))}
                </div>
              </div>
            )}
            {briefing.keyFindings.length > 0 && (
              <div className="space-y-2">
                <p
                  data-slot="daily-briefing-findings-title"
                  className="text-foreground text-xs font-semibold tracking-wide uppercase"
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
            {(updatedAt || generationFailed) && (
              <div className="border-border/60 space-y-1.5 border-t pt-3">
                {updatedAt && (
                  <p
                    data-slot="daily-briefing-updated"
                    className="text-muted-foreground text-right text-xs"
                  >
                    {formatUpdatedLabel(
                      updatedAt,
                      t,
                      fmt.dateShort,
                      fmt.time,
                      displayTz,
                    )}
                  </p>
                )}
                {/* v1.25 — the held briefing is shown, but the last refresh
                      attempt failed (provider timeout / error). State it plainly
                      and offer a retry so the staleness reads as held, not
                      current. The card only mounts while the briefing
                      capability is available, so a provider exists. */}
                {generationFailed && (
                  <p
                    data-slot="daily-briefing-refresh-failed"
                    className="text-muted-foreground flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1 text-right text-xs"
                  >
                    <span>{t("insights.dailyBriefing.refreshFailedHint")}</span>
                    {onRegenerate && (
                      <button
                        type="button"
                        onClick={onRegenerate}
                        disabled={regenerating}
                        data-slot="daily-briefing-refresh-failed-retry"
                        className="text-foreground/80 hover:text-foreground underline underline-offset-2 disabled:opacity-60"
                      >
                        {t("insights.dailyBriefing.retryAction")}
                      </button>
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <EmptyState
            data-slot="daily-briefing-empty"
            variant="plain"
            icon={<FileText className="size-5" />}
            // v1.25 — when the last attempt FAILED and there is no last good
            // text to fall back on, say so honestly ("couldn't generate")
            // rather than the generic "no briefing yet". The CTA below is the
            // same explicit regenerate — it retries the failed generation.
            // v1.28.28 (#470) — a grounding-gate omission gets its own calm
            // wording: the generation SUCCEEDED but restated an unverifiable
            // figure, so the briefing was withheld. Without this the card
            // read "no briefing yet" and the button looked like a no-op.
            title={
              omittedReason === "ungrounded"
                ? t("insights.dailyBriefing.omittedTitle")
                : generationFailed
                  ? t("insights.dailyBriefing.failedTitle")
                  : t("insights.dailyBriefing.emptyTitle")
            }
            description={
              omittedReason === "ungrounded"
                ? t("insights.dailyBriefing.omittedUngroundedDescription")
                : generationFailed
                  ? t(failedDescriptionKey)
                  : t("insights.dailyBriefing.emptyDescription")
            }
            action={
              onRegenerate ? (
                // v1.4.28 — switch the empty-state CTA from
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
                      : generationFailed || omittedReason === "ungrounded"
                        ? t("insights.dailyBriefing.retryAction")
                        : t("insights.dailyBriefing.emptyAction")}
                  </span>
                </Button>
              ) : null
            }
          />
        )}
      </InsightSectionCard>
    </section>
  );
}
