"use client";

import type { MedicationCourseFields } from "@/components/medications/course-fields";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useEffect, useReducer, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsUpDown,
  Loader2,
  SkipForward,
} from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MedicationStatusPill } from "@/components/medications/card-parts/medication-status-pill";
import {
  DoseStateLabel,
  OverdueSlotValue,
} from "@/components/medications/dose-state-label";
import { useWeekdayLabel } from "@/components/medications/card-parts/medication-next-last-slot";
import { estimateRunwayDays } from "@/lib/medications/supply-runway";
import { useMedicationIntake } from "@/components/medications/use-medication-intake";
import {
  cardTakeSlot,
  cardWindowPill,
  liveDoseState,
} from "@/lib/medications/dose-state/pill";
import { shownAdherence } from "@/lib/medications/shown-adherence";
import { TableComplianceRow } from "@/components/medications/table-compliance-row";
import { resolveNextDueDayLabel } from "@/lib/medications/next-due-day-label";
import { formatTime } from "@/lib/format";
import { formatTimeWindowRange } from "@/lib/time-window-format";
import { formatDate } from "@/lib/date-format";
import {
  useDateFormatPreference,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";
import { formatDose } from "@/lib/medications/format-dose";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import {
  useMedicationComplianceSummary,
  useMedicationComplianceSummaryAll,
} from "@/lib/queries/use-medication-compliance-summary";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  buildDoseStateById,
  groupMedications,
  useMedicationGroupsOpen,
} from "@/components/medications/medication-list-groups";
import type {
  MedicationGroupBy,
  MedicationGroupsOpen,
} from "@/lib/medication-list-layout";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/**
 * v1.16.10 — the compact table view for /medications (issue #316 item 3).
 *
 * One row per medication, the same data sources as the cards by
 * construction: the rows render straight off the `GET /api/medications`
 * list payload (next-due, stock), the Therapietreue column reads the
 * SAME batched compliance summary the cards share
 * (`useMedicationComplianceSummary`), the status cell mirrors the card
 * body's precedence over the SAME `reduceCurrentWindowStatus` /
 * server-`nextDueAt` gate, and the action buttons fire the SAME
 * `useMedicationIntake` mutation hook with the same displayed-slot
 * instant. Nothing here recomputes dueness beyond what the cards do.
 *
 * Responsive: horizontal scroll (the shared `<Table>` wrapper) with a
 * sticky first column so the medication name stays anchored while the
 * row scrolls. Action buttons keep the 44-px tap-target floor.
 */

interface TableSchedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
  timesOfDay?: string[];
  doseWindows?: { timeOfDay: string; start: string; end: string }[] | null;
  /** Cadence fields the supply-runway estimate reads (v1.16.11). */
  rrule?: string | null;
  rollingIntervalDays?: number | null;
}

export interface TableMedication {
  id: string;
  name: string;
  dose: string;
  category?: string;
  categoryLabel?: string | null;
  treatmentClass?: string;
  active: boolean;
  pausedAt: string | null;
  lastTakenAt: string | null;
  todayEventCount?: number;
  nextDueAt?: string | null;
  nextDueOverdue?: boolean;
  /**
   * v1.16.11 (#316) — as-needed (PRN): the next-dose cell shows a calm
   * "Bei Bedarf" marker, the compliance column shows "–".
   */
  asNeeded?: boolean;
  /**
   * v1.39.1 (#1033) — false keeps the medication as a record: the next-dose
   * cell names that, the compliance and action cells show "–".
   */
  trackIntake?: boolean;
  /**
   * v1.39.4 (#1040) — server-resolved: the action cell offers taken / skip
   * only when true; an ended course shows "Ended" where next-due sits.
   */
  intakeActionable?: boolean;
  courseStatus?: "UPCOMING" | "CURRENT" | "ENDED";
  /** v1.40 (#1024) — the server-resolved course fields. */
  courses?: MedicationCourseFields["courses"];
  courseCount?: number;
  previousCourseEndedOn?: string | null;
  canStartCourse?: boolean;
  /** v1.16.10 — dose-derived stock from the list payload; null = inventory tracking off. */
  stockDosesRemaining?: number | null;
  /** v1.37.19 — server-resolved slot-aware runway (days); null = off/no cadence. */
  runwayDays?: number | null;
  schedules: TableSchedule[];
}

