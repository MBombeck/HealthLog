"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { SelectionActionBar } from "@/components/data-list";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  INSIGHTS_OVERVIEW_PATH,
  subPageSlugForType,
} from "@/lib/insights/sub-page-metric";
import { accountLabel } from "@/lib/sharing/account-access-view";

import { MeasurementCardList } from "./list/measurement-card-list";
import { MeasurementEditSheet } from "./list/measurement-edit-sheet";
import { MeasurementFilterRail } from "./list/measurement-filter-rail";
import { MeasurementTable } from "./list/measurement-table";
import type { Measurement } from "./list/list-model";
import type { MeasurementRowContext } from "./list/row-actions";
import { useMeasurementEdit } from "./list/use-measurement-edit";
import { useMeasurementListData } from "./list/use-measurement-list-data";
import { useMeasurementListFilters } from "./list/use-measurement-list-filters";
import { useMeasurementRowDisplay } from "./list/use-measurement-row-display";

interface MeasurementListProps {
  onEdit?: (m: Measurement) => void;
  /**
   * Optional callback wired by the parent page so
   * the empty-state's "Add your first measurement" CTA opens the same
   * dialog the header button does. When undefined we hide the button
   * (fallback to the header CTA) instead of crashing.
   */
  onAddFirst?: () => void;
  /**
   * Told whether the unfiltered list is empty, so the page can drop its
   * header add button while the empty state carries the add action.
   */
  onEmptyChange?: (empty: boolean) => void;
  /**
   * Pin the list to a single `MeasurementType` and hide the
   * type selector. Used by the insights "all readings" subpage, which
   * already knows the metric from the route and wants a focused list
   * (pagination + inline edit/delete) rather than the global filter UI.
   * When set, the type `Select` is not rendered and every fetch is
   * scoped to this type; the count caption still shows.
   */
  lockedType?: string;
}

/**
 * Every reading, filterable, sortable and paged, with inline edit and
 * delete. The view state, the read, the edit and the row display live in
 * `./list/`; this component lays out the rail, the rows, the selection bar,
 * the pagination and the edit sheet.
 */
export function MeasurementList({
  onEdit,
  onAddFirst,
  onEmptyChange,
  lockedType,
}: MeasurementListProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { isAuthenticated, user } = useAuth();
  // Inside somebody else's record only the add path survives: entering a
  // reading is an admitted delegated write, editing and deleting one are not.
  // The row controls are dropped rather than disabled.
  const { canWriteDomain, canManage, inSharedRecord, canWrite } =
    useRecordCapabilities();
  const canAddMeasurement = canWriteDomain("measurements");
  const activeRecord = user?.accountAccess?.active ?? null;
  // Named only when the sentence below is owed: a delegate who may add but
  // not change. In the caller's own record, and for a read-only delegate who
  // was offered no add button to be surprised by, there is nothing to explain.
  const delegateName =
    inSharedRecord && canWrite && activeRecord
      ? accountLabel(activeRecord)
      : null;
  const display = useMeasurementRowDisplay();
  // Only the active layout mounts: a dense day-grouped page used to build
  // every row twice, once per layout, with only CSS hiding one. The hook
  // resolves to the desktop branch on the server and the first client paint
  // (matching the SSR HTML), then follows the viewport; the `md:*` classes
  // stay as a guard for that first frame.
  const isMobile = useIsMobile("md");
  const router = useRouter();
  // A row's type badge drills into that metric's Insights page when there is
  // one, else into the list filtered to the type.
  const navigateForType = (type: string) => {
    const slug = subPageSlugForType(type);
    router.push(
      slug
        ? `${INSIGHTS_OVERVIEW_PATH}/${slug}`
        : `/measurements?type=${encodeURIComponent(type)}`,
    );
  };
  const filters = useMeasurementListFilters(lockedType);
  const { typeFilter, page, clearSelection, goToPage, setTypeFilter } = filters;

  // The day rows whose drill-down is open; each opens a one-shot read of the
  // day's samples on first expand.
  const [expandedDayKeys, setExpandedDayKeys] = useState<Set<string>>(
    () => new Set(),
  );
  function toggleExpand(dayKey: string) {
    setExpandedDayKeys((prev) => {
      const next = new Set(prev);
      if (next.has(dayKey)) next.delete(dayKey);
      else next.add(dayKey);
      return next;
    });
  }

  const list = useMeasurementListData({
    filters,
    enabled: isAuthenticated,
    lockedType,
    onEmptyChange,
  });
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    selectedOnPage,
    onConfirmBulkDelete,
    bulkDeleteMutation,
    totalPages,
  } = list;
  const edit = useMeasurementEdit({
    onEdit,
    display,
    deleteMutation: list.deleteMutation,
  });

  if (!isAuthenticated) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("measurements.loginRequired")}
      </p>
    );
  }

  const rows: MeasurementRowContext = {
    canManage,
    selectedIds: filters.selectedIds,
    expandedDayKeys,
    toggleExpand,
    navigateForType,
    startEdit: edit.startEdit,
    onToggleRow: list.onToggleRow,
    onDelete: (id) => list.deleteMutation.mutate(id),
    display,
  };

  return (
    <>
      <div className="space-y-4">
        {/* The filter rail; on the locked-type page (the metric is fixed by
            the route) only the count line remains. */}
        {lockedType ? (
          data?.meta?.total !== undefined && (
            <div className="flex items-center justify-end">
              <span className="text-muted-foreground text-sm tabular-nums">
                {t("measurements.measurementCount", {
                  count: fmt.integer(data.meta.total),
                })}
              </span>
            </div>
          )
        ) : (
          <MeasurementFilterRail filters={filters} total={data?.meta?.total} />
        )}

        {isLoading ? (
          <div className="space-y-2" data-slot="measurement-list-loading">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          // A read failure is NOT an empty list — surface the error + Retry so
          // an outage never reads as "you have no measurements".
          <QueryErrorCard error={error} onRetry={() => void refetch()} />
        ) : !data?.measurements?.length ? (
          <MeasurementListEmpty
            filtered={typeFilter !== "ALL" && !lockedType}
            onResetFilter={() => setTypeFilter("ALL")}
            onAddFirst={canAddMeasurement ? onAddFirst : undefined}
            delegateName={delegateName}
          />
        ) : (
          <>
            {/* Desktop table or phone list, whichever layout is active. */}
            {!isMobile && (
              <MeasurementTable
                measurements={data.measurements}
                rows={rows}
                filters={filters}
                list={list}
              />
            )}
            {isMobile && (
              <MeasurementCardList
                measurements={data.measurements}
                rows={rows}
              />
            )}
          </>
        )}

        {/* Page-scoped multi-select action bar. */}
        <SelectionActionBar
          domain="measurements"
          count={selectedOnPage}
          onClear={clearSelection}
          onConfirmDelete={onConfirmBulkDelete}
          isDeleting={bulkDeleteMutation.isPending}
          confirmTitle={
            selectedOnPage === 1
              ? t("measurements.bulkDeleteConfirmTitleOne")
              : t("measurements.bulkDeleteConfirmTitle", {
                  count: String(selectedOnPage),
                })
          }
          confirmBody={
            selectedOnPage === 1
              ? t("measurements.bulkDeleteConfirmBodyOne")
              : t("measurements.bulkDeleteConfirmBody", {
                  count: String(selectedOnPage),
                })
          }
        />

        {totalPages > 1 && (
          <MeasurementListPagination
            page={page}
            totalPages={totalPages}
            goToPage={goToPage}
          />
        )}
      </div>

      <MeasurementEditSheet edit={edit} display={display} />
    </>
  );
}

