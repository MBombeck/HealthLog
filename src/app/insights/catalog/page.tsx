"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ChevronRight,
  Droplet,
  Ear,
  Footprints,
  HeartPulse,
  Moon,
  Pill,
  Scale,
  Siren,
  Sun,
  Waves,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { TileHeader } from "@/components/insights/tile-header";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { useAuth } from "@/hooks/use-auth";
import { useWorkouts } from "@/hooks/use-workouts";
import { isSurfaceVisible } from "@/lib/modules/surface";
import { useTranslations } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import {
  hasMetricData,
  type InsightInputs,
} from "@/lib/insights/metric-availability";
import {
  CATALOG_GROUP_HEADER_KEYS,
  CATALOG_GROUP_ORDER,
  catalogEntriesByGroup,
  type CatalogEntry,
} from "@/lib/insights/metric-catalog";
import type { ManagerGroup } from "@/lib/insights/sub-page-metric";

/**
 * `/insights/catalog` — "what can HealthLog track" (2026-07-17
 * discoverability audit, recommendation R1).
 *
 * A single, on-purpose surface: every metric domain HealthLog supports,
 * grouped, each row showing its name, whether THIS account has data for
 * it yet, what supplies it (device-concrete, vendor-neutral), and — when
 * absent and a device could supply it — a quiet CTA into
 * `/settings/integrations`. This is deliberately NOT surfaced in the
 * daily nav: metrics with no data stay hidden from the dashboard /
 * Insights tab strip by design (`metric-availability.ts` — "a metric
 * with zero observations doesn't surface a navigation target the user
 * can't act on"), so an account with a sparse device kit would otherwise
 * have no reachable evidence a capability exists at all. This page is
 * that evidence, reached only when the user navigates here on purpose
 * (the quiet "All metrics" pill at the tail of the Insights tab strip,
 * see `insights-tab-strip.tsx`).
 *
 * Presence per row reuses the EXACT gating inputs the tab strip / nav
 * pills already compute (`hasMetricData` over the shared analytics +
 * comprehensive + workouts + nutrients reads) — this page adds no new
 * server route and no new derivation of "does the user have this metric".
 * The ECG row is the one exception: ECG carries no `MeasurementType`, so
 * its presence comes from the same `hasRecordings` probe the overview's
 * `<EcgSection>` already reads.
 */

interface ComprehensivePayload {
  moodSummary: { count: number } | null;
  medications: Array<{ id: string }>;
}

const GROUP_ICONS: Record<ManagerGroup, LucideIcon> = {
  vitals: Activity,
  body: Scale,
  activity: Footprints,
  sleep: Moon,
  heart: HeartPulse,
  hearing: Ear,
  environment: Sun,
  metabolic: Droplet,
  mood: Waves,
  events: Pill,
};

function StatusBadge({ present }: { present: boolean }) {
  const { t } = useTranslations();
  if (present) {
    return (
      <Badge
        variant="outline"
        className="border-success/40 bg-success/15 text-success shrink-0"
      >
        {t("metricCatalog.statusPresent")}
      </Badge>
    );
  }
  return (
    <span className="text-muted-foreground shrink-0 text-xs">
      {t("metricCatalog.statusAbsent")}
    </span>
  );
}

/**
 * Row placeholder shown while the availability probes are still
 * in flight — same anatomy as a loaded `CatalogRow` (name line + a
 * trailing action-sized block) so the group cards don't reflow when
 * the real status lands. Never renders the "Not tracked yet" copy or
 * a CTA — an in-flight probe is not the same thing as a confirmed
 * absence (M1, `.planning/audits/2026-07-18-qa-ui.md`).
 */
function CatalogRowSkeleton() {
  return (
    <div
      data-slot="catalog-row-skeleton"
      className="flex items-start justify-between gap-3 py-2"
    >
      {/* Sized to the loaded row (a 22 px name-and-badge line over a 16 px
          source line), so the groups below do not move when it lands. */}
      <div className="min-w-0 flex-1 space-y-1">
        <Skeleton className="h-5.5 w-32" />
        <Skeleton className="h-3 w-48" />
      </div>
      <Skeleton className="h-8 w-20 shrink-0" />
    </div>
  );
}

