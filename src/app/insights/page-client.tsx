"use client";

import { Fragment, useCallback, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { SlidersHorizontal, TrendingUp } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
// Bare number — its own React- and label-map-free module, so importing it here
// pulls neither the ECG label map/helpers nor the dynamically-loaded ECG
// component into this eager bundle.
import { ECG_OVERVIEW_LIMIT } from "@/lib/insights/ecg-overview-limit";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useInsightsLayoutQuery } from "@/hooks/use-insights-layout";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import {
  orderedVisibleSectionIds,
  type InsightsSectionId,
} from "@/lib/insights-layout";
import { useMounted } from "@/hooks/use-mounted";
import { useScrollResetOnRoute } from "@/hooks/use-scroll-reset-on-route";
import { useTranslations } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { HeroStrip } from "@/components/insights/hero-strip";
import { useInsightsAdvisorQuery } from "@/components/insights/use-insights-advisor";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import { useDashboardSnapshot } from "@/lib/queries/use-dashboard-snapshot";
import { useDashboardDerived } from "@/components/insights/derived/use-dashboard-derived";
// v1.4.41 W-ORG — shared shape lives in `src/types/analytics.ts` as
// `InsightsAnalyticsData`; aliased back to the local name to keep the
// rest of this file readable.
import type { InsightsAnalyticsData as AnalyticsData } from "@/types/analytics";

/**
 * v1.4.33 IW2 — defer the below-the-fold mother-page blocks behind
 * `next/dynamic`. `<HeroStrip>` (the only above-the-fold piece) stays an
 * eager import so the initial paint shows the greeting and health-score
 * badge without a flash; the briefing, correlation row and trends row
 * each carry their own icon-set + chart wiring (a chart card alone weighs
 * in at the lucide tree-shake limit) and used to land on every Insights
 * cold mount.
 *
 * v1.11.3 — every loader fallback now routes through the shared
 * `BlockSkeleton` instead of a bespoke `h-[Xrem] animate-pulse` div. The
 * fixed guessed heights pinned each placeholder taller (or shorter) than
 * the resolved block, so the page jumped as each chunk landed. The shared
 * skeleton carries a `min-h` floor — enough to hold the row open at cold
 * mount — and lets the block grow into its true height without fighting a
 * hard-coded pixel guess, killing the resolve-time layout shift. Reduced
 * motion is honoured by the `Skeleton` primitive (`motion-reduce:animate-none`).
 */
function BlockSkeleton({
  minHeight,
  decorative = false,
}: {
  /** Tailwind `min-h-*` utility holding the row open before the chunk lands. */
  minHeight: string;
  /** Decorative placeholders (cards that may un-mount) hide from a11y. */
  decorative?: boolean;
}) {
  return (
    <Skeleton
      {...(decorative ? { "aria-hidden": "true" } : {})}
      className={cn("w-full rounded-xl", minHeight)}
    />
  );
}

/** Stable reference so the trends row does not re-select on every render. */
const HIDDEN_MOOD = ["mood"] as const;

