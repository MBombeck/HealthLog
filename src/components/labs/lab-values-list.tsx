"use client";

import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { LabHistoryList } from "./lab-history-list";
import type { LabResultDto, LabResultListResponse } from "./types";
import { EmptyState } from "@/components/ui/empty-state";

// Page size for the offset-paginated reading feed. The server caps a single
// read at 500 (`listLabResultsSchema`); this stays well under that and keeps
// the first paint light, with "Load more" pulling subsequent pages.
const READINGS_PAGE_SIZE = 200;

/**
 * v1.25.1 — the full reading history for one biomarker, lifted off the detail
 * page onto its own `/labs/[biomarkerId]/values` route (mirroring the metric
 * sub-pages' `/insights/values/<type>` split). The detail page keeps the
 * numbers-first spine; this is the raw, editable reading feed with "Load more".
 * Reuses the same offset-paginated infinite query key as the detail page so the
 * two share cache.
 */
export function LabValuesList({ biomarkerId }: { biomarkerId: string }) {
  const { t } = useTranslations();

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
    queryKey: queryKeys.labResultsInfinite({ biomarkerId, sortDir: "desc" }),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiGet<LabResultListResponse>(
        `/api/labs?biomarkerId=${encodeURIComponent(
          biomarkerId,
        )}&limit=${READINGS_PAGE_SIZE}&offset=${pageParam}&sortDir=desc`,
      ),
    getNextPageParam: (lastPage) => {
      const next = lastPage.meta.offset + lastPage.meta.limit;
      return next < lastPage.meta.total ? next : undefined;
    },
  });

  const readings: LabResultDto[] = useMemo(
    () => list?.pages.flatMap((p) => p.results) ?? [],
    [list],
  );
  const total = list?.pages[0]?.meta.total ?? 0;
  const truncated = hasNextPage ?? false;

  if (isError) {
    return (
      <QueryErrorCard
        error={error}
        title={t("labs.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }

  if (isLoading) {
    return <Skeleton className="h-60 w-full" />;
  }

  if (readings.length === 0) {
    return <EmptyState variant="plain" title={t("labs.detail.emptyTitle")} />;
  }

  return (
    <div className="space-y-2">
      {truncated ? (
        <p className="text-muted-foreground text-xs">
          {t("labs.showingLatestOf", {
            shown: readings.length,
            total,
          })}
        </p>
      ) : null}
      <Card>
        <CardContent className="py-0">
          <LabHistoryList readings={readings} />
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
              : t("labs.loadMoreReadings")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
