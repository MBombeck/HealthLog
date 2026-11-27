"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TileHeader } from "@/components/insights/tile-header";
import {
  useTranslations,
  useFormatters,
  useDisplayTimezone,
} from "@/lib/i18n/context";
import { formatUpdatedLabel } from "@/lib/i18n/relative-time";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { ProseBlocks } from "@/components/insights/prose-blocks";
import { cn } from "@/lib/utils";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { AskCoachIconButton } from "@/components/insights/ask-coach-action";
import type { CoachLaunchScope } from "@/lib/insights/coach-launch-context";
import type { AssessmentStatus } from "@/lib/insights/status-shared";

// ─── Types ────────────────────────────────────────────────

/**
 * v1.12.6 — route the icon + title row through the canonical
 * `<TileHeader>`. Callers still pass a pre-sized icon NODE (e.g.
 * `<HeartPulse className="h-5 w-5" />`) because the bespoke metric pages
 * own that prop; `<TileHeader>` drives its icon off a component, so wrap
 * the node in a thin component that renders it.
 *
 * v1.12.7 — `<TileHeader>` owns the canonical `h-5 w-5 text-foreground`
 * sizing and passes it through as `className` to its icon component. The
 * previous wrapper rendered the node verbatim and dropped that class, so a
 * caller passing an unsized (or mis-sized) node could drift off the contract.
 * The wrapper now forwards `<TileHeader>`'s className onto a sizing span that
 * normalizes the glyph — the `[&>svg]:size-5` rule pins any child SVG to the
 * canonical box regardless of what the caller passed. Callers that already
 * pass `<Icon className="h-5 w-5" />` stay visually identical.
 */
function nodeIcon(icon: React.ReactNode): React.ComponentType<{
  className?: string;
}> {
  return function StatusIcon({ className }: { className?: string }) {
    return (
      <span className={cn("inline-flex [&>svg]:size-5", className)}>
        {icon}
      </span>
    );
  };
}

interface InsightStatusCardProps {
  title: string;
  icon: React.ReactNode;
  text: string | null;
  hasProvider: boolean;
  updatedAt: string | null;
  loading?: boolean;
  /**
   * v1.8.3 — the read-only status route enqueued an out-of-band generation
   * and the assessment isn't warm yet. Render the same skeleton geometry as
   * `loading` but with a "preparing" caption so the user understands the
   * card is being assembled, not stuck. The client polls until text lands.
   */
  preparing?: boolean;
  /**
   * Explicit producer/hook state. Legacy scalar props remain supported for
   * direct mounts while routes roll forward, but this discriminator owns
   * branch ordering whenever it is present.
   */
  assessment?: AssessmentStatus;
  /**
   * v1.21.0 — opt-in "Ask the Coach about this assessment" hand-off.
   * When `coachQuestion` is set (the metric-aware caller supplies it), the
   * populated card renders a discreet Coach action seeded with that opener
   * and narrowed to `coachScope` when known. Callers that omit it keep the
   * card exactly as before — additive.
   */
  coachQuestion?: string;
  coachScope?: CoachLaunchScope;
  /**
   * Auto-send the seeded opener as the first turn (assessment hand-off)
   * instead of only seeding the composer. Defaults to false.
   */
  coachAutoSend?: boolean;
  /**
   * Whether the card's text is written by a model. True for every status
   * note, which only shows while the `statusText` capability is available.
   * The score anatomy passes false: its assessment is composed from the
   * numbers and only upgraded to model text by the server, so it shows
   * whatever the AI state.
   */
  aiAuthored?: boolean;
}

// ─── Main Component ───────────────────────────────────────

