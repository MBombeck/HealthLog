"use client";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FlaskConical } from "lucide-react";

import { MedicationCardHeader } from "@/components/medications/medication-card-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { formatDate } from "@/lib/format";
import { formatReferenceRange } from "@/lib/labs/reference-range";
import { formatLabReading, formatLabValue } from "@/lib/labs/format-value";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { applyOrder, useModuleListPrefs } from "@/lib/module-list-prefs";

import { LabTrendSparkline } from "./lab-trend-sparkline";
import { LabReferenceRangeBar } from "./lab-reference-range-bar";
import { ReferenceRangeBadge } from "./reference-range-badge";
import { SourceRangeNote } from "./source-range-note";
import type { LabResultDto, LabResultListResponse } from "./types";

interface MarkerGroup {
  /** Stable group key: the biomarker id, or `analyte:<lower>` for legacy rows. */
  key: string;
  /** Link target when the group is catalog-linked; null for legacy rows. */
  biomarkerId: string | null;
  analyte: string;
  panel: string | null;
  unit: string;
  readings: LabResultDto[];
  latest: LabResultDto;
}

/**
 * Group readings by their linked biomarker (or, for legacy un-linked rows,
 * case-insensitively by analyte). A catalog-linked group deep-links to its
 * detail chart; legacy groups render inert until the backfill links them.
 */
