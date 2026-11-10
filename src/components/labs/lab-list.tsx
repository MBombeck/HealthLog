"use client";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useCallback, useId, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { useDisplayTimezone, useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import {
  useModuleListPrefs,
  type ModuleListView,
  type ModuleSortDir,
} from "@/lib/module-list-prefs";

import { LabFilterRail } from "./lab-filter-rail";
import {
  buildMarkerCategoryMap,
  filterMarkerRows,
  labReadingDayKey,
  sortMarkerRows,
} from "./lab-list-filters";
import { useLabListFilters } from "./use-lab-list-filters";
import {
  groupMarkerRows,
  LabGroupHeader,
  summariseGroupRows,
  useGroupsOpen,
  type MarkerGroup,
} from "./lab-list-groups";
import {
  LabCard,
  LabListRow,
  LIST_GRID_CLASS,
  LIST_SUBGRID_CLASS,
  toMarkerRows,
  type MarkerRow,
} from "./lab-list-rows";
import type {
  LabOverviewCategoryDto,
  LabOverviewResponse,
} from "./types";

type GroupsOpen = ReturnType<typeof useGroupsOpen>;

/** The compact table: one bordered card of divided rows (#40). */
function LabTable({
  rows,
  groups,
  groupsOpen,
  isFiltered,
}: {
  rows: MarkerRow[];
  groups: MarkerGroup[] | null;
  groupsOpen: GroupsOpen;
  isFiltered: boolean;
}) {
  return (
    // `lab-list` marks the read results in both view shapes. The loading
    // branch carries `lab-list-loading` instead, so the marker cannot stand
    // for a silhouette.
    <div data-slot="lab-list" className="space-y-3">
      <Card className="@container">
        <CardContent className={LIST_GRID_CLASS}>
          {groups
            ? groups.map((group) => (
                <TableGroup
                  key={group.category.key}
                  group={group}
                  groupsOpen={groupsOpen}
                  isFiltered={isFiltered}
                />
              ))
            : rows.map((row) => <LabListRow key={row.key} row={row} />)}
        </CardContent>
      </Card>
    </div>
  );
}

function useGroupToggle(
  category: LabOverviewCategoryDto,
  groupsOpen: GroupsOpen,
  status: LabOverviewCategoryDto["status"],
) {
  const panelId = `${useId()}-panel`;
  return {
    open: groupsOpen.isOpen(category, status),
    onToggle: () => groupsOpen.toggle(category, status),
    panelId,
  };
}

/**
 * One category inside the table. The header spans every column and the rows
 * below keep the table's subgrid, so the columns line up across categories.
 */
function TableGroup({
  group,
  groupsOpen,
  isFiltered,
}: {
  group: MarkerGroup;
  groupsOpen: GroupsOpen;
  isFiltered: boolean;
}) {
  const summary = useMemo(
    () => (isFiltered ? summariseGroupRows(group.rows) : undefined),
    [isFiltered, group.rows],
  );
  const status = summary?.status ?? group.category.status;
  const { open, onToggle, panelId } = useGroupToggle(
    group.category,
    groupsOpen,
    status,
  );
  return (
    <div className={cn(LIST_SUBGRID_CLASS, "divide-y-0")}>
      <LabGroupHeader
        category={group.category}
        rows={group.rows}
        open={open}
        onToggle={onToggle}
        panelId={panelId}
        isFiltered={isFiltered}
        status={status}
        summary={summary}
        className="px-4 py-1 lg:col-span-full"
      />
      <div
        id={panelId}
        hidden={!open}
        className={cn(LIST_SUBGRID_CLASS, "border-border border-t")}
      >
        {open
          ? group.rows.map((row) => <LabListRow key={row.key} row={row} />)
          : null}
      </div>
    </div>
  );
}

function CardGrid({
  rows,
  underCategory,
}: {
  rows: MarkerRow[];
  underCategory: boolean;
}) {
  return (
    <ul
      className={cn(
        "grid list-none gap-4 p-0",
        // A lone lab spans the full row rather than orphaning half of it;
        // two or more fall into the two-up grid.
        rows.length > 1 && "sm:grid-cols-2",
      )}
    >
      {rows.map((row) => (
        <LabCard key={row.key} row={row} underCategory={underCategory} />
      ))}
    </ul>
  );
}

function CardGroup({
  group,
  groupsOpen,
  isFiltered,
}: {
  group: MarkerGroup;
  groupsOpen: GroupsOpen;
  isFiltered: boolean;
}) {
  const summary = useMemo(
    () => (isFiltered ? summariseGroupRows(group.rows) : undefined),
    [isFiltered, group.rows],
  );
  const status = summary?.status ?? group.category.status;
  const { open, onToggle, panelId } = useGroupToggle(
    group.category,
    groupsOpen,
    status,
  );
  return (
    <section className="space-y-4">
      <LabGroupHeader
        category={group.category}
        rows={group.rows}
        open={open}
        onToggle={onToggle}
        panelId={panelId}
        isFiltered={isFiltered}
        status={status}
        summary={summary}
      />
      <div id={panelId} hidden={!open}>
        {open ? <CardGrid rows={group.rows} underCategory /> : null}
      </div>
    </section>
  );
}

function LabListLoading() {
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

function LabListEmpty({
  canAddLab,
  onAddFirst,
}: {
  canAddLab: boolean;
  onAddFirst?: () => void;
}) {
  const { t } = useTranslations();
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

function LabListNoMatches({ onReset }: { onReset: () => void }) {
  const { t } = useTranslations();
  return (
    <EmptyState
      icon={<FlaskConical className="size-6" />}
      title={t("labs.filter.noMatchesTitle")}
      description={t("labs.filter.noMatchesDescription")}
      action={
        <Button variant="outline" onClick={onReset}>
          {t("dataList.resetFilters")}
        </Button>
      }
    />
  );
}

function LabListContent({
  view,
  rows,
  groups,
  groupsOpen,
  isFiltered,
}: {
  view: ModuleListView;
  rows: MarkerRow[];
  groups: MarkerGroup[] | null;
  groupsOpen: GroupsOpen;
  isFiltered: boolean;
}) {
  // v1.18.10 (#3) — delete lives ONLY on the value detail view (next to Edit),
  // not on these overview rows. The list/tile rows navigate; the trash icon was
  // removed here so a stray tap can't delete a biomarker from the overview.

  // v1.18.6 — compact list view is the default (#40); the card/tile view is
  // the alternative the settings toggle selects.
  if (view === "list") {
    return (
      <LabTable
        rows={rows}
        groups={groups}
        groupsOpen={groupsOpen}
        isFiltered={isFiltered}
      />
    );
  }

  // v1.18.9 (#40) — card/tile view.
  if (groups) {
    return (
      <div data-slot="lab-list" className="space-y-10">
        {groups.map((group) => (
          <CardGroup
            key={group.category.key}
            group={group}
            groupsOpen={groupsOpen}
            isFiltered={isFiltered}
          />
        ))}
      </div>
    );
  }

  return (
    <div data-slot="lab-list">
      <CardGrid rows={rows} underCategory={false} />
    </div>
  );
}

export function LabList({
  onAddFirst,
  onEmptyChange,
}: {
  onAddFirst?: () => void;
  /** Told whether the list is empty, so the page can drop its header add. */
  onEmptyChange?: (empty: boolean) => void;
} = {}) {
  const { t, locale } = useTranslations();
  const { canWriteDomain } = useRecordCapabilities();
  const canAddLab = canWriteDomain("labs");
  const { prefs, isLoaded } = useModuleListPrefs("labs");
  const displayTz = useDisplayTimezone();

  // v1.22 — a short, factual line under each marker heading describing what the
  // biomarker measures, sourced from the catalog via i18n. Free-text markers
  // (no catalog match) carry no subtitle rather than a fabricated one.
  // v1.24 — the per-marker description moved to the biomarker detail page
  // (beneath the heading); the overview rows no longer carry it.
  // One entry per biomarker over the whole history, grouped server-side: a
  // capped page of raw rows dropped every marker measured only long ago.
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.labResultsOverview(locale),
    queryFn: () => apiGet<LabOverviewResponse>("/api/labs/overview"),
  });

  const hasManualOrder = prefs.order.length > 0;
  const effectiveDefaultSort: ModuleSortDir =
    prefs.sortDir === "manual" && !hasManualOrder
      ? "recentDesc"
      : prefs.sortDir;

  const {
    filters,
    searchDraft,
    setSearchDraft,
    searchInputRef,
    setStatusFilter,
    setCategoryFilter,
    setFromDay,
    setToDay,
    setSortFilter,
    resetFilters,
  } = useLabListFilters({
    defaultSort: effectiveDefaultSort,
  });

  const rawSort = filters.sort ?? effectiveDefaultSort;
  const effectiveSortDir =
    rawSort === "manual" && !hasManualOrder ? "recentDesc" : rawSort;

  const rawRows = useMemo(
    () => toMarkerRows(data?.markers ?? [], t),
    [data?.markers, t],
  );

  const categories = data?.categories;
  const categoryValid =
    !filters.category ||
    filters.category === "ALL" ||
    !categories ||
    categories.some((c) => c.key === filters.category);

  const effectiveFilters = useMemo(
    () => (categoryValid ? filters : { ...filters, category: undefined }),
    [categoryValid, filters],
  );

  const effectiveIsFiltered = Boolean(
    (effectiveFilters.q && effectiveFilters.q.trim() !== "") ||
    (effectiveFilters.status && effectiveFilters.status !== "ALL") ||
    (effectiveFilters.category && effectiveFilters.category !== "ALL") ||
    effectiveFilters.fromDay ||
    effectiveFilters.toDay,
  );

  const groupsOpen = useGroupsOpen(prefs.groupsOpen);

  // Scrub unsupported manual sort if preferences confirm no manual order exists.
  // afterPaint protects mount writes from router history initialization.
  useEffect(() => {
    if (isLoaded && filters.sort === "manual" && !hasManualOrder) {
      setSortFilter(effectiveDefaultSort, { mode: "replace", afterPaint: true });
    }
  }, [isLoaded, filters.sort, hasManualOrder, effectiveDefaultSort, setSortFilter]);

  // Scrub stale category filter when categories load.
  // afterPaint protects mount writes from router history initialization.
  useEffect(() => {
    if (
      categories &&
      filters.category &&
      !categories.some((c) => c.key === filters.category)
    ) {
      setCategoryFilter("ALL", { mode: "replace", afterPaint: true });
    }
  }, [categories, filters.category, setCategoryFilter]);

  const categoryMap = useMemo(
    () => buildMarkerCategoryMap(categories),
    [categories],
  );

  const categoryOf = useCallback(
    (key: string) => categoryMap.get(key),
    [categoryMap],
  );

  const dayKeyOf = useCallback(
    (takenAt: string) => labReadingDayKey(takenAt, displayTz),
    [displayTz],
  );

  const filteredRows = useMemo(
    () => filterMarkerRows(rawRows, effectiveFilters, categoryOf, dayKeyOf),
    [rawRows, effectiveFilters, categoryOf, dayKeyOf],
  );

  const rows = useMemo(
    () => sortMarkerRows(filteredRows, effectiveSortDir, prefs.order),
    [filteredRows, effectiveSortDir, prefs.order],
  );

  // Categories only when the person asked for them and the server says they
  // add something; otherwise the flat list it always was.
  const grouped = prefs.groupBy === "category" && data?.grouped === true;
  const groups = useMemo(
    () => (grouped && categories ? groupMarkerRows(rows, categories) : null),
    [grouped, categories, rows],
  );

  const rawEmpty = !isLoading && !isError && rawRows.length === 0;
  useEffect(() => {
    onEmptyChange?.(rawEmpty);
  }, [rawEmpty, onEmptyChange]);

  if (isLoading) {
    return <LabListLoading />;
  }

  if (isError) {
    // A read failure is NOT an empty list — surface the error + Retry so an
    // outage never reads as "you have no lab results".
    return (
      <QueryErrorCard
        error={error}
        title={t("labs.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }

  if (rawRows.length === 0) {
    return <LabListEmpty canAddLab={canAddLab} onAddFirst={onAddFirst} />;
  }

  const filterRail = (
    <LabFilterRail
      filters={effectiveFilters}
      searchDraft={searchDraft}
      onSearchChange={setSearchDraft}
      searchInputRef={searchInputRef}
      onStatusChange={setStatusFilter}
      onCategoryChange={setCategoryFilter}
      onFromDayChange={setFromDay}
      onToDayChange={setToDay}
      onSortChange={setSortFilter}
      onResetFilters={resetFilters}
      isFiltered={effectiveIsFiltered}
      categories={categories}
      total={rows.length}
      currentSortDir={effectiveSortDir}
      hasManualOrder={hasManualOrder}
    />
  );

  if (rows.length === 0) {
    return (
      <div className="space-y-6">
        {filterRail}
        <LabListNoMatches onReset={resetFilters} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {filterRail}
      <LabListContent
        view={prefs.view}
        rows={rows}
        groups={groups}
        groupsOpen={groupsOpen}
        isFiltered={effectiveIsFiltered}
      />
    </div>
  );
}
