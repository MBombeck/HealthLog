"use client";

import {
  useRecordCapabilities,
  holdsOwnerRights,
} from "@/hooks/use-record-capabilities";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Gauge, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { CustomMetricForm } from "./custom-metric-form";
import { formatMetricValue } from "./format-value";
import type { CustomMetricDto, CustomMetricListResponse } from "./types";
import { ListGroup, ListItem } from "@/components/ui/list-row";

/**
 * v1.25.5 — inline list of the user's custom metrics, mounted ON the
 * Measurements surface beneath the built-in measurement list (NOT a separate
 * module or nav entry). Each row shows the latest logged value and links to the
 * metric's detail + chart page; an "+ add custom metric" affordance opens the
 * define-metric sheet.
 */
export function CustomMetricList() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // v1.36.x — the section is dropped whole inside somebody else's record.
  // Defining a metric is not a delegated verb, and every row here links to
  // `/custom-metrics/{id}`, which sharing does not cover: the shell turns a
  // delegate away at that route, so the rows would be doors into a wall.
  // Logging a value against a custom metric was admitted for a release and is
  // not any more: this paragraph named the gap, the release shipped over it,
  // and the write withdrew rather than the sentence staying true.
  // Every custom-metric write resolves the caller (`requireAuth`); no grant
  // reaches it at any level.
  const ownerRights = holdsOwnerRights(useRecordCapabilities());
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [addFooterEl, setAddFooterEl] = useState<HTMLDivElement | null>(null);
  const [addDirty, setAddDirty] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
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

  if (!ownerRights) return null;

  return (
    <section
      className="border-border space-y-3 border-t pt-6"
      data-slot="custom-metric-list"
    >
      <SectionHeading
        icon={Gauge}
        title={t("customMetrics.sectionTitle")}
        subtitle={t("customMetrics.sectionSubtitle")}
        // An empty list's own row adds the first metric; the heading's
        // button would say it twice.
        action={
          metrics.length > 0 ? (
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
          ) : undefined
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
          error={error}
          description={t("customMetrics.loadError")}
          onRetry={() => refetch()}
        />
      ) : (
        <ListGroup
          empty={{
            label: t("customMetrics.add"),
            onSelect: () => setAddOpen(true),
          }}
        >
          {metrics.map((metric) => (
            <ListItem
              key={metric.id}
              href={`/custom-metrics/${metric.id}`}
              title={metric.name}
              meta={
                metric.latest
                  ? fmt.date(metric.latest.measuredAt)
                  : t("customMetrics.noValuesYet")
              }
              trailing={
                metric.latest ? (
                  <span className="whitespace-nowrap">
                    {formatMetricValue(
                      metric.latest.value,
                      metric.decimals,
                      fmt.number,
                    )}
                    {metric.unit ? (
                      <span className="text-muted-foreground ml-1 text-xs font-normal">
                        {metric.unit}
                      </span>
                    ) : null}
                  </span>
                ) : undefined
              }
            />
          ))}
        </ListGroup>
      )}

      <ResponsiveSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        dirty={addDirty}
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
          onDirtyChange={setAddDirty}
        />
      </ResponsiveSheet>
    </section>
  );
}