export function InsightStatusCard({
  title,
  icon,
  text,
  hasProvider,
  updatedAt,
  loading = false,
  preparing = false,
  assessment,
  coachQuestion,
  coachScope,
  coachAutoSend,
  aiAuthored = true,
}: InsightStatusCardProps) {
  const { t } = useTranslations();
  const statusText = useAiCapability("statusText");
  // A status note is model-written text, so the card is hidden, never an
  // error or a "connect a provider" hint, while the `statusText` capability
  // is unavailable for any reason. The numbers around it stay; the layout
  // collapses naturally.
  if (aiAuthored && !statusText.available) return null;

  const displayText =
    assessment?.kind === "generated" ||
    assessment?.kind === "screened-fallback" ||
    assessment?.kind === "revalidating"
      ? assessment.text
      : text;
  const isPreparing =
    assessment?.kind === "preparing" ||
    (!assessment && preparing && hasProvider && !displayText);

  // While the assessment is on its way the page shows no card for it: a
  // card of skeleton bars at the foot of the page read as a fault, and the
  // numbers above already stand on their own. A generation the route queued
  // says so in one quiet line; a plain load holds only a status for
  // assistive tech. The text takes its place once it lands.
  if (isPreparing) {
    return (
      <p
        aria-live="polite"
        data-testid="insight-status-card-preparing"
        className="text-muted-foreground text-xs"
      >
        {t("insights.assessmentPreparing")}
      </p>
    );
  }

  if (loading) {
    return (
      <span
        role="status"
        aria-busy="true"
        data-testid="insight-status-card-loading"
        className="sr-only"
      >
        {t("common.loading")}
      </span>
    );
  }

  const terminalKind =
    assessment?.kind === "timeout" ||
    assessment?.kind === "error" ||
    assessment?.kind === "exhausted"
      ? assessment.kind
      : null;
  if (terminalKind) {
    const message =
      terminalKind === "error"
        ? t("common.loadFailed")
        : terminalKind === "timeout"
          ? t("common.networkError")
          : t("insights.noAnalysisYet");
    return (
      <Card
        aria-live="polite"
        role="status"
        data-testid={`insight-status-card-${terminalKind}`}
        density="compact"
      >
        <CardHeader>
          <TileHeader icon={nodeIcon(icon)} title={title} />
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">{message}</p>
        </CardContent>
      </Card>
    );
  }

  if (!displayText) {
    return (
      <Card density="compact">
        <CardHeader>
          <TileHeader icon={nodeIcon(icon)} title={title} />
        </CardHeader>
        <CardContent>
          <EmptyState
            variant="plain"
            size="compact"
            title={t("insights.noAnalysisYet")}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    // v1.4.38 — `aria-live="polite"` so screen readers
    // announce the assessment when it swaps into the same slot the
    // structured skeleton occupied. The skeleton card already carries
    // `aria-busy="true" aria-live="polite"`; mirroring the live region
    // on the success card closes the load→loaded transition signal.
    <Card
      aria-live="polite"
      // v1.12.2 — stable hook for the spine guard test, which asserts the
      // assessment is the LAST content block on every bespoke metric page.
      data-slot="insight-assessment"
      // Compact card density — the sanctioned tight
      // tier, so the assessment shares one header→body rhythm with the
      // target summary, the read strip, and the stat strip on the same
      // spine. Earlier bespoke values (`gap-1.5` + `md:py-5`) predate the
      // two-density contract and were normalised onto it. The same class
      // lands on every status variant so the gap is consistent across
      // states. (The one-time purple left accent stays dropped — the plain
      // card border carries enough separation.)
      density="compact"
      className="animate-insight-in"
    >
      <CardHeader>
        {/* v1.11.5 — the top-right "cached" label was removed: it surfaced
            an implementation detail and devalued the assessment. The card
            still consumes the warm cache; it just no longer announces it.
            v1.12.6 — the icon + title row is the canonical `<TileHeader>`.
            v1.25 — the Coach hand-off lives in the header's right slot as a
            single icon button (no text label, tooltip + accessible name),
            shared across every assessment card. Rendered only when the
            caller supplied an opener; the button self-gates on the Coach
            triple, so it never paints a dead control. */}
        <TileHeader
          icon={nodeIcon(icon)}
          title={title}
          right={
            coachQuestion ? (
              <AskCoachIconButton
                question={coachQuestion}
                scope={coachScope}
                autoSend={coachAutoSend}
              />
            ) : undefined
          }
        />
      </CardHeader>
      <CardContent className="space-y-1.5">
        {/* v1.4.27 — defence-in-depth strip. Cached status text from
            pre-v1.4.27 rows can still carry literal `metric:<TYPE>`
            tokens the model embedded on the assumption a chart would
            render inline. The sub-page never mounts the chart, so the
            token surfaces verbatim. The producer side now strips too;
            this consumer-side wrap keeps existing caches clean while
            they roll forward. */}
        <StatusBody text={stripChartTokens(displayText)} />
        <LastUpdatedFooter updatedAt={updatedAt} />
      </CardContent>
    </Card>
  );
}

/**
 * v1.4.27 — collapsible status copy. The assessment text
 * routinely lands at 3-5 paragraphs of dense narrative which dominates
 * the surface on phones. The default collapses to 3 lines via
 * `line-clamp-3`; a "Show more" toggle reveals the full body.
 *
 * v1.11.5 — the toggle now mounts only when the clamped prose actually
 * overflows three lines, measured against the live layout rather than a
 * character-count guess. The previous ~220-character heuristic painted a
 * "Show more" affordance on text that already fit (and could miss text
 * that wrapped past three lines on a narrow column), so a tap revealed
 * nothing. We compare the paragraph's `scrollHeight` against its
 * `clientHeight` while clamped; the toggle renders only on a true
 * overflow, and re-measures on resize / font load via `ResizeObserver`.
 */
function StatusBody({ text }: { text: string }) {
  // The assessment shows in full — the 3-line clamp + "show more" toggle
  // hid the prose behind an extra tap for no gain on a card whose whole
  // point is the text. Body prose reads in the regular foreground; muted
  // stays reserved for meta lines (timestamps, captions).
  return (
    <div className="text-foreground text-sm">
      <ProseBlocks text={text} />
    </div>
  );
}

function LastUpdatedFooter({ updatedAt }: { updatedAt: string | null }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // Issue #490 — boundary zone == the zone `fmt.time` renders in (mirror →
  // Berlin), so the today/yesterday bucket and the clock can never split.
  const displayTz = useDisplayTimezone();
  if (!updatedAt) return null;
  return (
    // v1.11.5 — right-aligned so the timestamp tucks to the trailing edge
    // of the card for a tidier read against the left-aligned prose above.
    //
    // v1.22 — the freshness caption is the calendar-bucketed
    // `formatUpdatedLabel` ("Updated today, 14:30" / "yesterday" / "on DD.MM."),
    // matching the briefing + per-metric cards. The day boundary follows the
    // user's profile timezone, not the browser's.
    <p className="text-muted-foreground text-right text-xs">
      {formatUpdatedLabel(updatedAt, t, fmt.dateShort, fmt.time, displayTz)}
    </p>
  );
}
