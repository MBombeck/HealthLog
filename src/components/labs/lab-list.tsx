"use client";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useId, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import {
  applyOrder,
  useModuleListPrefs,
  type ModuleListPrefs,
} from "@/lib/module-list-prefs";

import {
  groupMarkerRows,
  LabGroupHeader,
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
import type { LabOverviewResponse } from "./types";

/**
 * The person's Labs sort over the server's most-recent-first order:
 * `recentAsc` reverses, the alpha options sort by analyte name (#43), and
 * `manual` applies the persisted biomarker order (legacy un-linked rows, which
 * carry no biomarkerId, sort after the ordered block). Under categories the
 * same order holds inside each category.
 */
function sortRows(rows: MarkerRow[], prefs: ModuleListPrefs): MarkerRow[] {
  if (prefs.sortDir === "recentAsc") return [...rows].reverse();
  if (prefs.sortDir === "alphaAsc" || prefs.sortDir === "alphaDesc") {
    const dir = prefs.sortDir === "alphaAsc" ? 1 : -1;
    return [...rows].sort(
      (a, b) =>
        dir *
        a.analyte.localeCompare(b.analyte, undefined, { sensitivity: "base" }),
    );
  }
  if (prefs.sortDir === "manual") {
    return applyOrder(rows, prefs.order, (row) => row.biomarkerId ?? row.key);
  }
  return rows;
}

type GroupsOpen = ReturnType<typeof useGroupsOpen>;

/** The compact table: one bordered card of divided rows (#40). */
function LabTable({
  rows,
  groups,
  groupsOpen,
}: {
  rows: MarkerRow[];
  groups: MarkerGroup[] | null;
  groupsOpen: GroupsOpen;
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
                />
              ))
            : rows.map((row) => <LabListRow key={row.key} row={row} />)}
        </CardContent>
      </Card>
    </div>
  );
}

function useGroupToggle(group: MarkerGroup, groupsOpen: GroupsOpen) {
  const panelId = `${useId()}-panel`;
  return {
    open: groupsOpen.isOpen(group.category),
    onToggle: () => groupsOpen.toggle(group.category),
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
}: {
  group: MarkerGroup;
  groupsOpen: GroupsOpen;
}) {
  const { open, onToggle, panelId } = useGroupToggle(group, groupsOpen);
  return (
    <div className={cn(LIST_SUBGRID_CLASS, "divide-y-0")}>
      <LabGroupHeader
        category={group.category}
        open={open}
        onToggle={onToggle}
        panelId={panelId}
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
}: {
  group: MarkerGroup;
  groupsOpen: GroupsOpen;
}) {
  const { open, onToggle, panelId } = useGroupToggle(group, groupsOpen);
  return (
    <section className="space-y-4">
      <LabGroupHeader
        category={group.category}
        open={open}
        onToggle={onToggle}
        panelId={panelId}
      />
      <div id={panelId} hidden={!open}>
        {open ? <CardGrid rows={group.rows} underCategory /> : null}
      </div>
    </section>
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
  const { prefs } = useModuleListPrefs("labs");
  const groupsOpen = useGroupsOpen(prefs.groupsOpen);

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

  const rows = useMemo(
    () => sortRows(toMarkerRows(data?.markers ?? [], t), prefs),
    [data?.markers, prefs, t],
  );
  // Categories only when the person asked for them and the server says they
  // add something; otherwise the flat list it always was.
  const grouped = prefs.groupBy === "category" && data?.grouped === true;
  const categories = data?.categories;
  const groups = useMemo(
    () => (grouped && categories ? groupMarkerRows(rows, categories) : null),
    [grouped, categories, rows],
  );

  const listEmpty = !isLoading && !isError && rows.length === 0;
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
        error={error}
        title={t("labs.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }

  if (rows.length === 0) {
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

  // v1.18.6 — compact list view is the default (#40); the card/tile view is
  // the alternative the settings toggle selects.
  if (prefs.view === "list") {
    return <LabTable rows={rows} groups={groups} groupsOpen={groupsOpen} />;
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