export {
  nextSortState,
  sortMedicationRows,
  type MedicationTableSort,
  type MedicationTableSortColumn,
} from "./medication-table-sort";
import {
  nextSortState,
  sortMedicationRows,
  type MedicationTableSort,
  type MedicationTableSortColumn,
} from "./medication-table-sort";
import { MedicationTableGroupedRows } from "./medication-table-grouped-rows";

interface MedicationTableProps {
  /** Active medications, already in the page's manual order. */
  activeMedications: TableMedication[];
  /** Inactive medications, already in the page's manual order; pinned after the active block. */
  inactiveMedications: TableMedication[];
  /** SSR-pinnable initial sort (tests); the header buttons own it after mount. */
  initialSort?: MedicationTableSort | null;
  /**
   * v1.29.x — the Today digest's "Log dose" deep-link target
   * (`/medications?highlight=<id>`). The matching row rings briefly,
   * mirroring the card grid's `<MedicationCard highlighted>`.
   */
  highlightId?: string | null;
  groupBy?: MedicationGroupBy;
  groupsOpen?: MedicationGroupsOpen;
  categoryOrder?: readonly string[];
  isFiltered?: boolean;
  customCategories?: readonly { key: string; label: string }[];
}

export function MedicationTable({
  activeMedications,
  inactiveMedications,
  initialSort = null,
  highlightId = null,
  groupBy = "none",
  groupsOpen = "expanded",
  categoryOrder = [],
  isFiltered = false,
  customCategories = [],
}: MedicationTableProps) {
  const { t, locale } = useTranslations();
  const { user } = useAuth();
  const userTz = user?.timezone || DEFAULT_TIMEZONE;
  const [sort, setSort] = useState<MedicationTableSort | null>(initialSort);
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  // The per-user low-stock runway threshold (v1.16.11), so the stock
  // cell's warn tier fires on the SAME days-of-runway predicate as the
  // low-stock notification, not a legacy dose count.
  const { data: thresholds } = useQuery({
    queryKey: queryKeys.settingsReminderThresholds(),
    queryFn: async () => {
      try {
        return await apiGet<{
          lowStockRunwayDays: number | null;
        }>("/api/settings/reminder-thresholds");
      } catch {
        return null;
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  // The whole batched compliance array — the Therapietreue sort needs
  // every row at once. Same key + fetcher as the per-row hook.
  const { data: complianceRows } = useMedicationComplianceSummaryAll();
  const shortRateById = new Map<string, number>(
    (complianceRows ?? []).flatMap((row) => {
      if (row.applicable === false) return [];
      const rate = shownAdherence(row).rate7;
      return rate === null ? [] : [[row.medicationId, rate] as const];
    }),
  );

  // Re-render once a minute so the status pill tracks wall-clock
  // progress — the cards tick on the same cadence.
  useEffect(() => {
    const interval = setInterval(forceUpdate, 60_000);
    return () => clearInterval(interval);
  }, []);

  const sortedActive = sortMedicationRows(
    activeMedications,
    sort,
    shortRateById,
    locale,
  );
  const sortedInactive = sortMedicationRows(
    inactiveMedications,
    sort,
    shortRateById,
    locale,
  );

  const activeWithCategory = sortedActive.map((m) => ({
    ...m,
    category: m.category ?? "OTHER",
  }));
  const inactiveWithCategory = sortedInactive.map((m) => ({
    ...m,
    category: m.category ?? "OTHER",
  }));

  const activeGroups = groupMedications(
    activeWithCategory,
    categoryOrder,
    t,
    customCategories,
    "active",
  );
  const inactiveGroups = groupMedications(
    inactiveWithCategory,
    categoryOrder,
    t,
    customCategories,
    "inactive",
  );

  // Read at render time, not memoised on the rows: the table re-renders every
  // minute, so a dose whose time passes since the fetch counts as due.
  const doseStateById = buildDoseStateById(complianceRows);

  const { isOpen, toggle } = useMedicationGroupsOpen(groupsOpen, isFiltered, {
    doseStateById,
    highlightId,
  });

  // Per-user low-stock runway threshold: explicit `null` = the alert is
  // OFF (no amber tier); a missing / failed read falls back to the
  // server default (7 days), mirroring `resolveLowStockRunwayDays`.
  const lowStockRunwayDays =
    thresholds == null ? 7 : thresholds.lowStockRunwayDays;

  const columns = getMedicationTableColumns(t);

  const renderMedicationRows = (medications: readonly TableMedication[]) =>
    medications.map((med) => (
      <MedicationTableRowItem
        key={med.id}
        medication={med}
        userTz={userTz}
        lowStockRunwayDays={lowStockRunwayDays}
        highlighted={highlightId === med.id}
      />
    ));

  return (
    // `overflow-hidden` is load-bearing: the sticky name column paints
    // an opaque `bg-card` cell background that would otherwise square
    // off the wrapper's rounded corners on the left edge. Horizontal
    // scrolling lives on the inner table-container (`overflow-x-auto`),
    // so clipping here costs nothing.
    <div className="bg-card border-border overflow-hidden rounded-xl border">
      <Table>
        <caption className="sr-only">{t("medications.tableCaption")}</caption>
        <TableHeader>
          <MedicationTableHeaderRow
            columns={columns}
            sort={sort}
            onSort={(column) =>
              setSort((current) => nextSortState(current, column))
            }
            t={t}
          />
        </TableHeader>
        <TableBody>
          {groupBy === "category" ? (
            <MedicationTableGroupedRows
              groups={activeGroups}
              isOpen={isOpen}
              toggle={toggle}
              colSpan={columns.length}
              renderRows={renderMedicationRows}
            />
          ) : (
            renderMedicationRows(sortedActive)
          )}
          {groupBy === "category" ? (
            <MedicationTableGroupedRows
              groups={inactiveGroups}
              isOpen={isOpen}
              toggle={toggle}
              colSpan={columns.length}
              renderRows={renderMedicationRows}
              sectionLabel={`${t("common.inactive")} (${sortedInactive.length})`}
            />
          ) : (
            renderMedicationRows(sortedInactive)
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function getMedicationTableColumns(t: (key: string) => string): Array<{
  key: MedicationTableSortColumn | "status" | "actions";
  label: string;
  sortable: boolean;
  className?: string;
}> {
  return [
    {
      key: "name",
      label: t("medications.tableColName"),
      sortable: true,
      // Sticky first column: the name stays anchored while the row
      // scrolls horizontally on narrow viewports.
      className: "bg-card sticky left-0 z-10",
    },
    { key: "status", label: t("medications.tableColStatus"), sortable: false },
    {
      key: "nextDue",
      label: t("medications.tableColNextDose"),
      sortable: true,
    },
    {
      key: "compliance",
      label: t("medications.tableColCompliance"),
      sortable: true,
    },
    { key: "stock", label: t("medications.tableColStock"), sortable: true },
    {
      key: "actions",
      label: t("medications.tableColActions"),
      sortable: false,
    },
  ];
}

function MedicationTableHeaderRow({
  columns,
  sort,
  onSort,
  t,
}: {
  columns: Array<{
    key: MedicationTableSortColumn | "status" | "actions";
    label: string;
    sortable: boolean;
    className?: string;
  }>;
  sort: MedicationTableSort | null;
  onSort: (column: MedicationTableSortColumn) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <TableRow>
      {columns.map((col) =>
        col.sortable ? (
          <TableHead
            key={col.key}
            scope="col"
            aria-sort={
              !sort || sort.column !== col.key
                ? "none"
                : sort.direction === "asc"
                  ? "ascending"
                  : "descending"
            }
            className={col.className}
          >
            <button
              type="button"
              onClick={() => onSort(col.key as MedicationTableSortColumn)}
              aria-label={t("medications.tableSortBy", {
                column: col.label,
              })}
              className="hover:text-foreground focus-visible:ring-ring inline-flex min-h-8 items-center gap-1 rounded font-medium focus-visible:ring-2 focus-visible:outline-none"
            >
              {col.label}
              {sort?.column === col.key ? (
                sort.direction === "asc" ? (
                  <ArrowUp className="size-3.5" aria-hidden="true" />
                ) : (
                  <ArrowDown className="size-3.5" aria-hidden="true" />
                )
              ) : (
                <ChevronsUpDown
                  className="text-muted-foreground size-3.5"
                  aria-hidden="true"
                />
              )}
            </button>
          </TableHead>
        ) : (
          <TableHead key={col.key} scope="col" className={col.className}>
            {col.label}
          </TableHead>
        ),
      )}
    </TableRow>
  );
}

interface MedicationTableRowItemProps {
  medication: TableMedication;
  userTz: string;
  /** Per-user low-stock runway threshold in days; null = alert off. */
  lowStockRunwayDays: number | null;
  /** v1.29.x — the deep-link highlight target (see `MedicationTableProps`). */
  highlighted?: boolean;
}

function MedicationTableRowItem({
  medication,
  userTz,
  lowStockRunwayDays,
  highlighted = false,
}: MedicationTableRowItemProps) {
  const { t, locale } = useTranslations();
  const dateFormatPref = useDateFormatPreference();
  const fmt = useFormatters();
  const weekdayLabel = useWeekdayLabel();

  // SAME mutation path as the cards — the shared take/skip hook with
  // failure toast + Undo. No card-specific follow-up here; the
  // injection-site prompt stays a card affordance.
  const { intakeLoading, recordIntake } = useMedicationIntake({ medication });
  // v1.36.x — marking a dose is admitted; a read-only delegate sees the row
  // without its action pair.
  const { canWriteDomain } = useRecordCapabilities();
  const canAddIntake = canWriteDomain("medications");

  // SAME batched compliance source as the cards.
  const { data: compliance } = useMedicationComplianceSummary(medication.id);
  const complianceNotApplicable = compliance?.applicable === false;
  const display = compliance?.complianceDisplay ?? undefined;
  // A window with no dose to score shows "no doses yet", never a rate.
  const {
    shortDays,
    longDays,
    rate7: rateShort,
    rate30: rateLong,
  } = shownAdherence(compliance);

  const sortedSchedules = [...medication.schedules].sort(
    (a, b) =>
      a.windowStart.localeCompare(b.windowStart) ||
      a.windowEnd.localeCompare(b.windowEnd),
  );
  const now = new Date();
  const nextDueMs = medication.nextDueAt
    ? new Date(medication.nextDueAt).getTime()
    : NaN;
  const nextAt = Number.isFinite(nextDueMs) ? nextDueMs : undefined;

  // The resolved open dose (`currentDose`), as on the cards: pill, status
  // and the slot the buttons record (THIS dose, not "now" snapped).
  const currentDose = display?.currentDose;
  const doseState = liveDoseState(currentDose, now);
  const pill = cardWindowPill(currentDose, now, userTz);
  const takeSlot = cardTakeSlot(currentDose, medication.nextDueAt, now);

  // Status cell in the card's precedence: escalation, then the pill.
  const canAct = medication.active && medication.intakeActionable !== false;
  const escalation: "missed" | "overdue" | null =
    canAct && doseState === "missed"
      ? "missed"
      : canAct && doseState === "overdue"
        ? "overdue"
        : null;

  const statusCell = escalation ? (
    <DoseStateLabel state={escalation} emphasis className="text-sm" />
  ) : pill ? (
    <MedicationStatusPill
      compact
      status={pill.status}
      windowStart={pill.windowStart}
      windowEnd={pill.windowEnd}
    />
  ) : (
    <span className="text-muted-foreground text-sm">–</span>
  );

  // Next-intake cell — the card's value logic, compacted: overdue slot
  // in calm amber, in-window shows the matched take-window range, a
  // future slot shows the relative day + canonical next-due time.
  const nextSchedule = sortedSchedules[0] ?? null;
  let nextCell: React.ReactNode = (
    <span className="text-muted-foreground">–</span>
  );
  const recordOnly = medication.trackIntake === false;
  if (recordOnly) {
    // v1.39.1 (#1033) — kept as a record: nothing is ever due.
    nextCell = (
      <span
        className="text-muted-foreground"
        data-slot="medication-table-record-only-marker"
      >
        {t("medications.recordOnlyBadge")}
      </span>
    );
  } else if (medication.courseStatus === "ENDED") {
    // v1.39.4 (#1040) — the course is over: nothing is due any more.
    nextCell = (
      <span
        className="text-muted-foreground"
        data-slot="medication-table-course-ended-marker"
      >
        {medication.previousCourseEndedOn
          ? t("medications.course.endedOn", {
              date: formatDate(
                new Date(medication.previousCourseEndedOn),
                dateFormatPref,
                locale,
              ),
            })
          : t("medications.courseEndedBadge")}
      </span>
    );
  } else if (medication.asNeeded) {
    // v1.16.11 — a calm marker where next-due normally sits; no due
    // pill, no overdue escalation, ever.
    nextCell = (
      <span
        className="text-muted-foreground"
        data-slot="medication-table-as-needed-marker"
      >
        {t("medications.asNeededMarker")}
      </span>
    );
  } else if (medication.active) {
    if (medication.nextDueOverdue && nextAt) {
      nextCell = <OverdueSlotValue at={nextAt} />;
    } else if (pill?.status === "in_window") {
      nextCell = (
        <span>
          {formatTimeWindowRange(
            pill.windowStart,
            pill.windowEnd,
            locale,
            fmt.wallTime,
          )}
        </span>
      );
    } else if (nextAt) {
      const label = resolveNextDueDayLabel(new Date(nextAt), now, userTz);
      const dayLabel =
        label.kind === "today"
          ? t("medications.today")
          : label.kind === "tomorrow"
            ? t("medications.tomorrow")
            : label.kind === "weekday"
              ? weekdayLabel(label.weekday)
              : fmt.dateWithWeekdaySmart(label.instant);
      nextCell = (
        <span>
          {dayLabel}, {formatTime(new Date(nextAt).toISOString())}
        </span>
      );
    } else if (nextSchedule) {
      nextCell = (
        <span>
          {formatTimeWindowRange(
            nextSchedule.windowStart,
            nextSchedule.windowEnd,
            locale,
            fmt.wallTime,
          )}
        </span>
      );
    }
  }

  // Therapietreue cell — the same two cadence-scaled windows the card
  // bars show, compacted to label + mini bar + percentage per row.
  const complianceCell = complianceNotApplicable ? (
    <span
      className="text-muted-foreground text-sm"
      data-slot="medication-table-compliance-not-applicable"
    >
      {t("medications.complianceNotApplicable")}
    </span>
  ) : compliance ? (
    <div className="flex flex-col gap-1">
      <TableComplianceRow days={shortDays} rate={rateShort} />
      <TableComplianceRow days={longDays} rate={rateLong} />
    </div>
  ) : (
    <div className="flex flex-col gap-1" aria-hidden="true">
      <Skeleton className="h-3.5 w-28" />
      <Skeleton className="h-3.5 w-28" />
    </div>
  );

  const stock = medication.stockDosesRemaining;
  // Projected days the stock covers — the same coarse estimate the
  // detail Übersicht renders, so the column answers "do I need a
  // refill" without opening the medication.
  // v1.37.19 — prefer the server's slot-aware `runwayDays`; client
  // estimate only as the stale-payload fallback.
  const runwayDays =
    medication.runwayDays !== undefined
      ? medication.runwayDays
      : stock === null || stock === undefined
        ? null
        : estimateRunwayDays(stock, medication.schedules);
  // Warn tier (amber) on the SAME predicate as the low-stock
  // notification: projected runway days strictly below the user's
  // threshold. Threshold OFF (null) → no amber tier; an exhausted stock
  // (0) stays destructive red regardless.
  const lowStock =
    runwayDays !== null &&
    lowStockRunwayDays !== null &&
    runwayDays < lowStockRunwayDays;
  const stockCell =
    stock === null || stock === undefined ? (
      <span className="text-muted-foreground">–</span>
    ) : (
      <span className="flex flex-col">
        <span
          className={cn(
            "tabular-nums",
            stock === 0
              ? "text-destructive font-medium"
              : lowStock
                ? "text-warning font-medium"
                : undefined,
          )}
        >
          {stock === 1
            ? t("medications.tableStockDoseOne", { count: stock })
            : t("medications.tableStockDoses", { count: stock })}
        </span>
        {runwayDays !== null && (
          <span
            className="text-muted-foreground text-xs"
            data-slot="medication-table-runway"
          >
            {t("medications.tableStockRunway", { days: runwayDays })}
          </span>
        )}
      </span>
    );

  return (
    <TableRow
      data-medication-id={medication.id}
      className={cn(
        !medication.active && "opacity-60",
        // v1.29.x — mirrors the card grid's transient highlight ring for
        // the Today digest's "Log dose" deep-link target.
        highlighted && "ring-primary ring-2",
      )}
    >
      {/* Sticky name column — opaque background so scrolled content
          passes underneath, not through. */}
      <TableCell className="bg-card sticky left-0 z-10">
        <Link
          href={`/medications/${medication.id}`}
          className="focus-visible:ring-ring block min-w-0 rounded focus-visible:ring-2 focus-visible:outline-none"
        >
          <span className="text-foreground block max-w-40 truncate text-sm font-medium sm:max-w-56">
            {medication.name}
          </span>
          <span className="text-muted-foreground block text-xs">
            {formatDose(medication.dose, t)}
            {!medication.active && <>, {t("common.inactive")}</>}
          </span>
          <span className="sr-only">{t("medications.openDetailPage")}</span>
        </Link>
      </TableCell>
      <TableCell>{statusCell}</TableCell>
      <TableCell className="text-sm">{nextCell}</TableCell>
      <TableCell>
        {medication.active && !medication.asNeeded && !recordOnly ? (
          complianceCell
        ) : (
          <span className="text-muted-foreground text-sm">–</span>
        )}
      </TableCell>
      <TableCell className="text-sm">{stockCell}</TableCell>
      <TableCell>
        {canAct && canAddIntake && !recordOnly ? (
          <div className="flex gap-1.5">
            <Button
              size="icon"
              className="size-11 sm:size-9"
              onClick={() => recordIntake(false, takeSlot)}
              disabled={!!intakeLoading}
              aria-label={t(
                takeSlot?.binding === "extra"
                  ? "medications.dose.action.takeExtraFor"
                  : "medications.dose.action.takeFor",
                { name: medication.name },
              )}
            >
              {intakeLoading === "take" ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Check className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="size-11 sm:size-9"
              onClick={() => recordIntake(true, takeSlot)}
              disabled={!!intakeLoading}
              aria-label={t("medications.dose.action.skipFor", {
                name: medication.name,
              })}
            >
              {intakeLoading === "skip" ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <SkipForward className="h-4 w-4" />
              )}
            </Button>
          </div>
        ) : (
          <span className="text-muted-foreground text-sm">–</span>
        )}
      </TableCell>
    </TableRow>
  );
}

export { MedicationTableSkeleton } from "./medication-table-skeleton";