const DailyBriefing = dynamic(
  () =>
    import("@/components/insights/daily-briefing").then((mod) => ({
      default: mod.DailyBriefing,
    })),
  {
    ssr: false,
    loading: () => <BlockSkeleton minHeight="min-h-96" />,
  },
);
const TrendsRow = dynamic(
  () =>
    import("@/components/insights/trends-row").then((mod) => ({
      default: mod.TrendsRow,
    })),
  {
    ssr: false,
    loading: () => <BlockSkeleton minHeight="min-h-80" />,
  },
);
// v1.12.6 — the wellness-score strip, lifted OUT of the vitals dashboard so
// it renders as its own full-width section directly above the daily briefing.
// Both this strip and the vitals grid read the ONE shared derived batch the
// page owns (passed in via `batch`), so the lift adds no second request.
const WellnessScores = dynamic(
  () =>
    import("@/components/insights/derived").then((mod) => ({
      default: mod.WellnessScores,
    })),
  {
    ssr: false,
    loading: () => <BlockSkeleton minHeight="min-h-40" decorative />,
  },
);
// v1.10.0 — the Vitals dashboard (Apple-Health-Highlights grid of
// personal-typical-range + passthrough-reframe tiles). Deferred behind
// `next/dynamic` like the other below-the-fold blocks; each tile owns its
// own derived-metric query and un-mounts when its vital is absent.
const VitalsDashboard = dynamic(
  () =>
    import("@/components/insights/derived").then((mod) => ({
      default: mod.VitalsDashboard,
    })),
  {
    ssr: false,
    loading: () => <BlockSkeleton minHeight="min-h-80" />,
  },
);
// v1.10.0 — categorical events (WX-B). The device-flagged event awareness
// timeline. Deferred like the other below-the-fold blocks; the card
// un-mounts itself when the user has no such events (no skeleton-then-empty
// flash — `ssr: false` + the card's own data gate), so it carries no
// loading placeholder of its own.
const RhythmEventsCard = dynamic(
  () =>
    import("@/components/insights/rhythm-events-card").then((mod) => ({
      default: mod.RhythmEventsCard,
    })),
  { ssr: false },
);
// v1.28.50 — ECG recording surface (waveform-backed). Deferred like the
// other below-the-fold blocks; the section un-mounts itself when the user
// has no recordings (`ssr: false` + its own data gate), so it carries no
// loading placeholder of its own.
const EcgSection = dynamic(
  () =>
    import("@/components/insights/ecg-section").then((mod) => ({
      default: mod.EcgSection,
    })),
  { ssr: false },
);
// v1.25 — baseline-drift card. Un-mounts when nothing is drifting; owns its own
// read-only `/api/insights/health-status` query.
const HealthStatusCard = dynamic(
  () =>
    import("@/components/insights/health-status-card").then((mod) => ({
      default: mod.HealthStatusCard,
    })),
  { ssr: false },
);
// v1.25 — sleep-breathing screening card. Un-mounts on no data; screening
// signal only, never a diagnosis.
const BreathingScreeningCard = dynamic(
  () =>
    import("@/components/insights/breathing-screening-card").then((mod) => ({
      default: mod.BreathingScreeningCard,
    })),
  { ssr: false },
);
// v1.25 — "what changed since your last lab panel" card. Un-mounts with fewer
// than two panels or no shared analyte.
const LabsChangesCard = dynamic(
  () =>
    import("@/components/insights/labs-changes-card").then((mod) => ({
      default: mod.LabsChangesCard,
    })),
  { ssr: false },
);
// v1.10.3 — "Today's signal" headline card. Promotes COINCIDENT_DEVIATION from
// a buried below-the-fold tile to the top-of-overview daily read (the
// always-present Apple/WHOOP/Oura pattern). Deferred behind `next/dynamic`; it
// owns its own derived-metric query and renders four calm states. The chunk
// loader's skeleton shares the card's `min-h-48` footprint (and the in-card
// `CardSkeleton` matches it too) so the top of the page does not shift across
// loading → any resolved state. Decorative → `aria-hidden`.
const CoincidentDeviationCard = dynamic(
  () =>
    import("@/components/insights/coincident-deviation-card").then((mod) => ({
      default: mod.CoincidentDeviationCard,
    })),
  {
    ssr: false,
    loading: () => <BlockSkeleton minHeight="min-h-48" decorative />,
  },
);

// v1.11.0 — period-narrative card (Pillar P1). The calm "your week/month in
// review" summary, drawn from the read-only stale-while-revalidate narrative
// route. Deferred behind `next/dynamic` like the other below-the-hero blocks;
// it owns its own query and un-mounts when no narrative exists. The loader
// skeleton shares the card's `min-h-40` footprint so the page does not shift.
const PeriodNarrativeCard = dynamic(
  () =>
    import("@/components/insights/period-narrative-card").then((mod) => ({
      default: mod.PeriodNarrativeCard,
    })),
  {
    ssr: false,
    loading: () => <BlockSkeleton minHeight="min-h-40" decorative />,
  },
);

