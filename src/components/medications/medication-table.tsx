"use client";

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
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { MedicationStatusPill } from "@/components/medications/card-parts/medication-status-pill";
import { useWeekdayLabel } from "@/components/medications/card-parts/medication-next-last-slot";
import { resolveDisplayedSlotInstant } from "@/components/medications/card-parts/displayed-slot-instant";
import { estimateRunwayDays } from "@/components/medications/detail/supply-runway";
import { useMedicationIntake } from "@/components/medications/use-medication-intake";
import { reduceCurrentWindowStatus } from "@/lib/medications/window-status";
import { resolveNextDueDayLabel } from "@/lib/medications/next-due-day-label";
import { formatTime } from "@/lib/format";
import { formatTimeWindowRange } from "@/lib/time-window-format";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { formatDose } from "@/lib/medications/format-dose";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import {
  useMedicationComplianceSummary,
  useMedicationComplianceSummaryAll,
} from "@/lib/queries/use-medication-compliance-summary";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

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
  /** v1.16.10 — dose-derived stock from the list payload; null = inventory tracking off. */
  stockDosesRemaining?: number | null;
  /** v1.37.19 — server-resolved slot-aware runway (days); null = off/no cadence. */
  runwayDays?: number | null;
  schedules: TableSchedule[];
}

export type MedicationTableSortColumn =
  "name" | "nextDue" | "compliance" | "stock";

export interface MedicationTableSort {
  column: MedicationTableSortColumn;
  direction: "asc" | "desc";
}

/**
 * Tri-state header click cycle: none → ascending → descending → none.
 * `null` = the manual (user-defined) order the page passed in.
 */
export function nextSortState(
  current: MedicationTableSort | null,
  column: MedicationTableSortColumn,
): MedicationTableSort | null {
  if (!current || current.column !== column) {
    return { column, direction: "asc" };
  }
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

/**
 * Client-side sort over the loaded list. Rows without a value for the
 * chosen column (no next due, no compliance row yet, inventory tracking
 * off) sort last in BOTH directions — an unknown must never outrank a
 * known value. `null` sort returns the input order untouched (the
 * manual order).
 */
export function sortMedicationRows<T extends TableMedication>(
  rows: readonly T[],
  sort: MedicationTableSort | null,
  shortRateById?: ReadonlyMap<string, number>,
  /** Active UI locale for name collation; omitted = runtime default. */
  locale?: string,
): T[] {
  if (!sort) return [...rows];
  const dir = sort.direction === "asc" ? 1 : -1;
  const value = (m: T): number | string | null => {
    switch (sort.column) {
      case "name":
        return m.name;
      case "nextDue": {
        if (!m.nextDueAt) return null;
        const ms = new Date(m.nextDueAt).getTime();
        return Number.isFinite(ms) ? ms : null;
      }
      case "compliance":
        return shortRateById?.get(m.id) ?? null;
      case "stock":
        return m.stockDosesRemaining ?? null;
    }
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "string" && typeof vb === "string") {
      return va.localeCompare(vb, locale, { sensitivity: "base" }) * dir;
    }
    return ((va as number) - (vb as number)) * dir;
  });
}

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
}

