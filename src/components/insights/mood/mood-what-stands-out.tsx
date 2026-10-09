"use client";

import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorRow } from "@/components/ui/query-error-row";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { CorrelationSeasonalNote } from "@/components/insights/correlation-seasonal-note";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  MoodNarrativeFeed,
  type MoodNarrativeItem,
} from "./mood-narrative-feed";
import {
  MoodDiscoveredRelations,
  moodPairsOf,
  type CorrelationDiscoveryResponse,
} from "./mood-discovered-relations";

/**
 * v1.12.7 — the single "What stands out" card.
 *
 * The mood page used to carry TWO separate "what stands out" surfaces: the
 * narrative takeaway feed up top, and the FDR-controlled discovered relations
 * lower down — both titled "What stands out", both taking a full card. This
 * folds them into ONE card: one `TileHeader`, the narrative one-liners, then
 * the discovered day-to-day relations as a labelled subsection. Each half
 * gates independently — the card renders whatever has content and degrades to
 * nothing when both are empty, so it never paints an empty shell.
 *
 * The discovered-relations fetch lives here (the correlation-discovery surface
 * is optional and self-degrades on a 403); the narrative items arrive from the
 * mood-insights aggregate the parent already holds.
 */
export function MoodWhatStandsOut({
  narratives,
}: {
  narratives: MoodNarrativeItem[];
}) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.insightsCorrelations(),
    queryFn: async () => {
      // Correlations are statistics, never gated on AI; a rejection is a
      // real failure and renders the error row with a retry.
      return apiGet<CorrelationDiscoveryResponse>("/api/insights/correlations");
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
    retry: false,
  });

  const moodPairs = !data ? [] : moodPairsOf(data.discovered);
  const hasNarratives = narratives.length > 0;
  const hasDiscovered = moodPairs.length > 0;

  if (!hasNarratives && !isLoading && !isError && !data) return null;

  return (
    <Card data-slot="mood-what-stands-out">
      <CardHeader>
        <TileHeader
          icon={TrendingUp}
          title={t("insights.mood.narrative.title")}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {hasNarratives && <MoodNarrativeFeed items={narratives} />}
        {isLoading ? (
          <Skeleton
            data-slot="mood-discovery-loading"
            className="h-16 w-full"
          />
        ) : null}
        {isError ? (
          <QueryErrorRow
            slot="mood-discovery-error"
            message={t("insights.pattern.loadError")}
            onRetry={() => void refetch()}
          />
        ) : null}
        {data ? (
          <CorrelationSeasonalNote
            findingsBeforeSeasonalAdjustment={
              data.findingsBeforeSeasonalAdjustment
            }
          />
        ) : null}
        {!isLoading && !isError && data && !hasDiscovered ? (
          <p
            data-slot="mood-discovery-empty"
            className="text-muted-foreground text-sm"
          >
            {t("insights.pattern.empty")}
          </p>
        ) : null}
        {hasDiscovered && (
          <MoodDiscoveredRelations
            pairs={moodPairs}
            pairsTested={data?.pairsTested ?? moodPairs.length}
          />
        )}
      </CardContent>
    </Card>
  );
}
