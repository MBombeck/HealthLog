"use client";

import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { CustomMetricHistoryList } from "./custom-metric-history-list";
import type {
  CustomMetricDto,
  CustomMetricEntryDto,
  CustomMetricEntryListResponse,
} from "./types";
import { EmptyState } from "@/components/ui/empty-state";

const ENTRIES_PAGE_SIZE = 200;

/**
 * v1.25.5 — the full value history for one custom metric, on its own
 * `/custom-metrics/[id]/values` route (mirroring the labs values sub-page).
 * Offset-paginated infinite query with "Load more".
 */
export function CustomMetricValuesList({
  customMetricId,
}: {
  customMetricId: string;
}) {
  const { t } = useTranslations();

  const { data: metric } = useQuery({
    queryKey: queryKeys.customMetricDetail(customMetricId),
    queryFn: () =>
      apiGet<CustomMetricDto>(`/api/custom-metrics/${customMetricId}`),
  });

  const {
    data: list,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: queryKeys.customMetricEntries({
      customMetricId,
      sortDir: "desc",
    }),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiGet<CustomMetricEntryListResponse>(
        `/api/custom-metrics/${encodeURIComponent(
          customMetricId,
        )}/entries?limit=${ENTRIES_PAGE_SIZE}&offset=${pageParam}&sortDir=desc`,
      ),
    getNextPageParam: (lastPage) => {
      const next = lastPage.meta.offset + lastPage.meta.limit;
      return next < lastPage.meta.total ? next : undefined;
    },
  });

  const entries: CustomMetricEntryDto[] = useMemo(
    () => list?.pages.flatMap((p) => p.entries) ?? [],
    [list],
  );
  const total = list?.pages[0]?.meta.total ?? 0;

  // The error state was honest but a dead end: one red sentence, no way to try
  // again short of navigating away and back. QueryErrorCard carries the same
  // message with a retry, matching the sibling custom-metric list.
  if (isError) {
    return (
      <QueryErrorCard
        error={error}
        description={t("customMetrics.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }

  if (isLoading) {
    return <Skeleton className="h-60 w-full" />;
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title={t("customMetrics.detail.emptyTitle")}
      />
    );
  }

  return (
    <div className="space-y-2">
      {hasNextPage ? (
        <p className="text-muted-foreground text-xs">
          {t("customMetrics.showingLatestOf", {
            shown: entries.length,
            total,
          })}
        </p>
      ) : null}
      <Card>
        <CardContent className="py-0">
          <CustomMetricHistoryList
            customMetricId={customMetricId}
            entries={entries}
            unit={metric?.unit ?? ""}
            decimals={metric?.decimals ?? null}
          />
        </CardContent>
      </Card>
      {hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={isFetchingNextPage}
            onClick={() => fetchNextPage()}
          >
            {isFetchingNextPage
              ? t("common.loading")
              : t("customMetrics.loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