function CatalogRow({
  entry,
  present,
}: {
  entry: CatalogEntry;
  /** `"unknown"` while the read that decides this row failed. */
  present: boolean | null | "unknown";
}) {
  const { t } = useTranslations();

  if (entry.kind === "info") {
    return (
      <div data-slot="catalog-row-info" className="flex items-start gap-2 py-2">
        <Siren className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">
            {t(entry.nameKey)}
          </p>
          <p className="text-muted-foreground text-xs">{t(entry.sourceKey)}</p>
        </div>
      </div>
    );
  }

  const isPresent = present === true;
  const unknown = present === "unknown";

  return (
    <div
      data-slot="catalog-row"
      data-metric-id={entry.id}
      className="flex items-start justify-between gap-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground text-sm font-medium">
            {t(entry.nameKey)}
          </span>
          {unknown ? null : <StatusBadge present={isPresent} />}
        </div>
        <p className="text-muted-foreground text-xs">{t(entry.sourceKey)}</p>
      </div>
      <div className="shrink-0">
        {unknown ? null : isPresent && entry.href ? (
          <Button size="sm" variant="ghost" asChild>
            <Link href={entry.href}>
              {t("metricCatalog.viewCta")}
              <ChevronRight className="size-3.5" />
            </Link>
          </Button>
        ) : !isPresent && entry.connectable ? (
          <Button size="sm" variant="outline" asChild>
            <Link href="/settings/integrations">
              {t("metricCatalog.connectCta")}
            </Link>
          </Button>
        ) : !isPresent && entry.manualHref && entry.manualCtaKey ? (
          <Button size="sm" variant="outline" asChild>
            <Link href={entry.manualHref}>{t(entry.manualCtaKey)}</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Which read decides whether a catalog row has data. */
type ProbeId = "analytics" | "comprehensive" | "workouts" | "nutrients" | "ecg";

function probeForEntry(entry: CatalogEntry): ProbeId {
  if (entry.id === "ecg") return "ecg";
  if (entry.metric === "MOOD" || entry.metric === "MEDICATION") {
    return "comprehensive";
  }
  if (entry.metric === "WORKOUTS") return "workouts";
  if (entry.metric === "NUTRIENTS") return "nutrients";
  return "analytics";
}

/**
 * The surface id of the sub-page a catalog row links to, so a row whose
 * module is switched off drops out through the one surface map. Rows without
 * a sub-page (info rows, the ECG row) have no owner and always show.
 */
function entrySurfaceId(entry: CatalogEntry): string | null {
  const slug = entry.href?.startsWith("/insights/")
    ? entry.href.slice("/insights/".length).split(/[/?#]/)[0]
    : null;
  return slug ? `insights-page:${slug}` : null;
}

export default function MetricCatalogPage() {
  const { t } = useTranslations();
  const { isAuthenticated, user } = useAuth();
  const modules = user?.modules;

  const analyticsQuery = useAnalyticsQuery({ slice: "summaries" });

  const comprehensiveQuery = useQuery({
    queryKey: queryKeys.insightsComprehensive(),
    queryFn: () => apiGet<ComprehensivePayload>("/api/insights/comprehensive"),
    enabled: isAuthenticated,
  });

  // Probe workouts only while the module shows; a switched-off module is
  // never asked for rows, and its row is dropped below.
  const workoutsVisible = isSurfaceVisible("insights-page:workouts", modules);
  const workoutsProbe = useWorkouts({ limit: 1, enabled: workoutsVisible });

  const nutrientsModuleEnabled = user?.modules?.nutrients === true;
  const nutrientsProbe = useQuery({
    queryKey: queryKeys.nutrientIntake(1),
    queryFn: () =>
      apiGet<{ nutrients: Array<{ nutrient: string }> }>(
        "/api/nutrients?days=1",
      ),
    enabled: isAuthenticated && nutrientsModuleEnabled,
  });

  const ecgQuery = useQuery({
    queryKey: queryKeys.insightsEcgList(),
    queryFn: () => apiGet<{ hasRecordings: boolean }>("/api/insights/ecg"),
    enabled: isAuthenticated,
  });

  const availability: InsightInputs | undefined = isAuthenticated
    ? {
        summaries: analyticsQuery.data?.summaries,
        hasMood: (comprehensiveQuery.data?.moodSummary?.count ?? 0) > 0,
        hasMedication: (comprehensiveQuery.data?.medications?.length ?? 0) > 0,
        hasWorkouts: (workoutsProbe.data?.workouts.length ?? 0) > 0,
        hasNutrients: (nutrientsProbe.data?.nutrients.length ?? 0) > 0,
      }
    : undefined;

  const grouped = catalogEntriesByGroup();

  // M1 fix (`.planning/audits/2026-07-18-qa-ui.md`) — every probe backing
  // `availability` is async; while one is in flight `hasMetricData()` reads
  // an undefined summary and would report "absent". Each row waits on the
  // ONE probe that decides it, and a failed probe marks only its own rows
  // unknown with a retry inside their group: one failing read never replaces
  // the whole page, and never reads as an honest "Not tracked yet".
  const probes: Record<
    ProbeId,
    { isLoading: boolean; isError: boolean; retry: () => void }
  > = {
    analytics: {
      isLoading: analyticsQuery.isLoading,
      isError: analyticsQuery.isError,
      retry: () => void analyticsQuery.refetch(),
    },
    comprehensive: {
      isLoading: comprehensiveQuery.isLoading,
      isError: comprehensiveQuery.isError,
      retry: () => void comprehensiveQuery.refetch(),
    },
    workouts: {
      isLoading: workoutsProbe.isLoading,
      isError: workoutsProbe.isError,
      retry: () => workoutsProbe.refetch(),
    },
    nutrients: {
      isLoading: nutrientsModuleEnabled && nutrientsProbe.isLoading,
      isError: nutrientsModuleEnabled && nutrientsProbe.isError,
      retry: () => void nutrientsProbe.refetch(),
    },
    ecg: {
      isLoading: ecgQuery.isLoading,
      isError: ecgQuery.isError,
      retry: () => void ecgQuery.refetch(),
    },
  };

  function isPresent(entry: CatalogEntry): boolean | null {
    if (entry.kind === "info") return null;
    if (entry.id === "ecg") return ecgQuery.data?.hasRecordings === true;
    if (!availability || !entry.metric) return false;
    return hasMetricData(entry.metric, availability);
  }

  function isEntryVisible(entry: CatalogEntry): boolean {
    // Nutrients keeps its own module-off row with the way to switch it on.
    if (entry.id === "nutrients") return true;
    const surfaceId = entrySurfaceId(entry);
    return surfaceId === null || isSurfaceVisible(surfaceId, modules);
  }

  return (
    <SubPageShell
      title={t("metricCatalog.title")}
      description={t("metricCatalog.description")}
    >
      <div className="space-y-6">
        {CATALOG_GROUP_ORDER.map((group) => {
          const entries = (grouped.get(group) ?? []).filter(isEntryVisible);
          if (entries.length === 0) return null;
          const failed = [
            ...new Set(
              entries
                .filter((entry) => entry.kind !== "info")
                .map(probeForEntry)
                .filter((id) => isAuthenticated && probes[id].isError),
            ),
          ];
          const Icon = GROUP_ICONS[group];
          // Nutrients rides the metabolic group but needs a module-off
          // branch (B1 — the tab-strip pill requires the module ON before
          // it ever probes for rows, so a module-off account never saw
          // the in-context enable CTA; this row is the fix).
          return (
            <Card
              key={group}
              data-slot="catalog-group"
              className="gap-2 py-3 md:py-4"
            >
              <CardHeader>
                <TileHeader
                  icon={Icon}
                  title={t(CATALOG_GROUP_HEADER_KEYS[group])}
                />
              </CardHeader>
              <CardContent className="space-y-2">
                {failed.length > 0 ? (
                  <QueryErrorRow
                    slot="catalog-group-error"
                    message={t("metricCatalog.loadError")}
                    onRetry={() => failed.forEach((id) => probes[id].retry())}
                  />
                ) : null}
                <div className="divide-border divide-y">
                  {entries.map((entry) => {
                    if (entry.id === "nutrients" && !nutrientsModuleEnabled) {
                      return (
                        <div
                          key={entry.id}
                          data-slot="catalog-row"
                          data-metric-id="nutrients"
                          className="flex items-start justify-between gap-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-foreground text-sm font-medium">
                                {t(entry.nameKey)}
                              </span>
                              <span className="text-muted-foreground shrink-0 text-xs">
                                {t("metricCatalog.statusModuleOff")}
                              </span>
                            </div>
                            <p className="text-muted-foreground text-xs">
                              {t("nutrients.page.moduleOffDescription")}
                            </p>
                          </div>
                          <div className="shrink-0">
                            <Button size="sm" variant="outline" asChild>
                              <Link href="/settings/modules">
                                {t("nutrients.page.moduleOffCta")}
                              </Link>
                            </Button>
                          </div>
                        </div>
                      );
                    }
                    const probe =
                      entry.kind === "info"
                        ? null
                        : probes[probeForEntry(entry)];
                    if (isAuthenticated && probe?.isLoading) {
                      return <CatalogRowSkeleton key={entry.id} />;
                    }
                    return (
                      <CatalogRow
                        key={entry.id}
                        entry={entry}
                        present={
                          isAuthenticated && probe?.isError
                            ? "unknown"
                            : isPresent(entry)
                        }
                      />
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </SubPageShell>
  );
}