// v1.15.2 — the gated cycle-insights summary teaser. Mounted ONLY when
// `user.cycleTrackingEnabled` is true (the same /api/auth/me signal the
// sidebar nav entry gates on), so the cycle reads never fire for an account
// without the feature. Deferred behind `next/dynamic` like the other
// below-the-hero blocks; it owns its own calendar + insights reads and renders
// nothing while resolving / on error, so it carries no loading placeholder.
const CycleInsightSummaryCard = dynamic(
  () =>
    import("@/components/cycle/cycle-insight-summary-card").then((mod) => ({
      default: mod.CycleInsightSummaryCard,
    })),
  { ssr: false },
);

// v1.15.3 — the compact cycle RING, dropped into the wellness-score strip as a
// gated sibling tile (NOT the summary teaser — that stays further down). Mounted
// only for a cycle-tracking account, so its calendar read never fires otherwise.
// Deferred behind `next/dynamic`; it renders nothing while resolving / on error /
// when there is no active cycle, so it carries no loading placeholder.
const CycleRingTile = dynamic(
  () =>
    import("@/components/cycle/cycle-ring-tile").then((mod) => ({
      default: mod.CycleRingTile,
    })),
  { ssr: false },
);

/**
 * v1.4.25 W4d — Insights mother page.
 *
 * The page used to be a single 1.8k-LOC monolith that scroll-anchored
 * six per-metric sections beneath the hero. W4a/c carved those out
 * into routed sub-pages under `/insights/{slug}`; this file now holds
 * the overview-only surface:
 *
 *   - The sticky tab strip lives in `src/app/insights/layout.tsx`
 *     (the shared `<InsightsLayoutShell>` mounts it). The strip handles
 *     navigation to every sub-page + the regenerate affordance.
 *   - Hero + DailyBriefing + Trends row + advisor card stay here —
 *     they're the cross-metric overview. The per-metric correlation
 *     cards moved onto the metric pages they belong to (Weight owns
 *     weight × weekday, Pulse owns mood × pulse, …), so the overview
 *     no longer renders a duplicate correlation row.
 *   - The CoachDrawer is mounted in the mother-page body only (the maintainer
 *     directive). Navigating to a sub-page unmounts the drawer.
 *
 * The per-section status cards (BP/Weight/Pulse/etc.) and their
 * heavy chart wiring moved to the matching sub-pages.
 */

/**
 * The mother page only checks whether the comprehensive payload arrived
 * (the EmptyState gates on `!data`); the metric-specific shape lives on
 * the sub-pages now. Keep this slim — anything more is dead weight here.
 */
interface ComprehensiveData {
  totalMeasurements: number;
}