/**
 * Nothing to list. The copy tells a new account ("no measurements yet") from
 * a filtered-out list, with the action each one needs; a locked-type list has
 * no filter to reset, since the route fixes the metric.
 */
function MeasurementListEmpty({
  filtered,
  onResetFilter,
  onAddFirst,
  delegateName,
}: {
  filtered: boolean;
  onResetFilter: () => void;
  onAddFirst?: () => void;
  delegateName: string | null;
}) {
  const { t } = useTranslations();
  return (
    <>
      <EmptyState
        icon={<Activity className="size-6" />}
        title={
          filtered
            ? t("measurements.emptyFilteredTitle")
            : t("measurements.emptyTitle")
        }
        description={
          filtered
            ? t("measurements.emptyFilteredDescription")
            : t("measurements.emptyDescription")
        }
        action={
          filtered ? (
            <Button variant="outline" onClick={onResetFilter}>
              {t("measurements.emptyResetFilter")}
            </Button>
          ) : onAddFirst ? (
            <Button onClick={onAddFirst} data-slot="measurement-add-first">
              <Plus className="h-4 w-4" />
              {t("measurements.emptyAddFirst")}
            </Button>
          ) : undefined
        }
      />
      {/* The one place in the app the asymmetry is spelled out. A delegate
          who may add will look for the edit control beside the row they just
          entered, so the list that carries the add button says once, in one
          muted line, where the limit is. Every other hidden control stays
          silent: the banner already names the mode. */}
      {delegateName && (
        <p
          data-slot="delegate-add-only-note"
          className="text-muted-foreground mx-auto max-w-prose text-center text-xs"
        >
          {t("recordSharing.delegate.addOnlyNote", {
            name: delegateName,
          })}
        </p>
      )}
    </>
  );
}

function MeasurementListPagination({
  page,
  totalPages,
  goToPage,
}: {
  page: number;
  totalPages: number;
  goToPage: (updater: (p: number) => number) => void;
}) {
  const { t } = useTranslations();
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-sm">
        {t("measurements.pageInfo", {
          page: String(page),
          total: String(totalPages),
        })}
      </span>
      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="icon-lg"
          disabled={page <= 1}
          onClick={() => goToPage((p) => p - 1)}
          aria-label={t("measurements.previousPage")}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-lg"
          disabled={page >= totalPages}
          onClick={() => goToPage((p) => p + 1)}
          aria-label={t("measurements.nextPage")}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