function groupReadings(results: LabResultDto[]): MarkerGroup[] {
  const byKey = new Map<string, LabResultDto[]>();
  for (const r of results) {
    const key = r.biomarkerId
      ? `bm:${r.biomarkerId}`
      : `analyte:${r.analyte.toLowerCase()}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }

  const groups: MarkerGroup[] = [];
  for (const [key, readings] of byKey.entries()) {
    const ordered = [...readings].sort(
      (a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime(),
    );
    const latest = ordered[ordered.length - 1];
    groups.push({
      key,
      biomarkerId: latest.biomarkerId,
      analyte: latest.analyte,
      panel: latest.panel,
      unit: latest.unit,
      readings: ordered,
      latest,
    });
  }
  return groups.sort(
    (a, b) =>
      new Date(b.latest.takenAt).getTime() -
      new Date(a.latest.takenAt).getTime(),
  );
}

function LabRangeBarSlot({ reading }: { reading: LabResultDto }) {
  return (
    <div className="w-48">
      <LabReferenceRangeBar
        value={reading.value}
        referenceLow={reading.referenceLow}
        referenceHigh={reading.referenceHigh}
        unit={reading.unit}
      />
    </div>
  );
}

export function LabList({ onAddFirst }: { onAddFirst?: () => void } = {}) {
  const { t } = useTranslations();
  const { canWriteDomain } = useRecordCapabilities();
  const canAddLab = canWriteDomain("labs");
  const { prefs } = useModuleListPrefs("labs");

  // v1.22 — a short, factual line under each marker heading describing what the
  // biomarker measures, sourced from the catalog via i18n. Free-text markers
  // (no catalog match) carry no subtitle rather than a fabricated one.
  // v1.24 — the per-marker description moved to the biomarker detail page
  // (beneath the heading); the overview rows no longer carry it.
  const listKey = queryKeys.labResultsList({
    biomarkerId: undefined,
    analyte: undefined,
    panel: undefined,
    from: undefined,
    to: undefined,
    page: 0,
    sortDir: "desc",
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      apiGet<LabResultListResponse>("/api/labs?limit=500&sortDir=desc"),
  });

  const groups = useMemo(() => {
    const base = groupReadings(data?.results ?? []);
    // v1.18.6 (MOD-04) — honour the user's Labs sort choice. `groupReadings`
    // already returns most-recent-first; `recentAsc` reverses, the alpha
    // options sort by analyte name (#43), and `manual` applies the persisted
    // biomarker order (legacy un-linked groups, which carry no biomarkerId,
    // sort after the ordered block).
    if (prefs.sortDir === "recentAsc") return [...base].reverse();
    if (prefs.sortDir === "alphaAsc" || prefs.sortDir === "alphaDesc") {
      const dir = prefs.sortDir === "alphaAsc" ? 1 : -1;
      return [...base].sort(
        (a, b) =>
          dir *
          a.analyte.localeCompare(b.analyte, undefined, {
            sensitivity: "base",
          }),
      );
    }
    if (prefs.sortDir === "manual") {
      return applyOrder(base, prefs.order, (g) => g.biomarkerId ?? g.key);
    }
    return base;
  }, [data?.results, prefs.sortDir, prefs.order]);

  // The list caps at 500 rows server-side (the `limit` ceiling). Surface a
  // calm "showing latest N of M" hint when the cap truncates so the count is
  // never silently wrong — proper cursor paging is a later iteration.
  const total = data?.meta?.total ?? 0;
  const shown = data?.results?.length ?? 0;
  const truncated = total > shown;

  if (isLoading) {
    return (
      <div className="space-y-3" data-slot="lab-list-loading">
        {Array.from({ length: 3 }, (_, i) => (
          <Card key={i} aria-hidden="true">
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-8 w-24 self-end sm:self-center" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (isError) {
    // A read failure is NOT an empty list — surface the error + Retry so an
    // outage never reads as "you have no lab results".
    return (
      <QueryErrorCard
        title={t("labs.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<FlaskConical className="size-6" />}
        title={t("labs.emptyTitle")}
        description={t("labs.emptyDescription")}
        action={
          onAddFirst && canAddLab ? (
            <Button onClick={onAddFirst}>{t("labs.addFirst")}</Button>
          ) : undefined
        }
      />
    );
  }

  // v1.18.10 (#3) — delete lives ONLY on the value detail view (next to Edit),
  // not on these overview rows. The list/tile rows navigate; the trash icon was
  // removed here so a stray tap can't delete a biomarker from the overview.

  // v1.18.6 (MOD-03) — compact list view: one bordered card holding tight
  // divided rows instead of a card per biomarker. This is the default view
  // (#40); the card/tile view is the alternative the settings toggle selects.
  if (prefs.view === "list") {
    return (
      // `lab-list` marks the read results in both view shapes. The loading
      // branch above carries `lab-list-loading` instead, so the marker
      // cannot stand for a silhouette.
      <div data-slot="lab-list" className="space-y-3">
        {truncated ? (
          <p className="text-muted-foreground text-xs">
            {t("labs.showingLatestOf", { shown, total })}
          </p>
        ) : null}
        <Card>
          <CardContent className="divide-border grid grid-cols-[minmax(0,1fr)_max-content_12rem_72px_auto] gap-x-3 divide-y p-0">
            {groups.map((group) => {
              const inner = (
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="truncate font-medium">
                      {group.analyte}
                    </span>
                  </div>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                    <span className="text-foreground font-semibold tabular-nums">
                      {formatLabReading(group.latest)}
                    </span>
                    <span>{formatDate(group.latest.takenAt)}</span>
                  </div>
                </div>
              );
              // The whole row navigates into the detail (where delete lives).
              return group.biomarkerId ? (
                <Link
                  key={group.key}
                  href={`/labs/${group.biomarkerId}`}
                  className="hover:bg-muted/40 col-span-full grid min-w-0 grid-cols-subgrid items-center px-4 py-2.5 transition-colors"
                >
                  {inner}
                  <ReferenceRangeBadge
                    status={group.latest.rangeStatus}
                    compact
                    className="w-full"
                  />
                  <LabRangeBarSlot reading={group.latest} />
                  <div className="w-[72px]">
                    <LabTrendSparkline
                      values={group.readings.map((reading) => reading.value)}
                      referenceLow={group.latest.referenceLow}
                      referenceHigh={group.latest.referenceHigh}
                    />
                  </div>
                  <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
                </Link>
              ) : (
                // Un-linked group (not backfilled to a catalog biomarker):
                // render inert but say so, so it doesn't read as a broken
                // link next to its clickable neighbours.
                <div
                  key={group.key}
                  className="col-span-full grid min-w-0 grid-cols-subgrid items-center px-4 py-2.5"
                >
                  {inner}
                  <ReferenceRangeBadge
                    status={group.latest.rangeStatus}
                    compact
                    className="w-full"
                  />
                  <LabRangeBarSlot reading={group.latest} />
                  <div className="w-[72px]">
                    <LabTrendSparkline
                      values={group.readings.map((reading) => reading.value)}
                      referenceLow={group.latest.referenceLow}
                      referenceHigh={group.latest.referenceHigh}
                    />
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs italic">
                    {t("labs.notLinkedYet")}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    );
  }

  // v1.18.9 (#40) — card/tile view. The tile reuses the medication module's
  // `MedicationCardHeader` so a lab tile reads identically to a medication or
  // Vorsorge tile side-by-side: name on line 1, the reference-range badge as
  // the line-1 chip, the panel as the category badge. v1.18.10 (#3) — no delete
  // control on the tile; the trash icon lives only on the value detail view.
  return (
    <ul
      data-slot="lab-list"
      className={cn(
        "grid list-none gap-4 p-0",
        // A lone lab spans the full row rather than orphaning half of it;
        // two or more fall into the two-up grid.
        groups.length > 1 && "sm:grid-cols-2",
      )}
    >
      {truncated ? (
        <li className="sm:col-span-2">
          <p className="text-muted-foreground text-xs">
            {t("labs.showingLatestOf", { shown, total })}
          </p>
        </li>
      ) : null}
      {groups.map((group) => {
        return (
          <li key={group.key} className="contents">
            <Card className="h-full gap-3">
              <MedicationCardHeader
                name={group.analyte}
                dose=""
                categoryLabel={group.panel ?? group.unit}
                nameChip={
                  <ReferenceRangeBadge
                    status={group.latest.rangeStatus}
                    compact
                  />
                }
                href={
                  group.biomarkerId ? `/labs/${group.biomarkerId}` : undefined
                }
                linkLabel={group.analyte}
              />
              <CardContent>
                <div className="flex items-end justify-between gap-3">
                  <div className="text-muted-foreground flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-sm">
                    <span className="text-foreground font-semibold tabular-nums">
                      {formatLabReading(group.latest)}
                    </span>
                    {group.latest.value !== null &&
                    (group.latest.referenceLow !== null ||
                      group.latest.referenceHigh !== null) ? (
                      <span className="text-xs">
                        {t("labs.referenceLabel")}{" "}
                        {formatReferenceRange(
                          group.latest.referenceLow,
                          group.latest.referenceHigh,
                          formatLabValue,
                        )}
                      </span>
                    ) : null}
                    <SourceRangeNote
                      reading={group.latest}
                      className="text-xs"
                    />
                    <span className="text-xs">
                      {formatDate(group.latest.takenAt)}
                    </span>
                    {group.readings.length > 1 ? (
                      <span className="text-xs">
                        {t("labs.readingsCount", {
                          count: group.readings.length,
                        })}
                      </span>
                    ) : null}
                    <LabReferenceRangeBar
                      value={group.latest.value}
                      referenceLow={group.latest.referenceLow}
                      referenceHigh={group.latest.referenceHigh}
                      unit={group.latest.unit}
                    />
                  </div>
                  <LabTrendSparkline
                    values={group.readings.map((reading) => reading.value)}
                    referenceLow={group.latest.referenceLow}
                    referenceHigh={group.latest.referenceHigh}
                  />
                </div>
                {/* Un-linked group: the header renders no link, so name the
                    reason rather than leaving a card that silently does
                    nothing on tap. */}
                {!group.biomarkerId ? (
                  <p className="text-muted-foreground text-xs italic">
                    {t("labs.notLinkedYet")}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