export default function InsightsPageClient() {
  const { isAuthenticated, user } = useAuth();
  const mounted = useMounted();
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // v1.30.1 M12 — the overview fans out into ~6 independent queries
  // (comprehensive / advisor / analytics / snapshot / derived batch /
  // layout) mounted by different hooks below, so there's no single
  // `refetch()` that covers the page. Refetching every currently-mounted
  // ("active") query is the same blanket approach the audit's fallback
  // suggests for PWA-resume staleness, and it's the right shape here
  // regardless of resume vs. an explicit pull.
  const refreshInsights = useCallback(
    () => queryClient.refetchQueries({ type: "active" }),
    [queryClient],
  );
  const pull = usePullToRefresh({ onRefresh: refreshInsights });

  // v1.4.33 IW9 — scroll-to-top on route mount centralised in the
  // shared `useScrollResetOnRoute()` hook. The mother page + the
  // `<SubPageShell>` both consume the same hook; the legacy duplicate
  // RAF that lived here pre-v1.4.33 produced a visible double-snap on
  // slow hydrates (chart skeletons inflating between the two
  // callbacks).
  useScrollResetOnRoute();

  // v1.4.27 R3d MB4 — Coach drawer state lives in the layout-level
  // `<CoachLaunchProvider>`; the drawer is mounted next to the provider in
  // `src/app/insights/layout.tsx`. v1.18.7 removed the hero-band coach
  // entry points (the action button + suggested-prompt chips), so the
  // overview page no longer reads the launch context — the drawer + its
  // own launcher stay untouched.
  const flags = useFeatureFlags();

  // v1.4.36 W1 — drop the page-level `isLoading` gate that used to
  // block the entire shell on `/api/insights/comprehensive`. The
  // comprehensive payload still feeds the empty-state decision but
  // every other section now mounts in parallel under its own
  // <Suspense> boundary, so the user sees the hero + tile skeletons
  // within ~500 ms instead of waiting on the slowest fan-out. The
  // empty-state branch only fires once the query has resolved AND
  // reported zero measurements; while it's in-flight the page paints
  // the regular shell and the tiles fill in as their data lands.
  const { data, isLoading, isFetched, isError, refetch } = useQuery({
    queryKey: queryKeys.insightsComprehensive(),
    queryFn: async () => {
      try {
        return await apiGet<ComprehensiveData>("/api/insights/comprehensive");
      } catch {
        throw new Error(t("insights.loadError"));
      }
    },
    enabled: isAuthenticated,
  });

  // The advisor query is also mounted by the layout shell; the page
  // consumer re-reads from the same cache key so this call is free
  // beyond the React-state subscription.
  const advisor = useInsightsAdvisorQuery(isAuthenticated);

  // v1.4.33 IW2 — the mother page reads `healthScore` (a thick-only
  // field) for the hero score card, so it stays on the default thick
  // slice. The shared hook still centralises the cache settings so the
  // consumer dedups with the sub-page mounts that ride the slim slice
  // instead. Correlations now live on the per-metric pages, so the
  // overview no longer reads `analytics.correlations`.
  const analyticsQuery = useAnalyticsQuery();
  const analytics = analyticsQuery.data as AnalyticsData | undefined;

  // v1.21.2 (A5 / A6) — the dashboard snapshot is the single server source
  // for the ambient narrative the hero surfaces: the Tension Verdict and
  // return-to-baseline ride its `healthScore`. The hero score number itself
  // stays on the analytics payload (unchanged). Reads the same shared
  // `queryKeys.dashboardSnapshot()` cell the dashboard warms, so the insights
  // visit pays at most one extra round-trip and usually a warm cache hit.
  // (The A4 recall/forward-look block left the briefing card — the card now
  // opens straight on the day's signals.)
  const snapshotQuery = useDashboardSnapshot(isAuthenticated);
  const snapshotHealthScore = snapshotQuery.data?.healthScore ?? null;
  const heroTension = snapshotHealthScore?.tension ?? null;
  const heroReturnToBand = snapshotHealthScore?.returnToBand ?? null;

  // v1.12.6 — the page owns the ONE overview derived batch. The wellness
  // strip (above the briefing) and the vitals grid (below it) both read this
  // single query instance, so the wellness lift adds no second request.
  const dashboardDerived = useDashboardDerived(isAuthenticated);

  // v1.15.11 W2 — the resolved overview layout (sections + tiles). Drives
  // both the section render order/visibility below and the Vitals grid's
  // per-tile order/visibility (passed into <VitalsDashboard>). Defaults to
  // the canonical layout while in-flight so the first paint matches the
  // default order with no flicker.
  // v1.15.18 — the overview layout (sections + tiles) still drives the section
  // render order/visibility + the Vitals grid below. CUSTOMISING it (and the
  // nav-pill order) moved out of an in-page "Anpassen" edit mode into
  // Settings → Insights, reached via the top-right cog on the tab strip.
  const { layout } = useInsightsLayoutQuery(isAuthenticated);

  // Error branch — a transient 500 / network drop (after the query's
  // retries are exhausted) settles the comprehensive query with no data.
  // Without this gate the page would fall through to the "no data yet —
  // add a measurement" empty-state, which reads false for a user with
  // history. Surface an error + a Retry that refetches the one query,
  // mirroring the <VitalsDashboard> error pattern.
  if (isError) {
    return (
      <div data-slot="insights-overview-error">
        <QueryErrorCard
          description={t("insights.loadError")}
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  // Empty-state shortcut — only paint once the comprehensive query has
  // resolved AND reported zero measurements. While it's in-flight we
  // fall through to the streamed shell so the user gets the hero +
  // skeleton tiles inside the first paint budget.
  if (!isLoading && isFetched && !data) {
    return (
      <EmptyState
        icon={<TrendingUp className="size-6" />}
        title={t("insights.emptyTitle")}
        description={t("insights.emptyDescription")}
        ctaSize="lg"
        action={
          <Button size="sm" asChild>
            <Link href="/measurements">
              {t("insights.emptyAddMeasurement")}
            </Link>
          </Button>
        }
      />
    );
  }

  // Gated on `mounted`: the auth query can resolve before this
  // boundary hydrates, and a greeting that personalises during the
  // hydration render disagrees with the name-less SSR text — React
  // #418. See `useMounted`.
  const heroGreetingName =
    mounted && user?.username?.trim() && user.username.trim().length > 0
      ? user.username.split(/\s+/)[0]
      : null;
  const briefingPayload = advisor.payload?.dailyBriefing ?? null;
  const heroStripUpdatedAt = advisor.payload?.cachedAt ?? null;

  // v1.4.36 QA C2 — no `<Suspense>` wrappers below. The mother page is
  // `"use client"`, the below-the-fold blocks load via `next/dynamic`
  // with `{ ssr: false }` (no Promise-throw on hydrate), and the
  // TanStack Query hooks each return their own loading state without
  // ever throwing a thenable. Wrapping these in `<Suspense>` would be
  // dead code — Suspense never engages and the `loading` props inside
  // each section already drive the skeleton. The perceptual win we
  // ship is "early-skeleton paint": the page-level `isLoading` gate is
  // gone, the hero + each section's own loader skeleton paints inside
  // the first paint budget while data fills in. Genuinely streamed
  // server children would require a Server-Component refactor; that's
  // a v1.5.x track.

  // v1.12.6 — overview section order, top → bottom:
  //   1. "Guten Morgen" Hero + Coach questions (HeroStrip).
  //   2. Wellnesswerte — the wellness-score strip (lifted OUT of
  //      <VitalsDashboard> so it sits ABOVE the briefing as its own
  //      full-width section).
  //   3. "Heute auf einen Blick" briefing (DailyBriefing).
  //   4. Vitalwerte — the vitals grid (+ mobility) inside <VitalsDashboard>,
  //      which no longer renders the wellness strip.
  //   5. Trends (TrendsRow).
  //   6. "Dein Zeitraum im Rückblick" retrospective (PeriodNarrativeCard).
  //   7. "Signale des Tages" — today's signal (CoincidentDeviationCard) plus
  //      the rhythm-events alert timeline, kept out of the AI gate so a
  //      health alert is never hidden.
  // The wellness strip and the vitals grid share the ONE `dashboardDerived`
  // batch the page owns — one request, two sections. The per-metric
  // correlation cards moved onto the metric pages, so the overview renders no
  // correlation row. The duplicate footer "prepare assessments" control was
  // removed in v1.12.4 — the tab-strip regenerate button is the single
  // affordance. The generic disclaimer lives once in the layout-shell footer.

  // v1.15.11 W2 — decouple the section render order from the JSX. Each section
  // id maps to its existing node here; the customizable region below renders
  // `orderedVisibleSectionIds(layout)` against this registry. Every existing
  // feature/data gate is preserved INSIDE each entry: a section the layout
  // marks visible but whose gate is off (briefing flag, cycle-enabled) still
  // resolves to `null`, exactly as today. With the default layout the order +
  // gates reproduce the pre-v1.15.11 page byte-for-byte. HeroStrip stays
  // anchored above this region, OUTSIDE the customizable set.
  const SECTION_REGISTRY: Record<InsightsSectionId, ReactNode> = {
    "wellness-scores": (
      <WellnessScores
        read={dashboardDerived.read}
        isLoading={dashboardDerived.isLoading}
        isError={dashboardDerived.isError}
        refetch={dashboardDerived.refetch}
        // v1.15.3 — the cycle ring rides the scores strip as a gated sibling
        // tile, only for a cycle-tracking account, so its calendar read never
        // fires otherwise (the same `/api/auth/me` gate the sidebar nav uses).
        // v1.18.0 — gate on the resolved `modules.cycle` flag (per-user toggle
        // AND the operator server-wide kill-switch) so an operator-off
        // instance never renders the ring nor fires its calendar read.
        extraTile={
          user?.modules?.cycle === true ? <CycleRingTile /> : undefined
        }
        // v1.15.5 — when the cycle ring is shown it TAKES the Strain slot:
        // hide Strain so the strip stays compact instead of growing a sixth
        // tile. Strain stays visible for non-cycle accounts.
        hideStrain={user?.modules?.cycle === true}
      />
    ),
    "daily-briefing": flags.briefing ? (
      <DailyBriefing
        briefing={briefingPayload}
        updatedAt={heroStripUpdatedAt}
        loading={advisor.isLoading}
        onRegenerate={advisor.regenerate}
        regenerating={advisor.isRegenerating}
        // v1.15.20 — the read path reports a 422 (no provider configured)
        // as its own outcome; swap the futile regenerate CTA for a quiet
        // Settings → AI hint instead of an eternal "preparing" loop.
        noProvider={advisor.readOutcome === "no-provider"}
        // v1.18.9 (#4) — a (stale) cached briefing is shown but no provider
        // is connected, so it can never refresh. Pair the relative-age
        // footer with a discreet connect-provider hint. Only fires when a
        // briefing is actually rendered (the empty-state path owns the
        // `noProvider` branch above).
        noProviderStale={briefingPayload !== null && !advisor.hasProvider}
        // v1.25 — the last generation attempt failed. On a held briefing this
        // adds a discreet "couldn't refresh — retry" footer hint; on an empty
        // card it swaps the generic empty state for an honest "couldn't
        // generate" one. Suppressed when no provider is configured (that hint
        // owns the surface and a retry would be futile).
        generationFailed={advisor.generationFailed && advisor.hasProvider}
        // v1.25.3 — failure class points the empty-state hint at the right
        // lever (raise the response timeout vs re-check the provider).
        generationFailureClass={advisor.generationFailureClass}
        // v1.28.28 (#470) — the grounding gate stripped the last regenerated
        // briefing; the card explains the omission instead of "no briefing
        // yet" (which made the regenerate button read as doing nothing).
        omittedReason={advisor.briefingOmittedReason}
      />
    ) : null,
    vitals: <VitalsDashboard batch={dashboardDerived} layout={layout} />,
    trends: (
      <TrendsRow
        briefing={briefingPayload}
        // Same module gate the tab strip applies to the Mood pill: with
        // the mood module off, the trends row does not chart mood either.
        hiddenMetrics={user?.modules?.mood === false ? HIDDEN_MOOD : undefined}
        annotations={advisor.payload?.trendAnnotations ?? null}
        loading={advisor.isLoading || advisor.isRegenerating}
      />
    ),
    "period-review": flags.briefing ? (
      <PeriodNarrativeCard enabled={isAuthenticated} />
    ) : null,
    // v1.15.2 — gated cycle teaser. Render only for a cycle-tracking account;
    // for everyone else this is nothing (no card, no layout gap). The card
    // itself stays silent until its reads resolve.
    "cycle-summary": user?.cycleTrackingEnabled ? (
      <CycleInsightSummaryCard />
    ) : null,
    signals: <CoincidentDeviationCard enabled={isAuthenticated} />,
    "rhythm-events": <RhythmEventsCard enabled={isAuthenticated} />,
    "health-status": <HealthStatusCard enabled={isAuthenticated} />,
    breathing: <BreathingScreeningCard enabled={isAuthenticated} />,
    "labs-changes": <LabsChangesCard enabled={isAuthenticated} />,
    ecg: <EcgSection enabled={isAuthenticated} limit={ECG_OVERVIEW_LIMIT} />,
  };

  const orderedSectionIds = orderedVisibleSectionIds(layout);
  const everySectionHidden = orderedSectionIds.length === 0;

  return (
    // v1.12.7 (L3) — one consistent vertical rhythm down the overview. The
    // page used `space-y-8` (32 px) between top-level blocks while the vitals
    // wrap used `space-y-6` (24 px), so the overview read as two tiers. Unify
    // to `space-y-6` — it matches the vitals wrap and tightens the overview in
    // line with the "Insights gives away too much space" direction.
    //
    // v1.15.10 — `space-y-6` is now the SINGLE inter-section gap, top to
    // bottom. Every section renders as a real `<section>` (or `null` — never a
    // `display: contents` wrapper, which used to collapse the cycle-summary box
    // so `space-y` skipped its margin and the cycle→signals seam read as
    // zero-gap). Each section owns its OWN `SectionHeading` + `space-y-3` to its
    // card, so the rhythm is even regardless of which sections are present.
    <div className="space-y-6">
      <PullToRefreshIndicator {...pull} />
      <HeroStrip
        briefing={briefingPayload}
        updatedAt={heroStripUpdatedAt}
        userName={heroGreetingName}
        // v1.18.9 (#4) — the hero subtitle is the cached briefing paragraph;
        // when it can never refresh (no AI provider) pair the "Generated
        // <relative>" line with a discreet connect-provider hint, matching
        // the briefing card footer. Only when a briefing is actually shown.
        noProviderStale={briefingPayload !== null && !advisor.hasProvider}
        // The Health Score lives in the band's right column and NOWHERE else
        // on this page. It is deliberately not a registry section: an id a
        // saved layout has never seen merges in as default-INVISIBLE
        // (`orderedVisibleSectionIds`), so registering it would silently
        // delete the score for every account that has ever customised this
        // page. It is also outside the daily-briefing branch, so an instance
        // with the briefing switched off keeps the whole breakdown.
        healthScore={analytics?.healthScore ?? null}
        // `isPending` settles false on success AND error, so a no-score
        // account drops the reserve exactly once.
        scorePending={analyticsQuery.isPending && !analytics}
        // v1.21.2 (A5 / A6) — server-resolved Tension Verdict + return-to-
        // baseline off the dashboard snapshot. The panel localises the keys;
        // null leaves it quiet.
        tension={heroTension}
        returnToBand={heroReturnToBand}
        // A pillar whose read FAILED is a named line inside the panel, and the
        // retry there refetches the payload that carries every pillar.
        onScoreRetry={() => void analyticsQuery.refetch()}
      />

      {/* v1.15.18 — the inline "Anpassen" toggle was removed. Customising the
          overview (section show/hide + order) and sorting the nav pills now
          live ONLY in Settings → Insights, reached via the top-right cog on the
          tab strip — no duplicate in-page entry point. */}
      {everySectionHidden ? (
        /* v1.15.18 — empty-state: every section hidden. The page is never
           blank — surface a hint + a link to the Insights settings section so
           the user can bring sections back. */
        <EmptyState
          icon={<SlidersHorizontal className="size-6" />}
          title={t("insights.editMode.emptyTitle")}
          description={t("insights.editMode.emptyDescription")}
          ctaSize="lg"
          action={
            <Button size="sm" asChild>
              <Link href="/settings/layout/insights">
                {t("insights.customize")}
              </Link>
            </Button>
          }
        />
      ) : (
        /* v1.15.11 W2 — the customizable region: sections render in the
           resolved layout order, skipping any the user has hidden. A
           layout-visible-but-gate-off section resolves to `null` from the
           registry, so the `space-y-6` rhythm closes the gap with no hole.
           Each registry node is wrapped in a keyed Fragment so React keeps a
           stable identity across a reorder. */
        orderedSectionIds.map((id) => (
          <Fragment key={id}>{SECTION_REGISTRY[id]}</Fragment>
        ))
      )}
    </div>
  );
}
