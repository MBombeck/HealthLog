"use client";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useMemo, useEffect } from "react";
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
import { formatReferenceRange } from "@/lib/labs/reference-range";
import { formatLabReading } from "@/lib/labs/format-value";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { applyOrder, useModuleListPrefs } from "@/lib/module-list-prefs";

import { LabTrendSparkline } from "./lab-trend-sparkline";
import { useLabDate, useLabNumber } from "./use-lab-format";
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

/**
 * The badge's grid cell. The badge renders nothing for a reading without a
 * reference range, and a missing cell would pull the range bar and the trend
 * one column to the left; the wrapper keeps every row at five cells.
 */
function RangeBadgeCell({ status }: { status: LabResultDto["rangeStatus"] }) {
  return (
    <div data-slot="lab-list-badge-cell" className={MOBILE_CELL.badge}>
      <ReferenceRangeBadge status={status} compact className="lg:w-full" />
    </div>
  );
}

function LabRangeBarSlot({ reading }: { reading: LabResultDto }) {
  return (
    <div className={cn("w-full", MOBILE_CELL.rangeBar)}>
      {/* A phone keeps the bar's own 12rem cap; from `lg` the bar fills its
          column, which is 12rem until the list is wide enough to grow it. */}
      <LabReferenceRangeBar
        className="lg:max-w-none"
        value={reading.value}
        referenceLow={reading.referenceLow}
        referenceHigh={reading.referenceHigh}
        unit={reading.unit}
      />
    </div>
  );
}

/**
 * The compact list is a five-column table from `lg` up: name and reading, range
 * badge, range bar, trend, chevron. Below that the same five cells fold into
 * two lines per row, because the fixed columns alone (badge + 12rem bar + 72px
 * trend + gaps) are wider than a phone, and the only flexible column — the
 * name — was the one that gave way: it collapsed to nothing and the row
 * panned sideways off the card.
 *
 * Phone layout, per row:
 *
 *     name / reading · date      badge   ›
 *     range bar                  trend
 *
 * The placement classes are all `max-lg:` so the desktop table keeps exactly
 * the subgrid it had.
 */
const ROW_CLASS =
  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-2 px-4 py-2.5 lg:col-span-full lg:grid-cols-subgrid lg:gap-y-0";

const MOBILE_CELL = {
  reading: "max-lg:col-start-1 max-lg:row-start-1",
  badge: "max-lg:col-start-2 max-lg:row-start-1 max-lg:justify-self-end",
  rangeBar: "max-lg:col-start-1 max-lg:row-start-2 max-lg:empty:hidden",
  trend:
    "max-lg:col-start-2 max-lg:row-start-2 max-lg:justify-self-end max-lg:empty:hidden",
  end: "max-lg:col-start-3 max-lg:row-start-1",
  notLinked: "max-lg:col-span-full max-lg:row-start-3",
} as const;

export function LabList({
  onAddFirst,
  onEmptyChange,
}: {
  onAddFirst?: () => void;
  /** Told whether the list is empty, so the page can drop its header add. */
  onEmptyChange?: (empty: boolean) => void;
} = {}) {
  const { t } = useTranslations();
  const labNumber = useLabNumber();
  const labDate = useLabDate();
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

  const listEmpty = !isLoading && !isError && groups.length === 0;
  useEffect(() => {
    onEmptyChange?.(listEmpty);
  }, [listEmpty, onEmptyChange]);

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
        {/* `@container` makes the columns follow the width the list has, not the
            window's: below `@5xl` (64rem of card) the row is the `lg` table it
            always was (the two tiers exclude each other, so the result does not
            depend on the order the CSS is emitted in), from there up the range
            bar takes part of the extra width instead of all of it going to the
            name. The trend column stays 72px in both tiers: the sparkline is a
            fixed 72px glyph, and a wider column would only open an empty strip
            between it and the chevron. */}
        <Card className="@container">
          <CardContent className="divide-border grid grid-cols-1 divide-y p-0 lg:gap-x-3 lg:@max-5xl:grid-cols-[minmax(0,1fr)_max-content_12rem_72px_auto] @5xl:grid-cols-[minmax(0,1fr)_max-content_minmax(12rem,18rem)_72px_auto]">
            {groups.map((group) => {
              const inner = (
                <div className={cn("min-w-0 flex-1", MOBILE_CELL.reading)}>
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    {/* One line with an ellipsis on a phone; from `lg` the name
                        wraps instead, so a long one (the schema allows 120
                        characters) always reads in full. */}
                    <span
                      data-slot="lab-list-analyte"
                      className="truncate font-medium lg:overflow-visible lg:[overflow-wrap:anywhere] lg:text-clip lg:whitespace-normal"
                    >
                      {group.analyte}
                    </span>
                  </div>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                    <span className="text-foreground font-semibold tabular-nums">
                      {formatLabReading(group.latest, labNumber)}
                    </span>
                    <span>{labDate(group.latest.takenAt)}</span>
                  </div>
                </div>
              );
              // The whole row navigates into the detail (where delete lives).
              return group.biomarkerId ? (
                <Link
                  key={group.key}
                  href={`/labs/${group.biomarkerId}`}
                  className={cn(
                    ROW_CLASS,
                    "hover:bg-muted/40 transition-colors",
                  )}
                >
                  {inner}
                  <RangeBadgeCell status={group.latest.rangeStatus} />
                  <LabRangeBarSlot reading={group.latest} />
                  <div className={cn("w-[72px]", MOBILE_CELL.trend)}>
                    <LabTrendSparkline
                      values={group.readings.map((reading) => reading.value)}
                      referenceLow={group.latest.referenceLow}
                      referenceHigh={group.latest.referenceHigh}
                    />
                  </div>
                  {/* With a pointer the row's hover already says it opens; a
                      phone has no hover, so the chevron stays there. */}
                  <ChevronRight
                    className={cn(
                      "text-muted-foreground h-4 w-4 shrink-0 lg:invisible",
                      MOBILE_CELL.end,
                    )}
                  />
                </Link>
              ) : (
                // Un-linked group (not backfilled to a catalog biomarker):
                // render inert but say so, so it doesn't read as a broken
                // link next to its clickable neighbours.
                <div key={group.key} className={ROW_CLASS}>
                  {inner}
                  <RangeBadgeCell status={group.latest.rangeStatus} />
                  <LabRangeBarSlot reading={group.latest} />
                  <div className={cn("w-[72px]", MOBILE_CELL.trend)}>
                    <LabTrendSparkline
                      values={group.readings.map((reading) => reading.value)}
                      referenceLow={group.latest.referenceLow}
                      referenceHigh={group.latest.referenceHigh}
                    />
                  </div>
                  <span
                    className={cn(
                      "text-muted-foreground shrink-0 text-xs italic",
                      MOBILE_CELL.notLinked,
                    )}
                  >
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
                      {formatLabReading(group.latest, labNumber)}
                    </span>
                    {group.latest.value !== null &&
                    (group.latest.referenceLow !== null ||
                      group.latest.referenceHigh !== null) ? (
                      <span className="text-xs">
                        {t("labs.referenceLabel")}{" "}
                        {formatReferenceRange(
                          group.latest.referenceLow,
                          group.latest.referenceHigh,
                          labNumber,
                        )}
                      </span>
                    ) : null}
                    <SourceRangeNote
                      reading={group.latest}
                      className="text-xs"
                    />
                    <span className="text-xs">
                      {labDate(group.latest.takenAt)}
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
