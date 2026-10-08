"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";

import { useTranslations } from "@/lib/i18n/context";
import { useWorkoutDetail } from "@/hooks/use-workouts";
import { BackLink } from "@/components/ui/back-link";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { canonicalWorkoutDetailHref } from "@/lib/workouts/canonical-detail-route";
import { DeleteWorkoutButton } from "@/components/workouts/delete-workout-button";
import { EditWorkoutButton } from "@/components/workouts/edit-workout-button";
import {
  WorkoutDetailHeader,
  WorkoutDetailStats,
  WorkoutDetailHrSection,
  WorkoutDetailZones,
  WorkoutDetailRoute,
  WorkoutDetailSplits,
  WorkoutDetailDayContext,
  WorkoutInsightCard,
} from "@/components/insights/workout-detail";

/**
 * `/insights/workouts/[id]` — workout detail surface.
 *
 * Layout, top to bottom (mobile-first single column):
 *   hero header → reserved Activity-Insight seam (renders nothing today)
 *   → stats grid + sport-average line → HR curve → effort zones → GPS
 *   route → per-km splits → "that day".
 *
 * "That day" answers the last question the page is for: what the rest of
 * the day looked like around the session. It renders the day's own pulse
 * shape, that night's sleep and the day's mood inline, all addressed by
 * the server-resolved `dayKey`.
 *
 * Every data-less section returns `null` (hide, don't render empty), so
 * an aggregates-only workout (a Strava ride with no wearable, a manual
 * entry) reads as hero + stats + "that day" — compact but honest, no
 * empty shells.
 *
 * Data flows from `GET /api/workouts/{id}?compact=1` (v1.4.32 + the #67
 * enrichment fields). The `canonicalId` pointer still resolves a
 * deep-link into a non-canonical twin; the header carries the source.
 */
export default function InsightsWorkoutDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { t } = useTranslations();
  const { id } = use(params);
  const router = useRouter();
  const { data, isLoading, error, refetch } = useWorkoutDetail(id);
  const canonicalHref = canonicalWorkoutDetailHref(id, data?.canonicalId);

  useEffect(() => {
    if (canonicalHref) router.replace(canonicalHref);
  }, [canonicalHref, router]);

  return (
    <SubPageShell
      title={t("insights.workouts.title")}
      // No description. The one this page used to carry belongs to the LIST
      // ("Recent runs, rides, walks…, deduped…") and describes a surface
      // this is not — a detail page must not claim to be the list.
      // A workout entered by hand can be edited (#1162) and deleted here;
      // both controls render nothing for a synced one.
      headerAction={
        data && !canonicalHref ? (
          <div className="flex items-center gap-1">
            <EditWorkoutButton
              workout={{
                ...data,
                storedAvgHr: data.storedAvgHr ?? null,
                storedMaxHr: data.storedMaxHr ?? null,
              }}
            />
            <DeleteWorkoutButton workout={data} />
          </div>
        ) : null
      }
      backLink={
        <BackLink
          href="/insights/workouts"
          label={t("insights.workouts.detail.backToList")}
          dataSlot="workout-detail-back"
        />
      }
    >
      {isLoading || canonicalHref ? (
        <div data-slot="workout-detail-loading" className="space-y-3">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-56 w-full rounded-lg" />
          <Skeleton className="h-60 w-full rounded-lg" />
        </div>
      ) : error ? (
        // A failed query must never read as "no data" (UI-STANDARDS §6).
        <QueryErrorCard onRetry={() => refetch()} />
      ) : !data ? (
        <p
          data-slot="workout-detail-error"
          className="text-muted-foreground text-sm"
        >
          {t("insights.workouts.detail.notFound")}
        </p>
      ) : (
        <>
          <WorkoutDetailHeader workout={data} />
          {/* The Activity Insight, above the stats it describes. `null` is the
              common case and renders nothing — the paragraph is written by a
              background job when the workout lands, so a historical or
              re-synced workout has none and opening this page never asks for
              one. */}
          {data.aiInsight ? (
            <WorkoutInsightCard insight={data.aiInsight} />
          ) : null}
          <WorkoutDetailStats workout={data} />
          <WorkoutDetailHrSection workout={data} />
          <WorkoutDetailZones workout={data} />
          <WorkoutDetailRoute workout={data} />
          <WorkoutDetailSplits workout={data} />
          <WorkoutDetailDayContext workout={data} />
        </>
      )}
    </SubPageShell>
  );
}
