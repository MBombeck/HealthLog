"use client";

/**
 * v1.18.1 — the cross-episode retrospective summary card ("Your illness
 * history"): how many episodes in the window, and — on demand — the typical
 * recovery gap. Retrospective only — a count of the past, never a forecast.
 *
 * v1.18.9 — the card paints instantly on a single count query
 * (`includeRecoveryGap` off). The recovery gap is the only expensive figure
 * (a bounded per-episode correlation fan-out), so it is computed LAZILY: it
 * runs only when the user opens the "Analyse" expansion, never on list load.
 */
import { useState } from "react";
import { History } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";

import { useIllnessInsights } from "./use-illness";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { EmptyState } from "@/components/ui/empty-state";

export function IllnessInsightsCard({
  windowDays = 365,
}: {
  windowDays?: number;
}) {
  const { t } = useTranslations();
  // Lightweight count read — fires on mount, no recovery-gap fan-out.
  const counts = useIllnessInsights(windowDays);

  // The heavy recovery-gap read stays disabled until the user opens it.
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const gap = useIllnessInsights(windowDays, {
    includeRecoveryGap: true,
    enabled: analyzeOpen,
  });

  const data = counts.data;
  const hasEpisodes = !counts.isError && !!data && data.episodeCount > 0;

  return (
    <Card>
      <CardHeader>
        <TileHeader
          icon={History}
          titleAs="h2"
          title={t("illness.insights.title")}
        />
      </CardHeader>
      <CardContent>
        {counts.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : counts.isError && !data ? (
          <QueryErrorRow
            inset
            error={counts.error}
            slot="illness-insights-error"
            onRetry={() => void counts.refetch()}
          />
        ) : !hasEpisodes ? (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("illness.insights.none")}
          />
        ) : (
          <div className="space-y-4 text-sm">
            <p className="text-foreground">
              {data!.episodeCount === 1
                ? t("illness.insights.countOne", {
                    count: data!.episodeCount,
                  })
                : t("illness.insights.countOther", {
                    count: data!.episodeCount,
                  })}
            </p>

            {/* The recovery gap is computed only when the user asks for it. */}
            {!analyzeOpen ? (
              <Button
                variant="outline"
                size="sm"
                className="min-h-9"
                onClick={() => setAnalyzeOpen(true)}
              >
                {t("illness.insights.analyze")}
              </Button>
            ) : gap.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : gap.isError && !gap.data ? (
              <QueryErrorRow
                inset
                error={gap.error}
                slot="illness-insights-gap-error"
                onRetry={() => void gap.refetch()}
              />
            ) : !gap.data || gap.data.typicalRecoveryGapDays === null ? (
              <p className="text-muted-foreground">
                {t("illness.insights.typicalGapLearning")}
              </p>
            ) : gap.data.gapDriverType ? (
              <p className="text-muted-foreground">
                {t("illness.insights.typicalGapWithDriver", {
                  days: gap.data.typicalRecoveryGapDays,
                  vital: t(`illness.vital.${gap.data.gapDriverType}`),
                })}
              </p>
            ) : (
              <p className="text-muted-foreground">
                {t("illness.insights.typicalGap", {
                  days: gap.data.typicalRecoveryGapDays,
                })}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