export function MedicationTable({
  activeMedications,
  inactiveMedications,
  initialSort = null,
  highlightId = null,
}: MedicationTableProps) {
  const { t, locale } = useTranslations();
  const { user } = useAuth();
  const userTz = user?.timezone || "Europe/Berlin";
  const [sort, setSort] = useState<MedicationTableSort | null>(initialSort);
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  // Same reminder-thresholds source as the cards so the status pill
  // tiers identically on both presentations. The read also carries the
  // per-user low-stock runway threshold (v1.16.11) so the stock cell's
  // warn tier fires on the SAME days-of-runway predicate as the
  // low-stock notification, not a legacy dose count.
  const { data: thresholds } = useQuery({
    queryKey: queryKeys.settingsReminderThresholds(),
    queryFn: async () => {
      try {
        return await apiGet<{
          lateMinutes: number;
          missedMinutes: number;
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
    (complianceRows ?? []).map((row) => [
      row.medicationId,
      row.complianceDisplay?.short.rate ?? row.compliance7?.rate ?? 0,
    ]),
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

  const lateMinutes = thresholds?.lateMinutes ?? 120;
  const missedMinutes = thresholds?.missedMinutes ?? 240;
  // Per-user low-stock runway threshold: explicit `null` = the alert is
  // OFF (no amber tier); a missing / failed read falls back to the
  // server default (7 days), mirroring `resolveLowStockRunwayDays`.
  const lowStockRunwayDays =
    thresholds == null ? 7 : thresholds.lowStockRunwayDays;

  const columns: Array<{
    key: MedicationTableSortColumn | "status" | "actions";
    label: string;
    sortable: boolean;
    className?: string;
  }> = [
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

  function ariaSort(
    column: MedicationTableSortColumn,
  ): "ascending" | "descending" | "none" {
    if (!sort || sort.column !== column) return "none";
    return sort.direction === "asc" ? "ascending" : "descending";
  }

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
          <TableRow>
            {columns.map((col) =>
              col.sortable ? (
                <TableHead
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort(col.key as MedicationTableSortColumn)}
                  className={col.className}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSort((current) =>
                        nextSortState(
                          current,
                          col.key as MedicationTableSortColumn,
                        ),
                      )
                    }
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
        </TableHeader>
        <TableBody>
          {sortedActive.map((med) => (
            <MedicationTableRowItem
              key={med.id}
              medication={med}
              userTz={userTz}
              lateMinutes={lateMinutes}
              missedMinutes={missedMinutes}
              lowStockRunwayDays={lowStockRunwayDays}
              highlighted={highlightId === med.id}
            />
          ))}
          {sortedInactive.map((med) => (
            <MedicationTableRowItem
              key={med.id}
              medication={med}
              userTz={userTz}
              lateMinutes={lateMinutes}
              missedMinutes={missedMinutes}
              lowStockRunwayDays={lowStockRunwayDays}
              highlighted={highlightId === med.id}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

interface MedicationTableRowItemProps {
  medication: TableMedication;
  userTz: string;
  lateMinutes: number;
  missedMinutes: number;
  /** Per-user low-stock runway threshold in days; null = alert off. */
  lowStockRunwayDays: number | null;
  /** v1.29.x — the deep-link highlight target (see `MedicationTableProps`). */
  highlighted?: boolean;
}

function MedicationTableRowItem({
  medication,
  userTz,
  lateMinutes,
  missedMinutes,
  lowStockRunwayDays,
  highlighted = false,
}: MedicationTableRowItemProps) {
  const { t, locale } = useTranslations();
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
  const display = compliance?.complianceDisplay;
  const shortDays = display?.shortDays ?? 7;
  const longDays = display?.longDays ?? 30;
  const rateShort = display?.short.rate ?? compliance?.compliance7?.rate ?? 0;
  const rateLong = display?.long.rate ?? compliance?.compliance30?.rate ?? 0;
  const doseStatus = display?.currentDose.status ?? "upcoming";

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

  // The SAME served-next-due-gated pill reduction the cards run —
  // including the v1.16.6 `nextDue` gate so a rolling cadence whose
  // next dose is tomorrow can never paint an overdue pill today.
  const currentWindowStatus = reduceCurrentWindowStatus({
    schedules: sortedSchedules,
    now,
    lateMinutes,
    missedMinutes,
    active: medication.active,
    lastTakenAt: medication.lastTakenAt,
    todayEventCount: medication.todayEventCount ?? 0,
    tz: userTz,
    nextDue:
      medication.nextDueAt === undefined
        ? undefined
        : nextAt !== undefined
          ? {
              at: new Date(nextAt),
              overdue: medication.nextDueOverdue === true,
            }
          : null,
  });

  // Same displayed-slot threading as the cards so the server records
  // THIS dose rather than snapping "now" to the nearest slot.
  const displayedSlot = resolveDisplayedSlotInstant({
    currentWindowStatus,
    nextDueAt: medication.nextDueAt,
    now,
    timeZone: userTz,
  });

  // Status cell — the card body's precedence with one DELIBERATE
  // divergence: the card suppresses the taken-early pill on its
  // next-intake row (the "last intake" line below already names the
  // dose), while the table keeps it — the table has a dedicated Status
  // column with no neighbouring last-intake context. Order here:
  // last-dose context outranks the overdue escalation, which outranks
  // the window pill.
  const overdueLabel =
    medication.active && doseStatus === "missed"
      ? t("medications.veryOverdue")
      : medication.active && doseStatus === "overdue"
        ? t("medications.overdue")
        : null;

  const statusCell =
    currentWindowStatus.status &&
    currentWindowStatus.takenEarlyDaysAgo != null ? (
      <MedicationStatusPill
        compact
        status={currentWindowStatus.status}
        windowStart={currentWindowStatus.window!.start}
        windowEnd={currentWindowStatus.window!.end}
        takenEarlyDaysAgo={currentWindowStatus.takenEarlyDaysAgo}
      />
    ) : overdueLabel ? (
      <span className="text-destructive text-sm font-medium">
        {overdueLabel}
      </span>
    ) : currentWindowStatus.status ? (
      <MedicationStatusPill
        compact
        status={currentWindowStatus.status}
        windowStart={currentWindowStatus.window!.start}
        windowEnd={currentWindowStatus.window!.end}
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
  if (medication.asNeeded) {
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
      nextCell = (
        <span className="text-warning font-medium">
          {t("medications.nextIntakeOverdue", {
            time: formatTime(new Date(nextAt).toISOString()),
          })}
        </span>
      );
    } else if (currentWindowStatus.status === "in_window") {
      nextCell = (
        <span>
          {formatTimeWindowRange(
            currentWindowStatus.window!.start,
            currentWindowStatus.window!.end,
            locale,
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
          )}
        </span>
      );
    }
  }

  // Therapietreue cell — the same two cadence-scaled windows the card
  // bars show, compacted to label + mini bar + percentage per row.
  const complianceCell = compliance ? (
    <div className="flex flex-col gap-1">
      {(
        [
          [shortDays, rateShort],
          [longDays, rateLong],
        ] as const
      ).map(([days, rate]) => (
        <div key={days} className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground w-8 shrink-0 tabular-nums">
            {t("medications.tableComplianceDays", { days })}
          </span>
          <Progress
            value={rate}
            className="h-1.5 w-14"
            aria-label={t("medications.complianceWindow", { days })}
          />
          <span className="w-9 text-right font-medium tabular-nums">
            {fmt.number(Math.round(rate))}%
          </span>
        </div>
      ))}
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
            ? t("medications.tableStockDoseOne")
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
          aria-label={t("medications.openDetailPage")}
          className="focus-visible:ring-ring block min-w-0 rounded focus-visible:ring-2 focus-visible:outline-none"
        >
          <span className="text-foreground block max-w-40 truncate text-sm font-medium sm:max-w-56">
            {medication.name}
          </span>
          <span className="text-muted-foreground block text-xs">
            {formatDose(medication.dose, t)}
            {!medication.active && <> · {t("common.inactive")}</>}
          </span>
        </Link>
      </TableCell>
      <TableCell>{statusCell}</TableCell>
      <TableCell className="text-sm">{nextCell}</TableCell>
      <TableCell>
        {medication.active && !medication.asNeeded ? (
          complianceCell
        ) : (
          <span className="text-muted-foreground text-sm">–</span>
        )}
      </TableCell>
      <TableCell className="text-sm">{stockCell}</TableCell>
      <TableCell>
        {medication.active && canAddIntake ? (
          <div className="flex gap-1.5">
            <Button
              size="icon"
              className="size-11 sm:size-9"
              onClick={() => recordIntake(false, displayedSlot)}
              disabled={!!intakeLoading}
              aria-label={t("medications.takeActionFor", {
                name: medication.name,
              })}
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
              onClick={() => recordIntake(true, displayedSlot)}
              disabled={!!intakeLoading}
              aria-label={t("medications.skipActionFor", {
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

/**
 * Loading placeholder for the table view. Mirrors the loaded table's
 * shell (same container, same column count, same row height) so the
 * page reserves the footprint and does not jump when the rows resolve —
 * the table-view counterpart of `MedicationCardSkeleton`.
 */
export function MedicationTableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div
      className="bg-card border-border overflow-hidden rounded-xl border"
      aria-hidden="true"
    >
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: 6 }).map((_, i) => (
              <TableHead key={i}>
                <Skeleton className="h-4 w-16" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3.5 w-28" />
                </div>
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-14" />
              </TableCell>
              <TableCell>
                <div className="flex gap-1.5">
                  <Skeleton className="size-11 rounded-md sm:size-9" />
                  <Skeleton className="size-11 rounded-md sm:size-9" />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
