"use client";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Gauge, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { formatDate } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { CustomMetricForm } from "./custom-metric-form";
import { formatMetricValue } from "./format-value";
import type { CustomMetricDto, CustomMetricListResponse } from "./types";

/**
 * v1.25.5 — inline list of the user's custom metrics, mounted ON the
 * Measurements surface beneath the built-in measurement list (NOT a separate
 * module or nav entry). Each row shows the latest logged value and links to the
 * metric's detail + chart page; an "+ add custom metric" affordance opens the
 * define-metric sheet.
 */
export function CustomMetricList() {
  const { t } = useTranslations();
  // v1.36.x — the section is dropped whole inside somebody else's record.
  // Defining a metric is not a delegated verb, and every row here links to
  // `/custom-metrics/{id}`, which sharing does not cover: the shell turns a
  // delegate away at that route, so the rows would be doors into a wall.
  // Logging a value against a custom metric was admitted for a release and is
  // not any more: this paragraph named the gap, the release shipped over it,
  // and the write withdrew rather than the sentence staying true.
  // Every custom-metric write resolves the caller (`requireAuth`); no grant
  // reaches it at any level.
  const { inSharedRecord } = useRecordCapabilities();
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [addFooterEl, setAddFooterEl] = useState<HTMLDivElement | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.customMetrics(),
    queryFn: () => apiGet<CustomMetricListResponse>("/api/custom-metrics"),
  });

  const metrics: CustomMetricDto[] = data?.customMetrics ?? [];

  function afterAdd(saved: CustomMetricDto) {
    setAddOpen(false);
    // Land the user on the new metric's detail page so the next step (logging
    // a value) is one tap away — client nav, not a full-page reload.
    router.push(`/custom-metrics/${saved.id}`);
  }

  if (inSharedRecord) return null;

  return (
    <section
      className="border-border space-y-3 border-t pt-6"
      data-slot="custom-metric-list"
    >
      <SectionHeading
        icon={Gauge}
        title={t("customMetrics.sectionTitle")}
        subtitle={t("customMetrics.sectionSubtitle")}
        action={
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 shrink-0 sm:min-h-9"
            onClick={() => setAddOpen(true)}
            aria-label={t("customMetrics.add")}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">{t("customMetrics.add")}</span>
          </Button>
        }
      />

      {isLoading ? (
        <Card aria-hidden="true">
          <CardContent className="space-y-2 py-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </CardContent>
        </Card>
      ) : isError ? (
        <QueryErrorCard
          description={t("customMetrics.loadError")}
          onRetry={() => refetch()}
        />
      ) : metrics.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
            <Gauge className="text-muted-foreground size-6" />
            <p className="text-muted-foreground text-sm">
              {t("customMetrics.emptyDescription")}
            </p>
            <Button
              size="sm"
              onClick={() => setAddOpen(true)}
              aria-label={t("customMetrics.add")}
            >
              {t("customMetrics.add")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-border divide-y p-0">
            {metrics.map((metric) => (
              <Link
                key={metric.id}
                href={`/custom-metrics/${metric.id}`}
                className="hover:bg-muted/40 flex items-center justify-between gap-3 px-4 py-2.5 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {metric.name}
                  </div>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                    {metric.latest ? (
                      <>
                        <span className="text-foreground font-semibold tabular-nums">
                          {formatMetricValue(
                            metric.latest.value,
                            metric.decimals,
                          )}
                          {metric.unit ? ` ${metric.unit}` : ""}
                        </span>
                        <span>{formatDate(metric.latest.measuredAt)}</span>
                      </>
                    ) : (
                      <span>{t("customMetrics.noValuesYet")}</span>
                    )}
                  </div>
                </div>
                <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      <ResponsiveSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        title={t("customMetrics.defineTitle")}
        description={t("customMetrics.defineDescription")}
        footer={
          <div ref={setAddFooterEl} className="flex w-full justify-end gap-2" />
        }
      >
        <CustomMetricForm
          footerSlot={addFooterEl}
          onSuccess={afterAdd}
          onCancel={() => setAddOpen(false)}
        />
      </ResponsiveSheet>
    </section>
  );
}
