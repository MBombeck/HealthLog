"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Gauge, ListOrdered, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/data-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { EmptyState } from "@/components/ui/empty-state";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { MetricStatStrip } from "@/components/insights/metric-stat-strip";
import { apiDelete, apiGet } from "@/lib/api/api-fetch";
import { summarize, type DataSummary } from "@/lib/analytics/trends";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { importWithRetry } from "@/lib/retry-import";

import { CustomMetricEntryForm } from "./custom-metric-entry-form";
import { CustomMetricForm } from "./custom-metric-form";
import type {
  CustomMetricDto,
  CustomMetricEntryDto,
  CustomMetricEntryListResponse,
} from "./types";

// Defer the recharts chart through `next/dynamic` (ssr:false) so recharts is
// off the detail page's first-load JS; the skeleton shell holds the layout.
const CustomMetricChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({
        default: mod.CustomMetricChart,
      }),
    ),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
function CustomMetricChart(
  props: ComponentProps<typeof CustomMetricChartLazy>,
) {
  return (
    <ChartErrorBoundary>
      <CustomMetricChartLazy {...props} />
    </ChartErrorBoundary>
  );
}

const ENTRIES_PAGE_SIZE = 200;

/**
 * v1.25.5 — per-custom-metric detail: heading + unit + static description,
 * numbers-first stat strip, the LIVE trend chart with the target band, and the
 * "show all values" sub-page link. Controls, left → right: Delete · Edit · Show
 * all values · Add value. Numeric-only. Mirrors the labs biomarker detail.
 */
export function CustomMetricDetail({
  customMetricId,
}: {
  customMetricId: string;
}) {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [addOpen, setAddOpen] = useState(false);
  const [addFooterEl, setAddFooterEl] = useState<HTMLDivElement | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editFooterEl, setEditFooterEl] = useState<HTMLDivElement | null>(null);

  const {
    data: metric,
    isError: metricError,
    refetch: refetchMetric,
  } = useQuery({
    queryKey: queryKeys.customMetricDetail(customMetricId),
    queryFn: () =>
      apiGet<CustomMetricDto>(`/api/custom-metrics/${customMetricId}`),
  });

  const {
    data: list,
    isLoading,
    isError: listError,
    refetch: refetchList,
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

  const summary = useMemo<DataSummary | null>(
    () =>
      entries.length > 0
        ? summarize(
            entries.map((r) => ({
              date: new Date(r.measuredAt),
              value: r.value,
            })),
          )
        : null,
    [entries],
  );

  function afterAdd() {
    setAddOpen(false);
    queryClient.invalidateQueries({
      queryKey: queryKeys.customMetricEntries({
        customMetricId,
        sortDir: "desc",
      }),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.customMetricDetail(customMetricId),
    });
  }

  function afterEditMetric() {
    setEditOpen(false);
    queryClient.invalidateQueries({
      queryKey: queryKeys.customMetricDetail(customMetricId),
    });
    queryClient.invalidateQueries({ queryKey: queryKeys.customMetrics() });
  }

  const deleteMetric = useMutation({
    mutationFn: () => apiDelete(`/api/custom-metrics/${customMetricId}`),
    onSuccess: () => {
      toast.success(t("customMetrics.deletedToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.customMetrics() });
      router.push("/measurements");
    },
    onError: () => toast.error(t("customMetrics.deleteError")),
  });

  const description = metric?.description?.trim()
    ? metric.description.trim()
    : t("customMetrics.detail.genericDescription");

  if (metricError || listError) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={metric?.name ?? t("customMetrics.detail.title")}
          description={description}
        />
        <QueryErrorCard
          description={t("customMetrics.loadError")}
          onRetry={() => {
            if (metricError) void refetchMetric();
            if (listError) void refetchList();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={metric?.name ?? <Skeleton className="h-7 w-32" />}
        description={description}
        actions={
          <>
            {/* Controls, left → right: Delete · Edit · Show-all-values · Add. */}
            <DeleteButton
              domain={null}
              onConfirm={() => deleteMetric.mutate()}
              title={t("customMetrics.deleteConfirmTitle")}
              description={t("customMetrics.deleteConfirmDescription")}
              confirmLabel={t("customMetrics.delete")}
              triggerTitle={t("customMetrics.delete")}
              className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              iconClassName="h-4 w-4"
            />
            <Button
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              onClick={() => setEditOpen(true)}
              disabled={!metric}
              aria-label={t("customMetrics.edit")}
              title={t("customMetrics.edit")}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            {entries.length > 0 ? (
              <Button
                asChild
                variant="ghost"
                size="icon"
                data-slot="custom-metric-show-all-values"
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              >
                <Link
                  href={`/custom-metrics/${customMetricId}/values`}
                  aria-label={t("customMetrics.showAllValues")}
                  title={t("customMetrics.showAllValues")}
                >
                  <ListOrdered className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
            <Button
              onClick={() => setAddOpen(true)}
              className="min-h-11 min-w-11 shrink-0 sm:min-h-9 sm:min-w-0"
              aria-label={t("customMetrics.addValue")}
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">
                {t("customMetrics.addValue")}
              </span>
            </Button>
          </>
        }
      />

      {/* The unit is meta about the metric, not its explainer, so it reads
          below the header rather than competing for the one description line
          every page header carries. */}
      {metric?.unit ? (
        <p className="text-muted-foreground text-sm">{metric.unit}</p>
      ) : null}

      {isLoading ? (
        <Card>
          <CardContent>
            <Skeleton className="h-60 w-full" />
          </CardContent>
        </Card>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<Gauge className="size-6" />}
              title={t("customMetrics.detail.emptyTitle")}
              description={t("customMetrics.detail.emptyDescription")}
              action={
                <Button onClick={() => setAddOpen(true)}>
                  {t("customMetrics.addValue")}
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <MetricStatStrip
            summary={summary}
            unit={metric?.unit ?? ""}
            seriesLabel={metric?.name}
            icon={Gauge}
          />
          <Card>
            <CardContent>
              <CustomMetricChart
                entries={entries}
                unit={metric?.unit ?? ""}
                targetLow={metric?.targetLow ?? null}
                targetHigh={metric?.targetHigh ?? null}
                decimals={metric?.decimals ?? null}
              />
            </CardContent>
          </Card>
        </>
      )}

      <ResponsiveSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        title={t("customMetrics.addValue")}
        description={t("customMetrics.entry.addDescription")}
        footer={
          <div ref={setAddFooterEl} className="flex w-full justify-end gap-2" />
        }
      >
        {metric ? (
          <CustomMetricEntryForm
            customMetricId={customMetricId}
            unit={metric.unit}
            footerSlot={addFooterEl}
            onSuccess={afterAdd}
            onCancel={() => setAddOpen(false)}
          />
        ) : null}
      </ResponsiveSheet>

      <ResponsiveSheet
        open={editOpen}
        onOpenChange={setEditOpen}
        title={t("customMetrics.editTitle")}
        description={t("customMetrics.defineDescription")}
        footer={
          <div
            ref={setEditFooterEl}
            className="flex w-full justify-end gap-2"
          />
        }
      >
        {metric ? (
          <CustomMetricForm
            existing={metric}
            footerSlot={editFooterEl}
            onSuccess={afterEditMetric}
            onCancel={() => setEditOpen(false)}
          />
        ) : null}
      </ResponsiveSheet>
    </div>
  );
}
