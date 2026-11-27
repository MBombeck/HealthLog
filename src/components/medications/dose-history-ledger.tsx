"use client";

/**
 * The Verlauf tab's dose history: one table row per day.
 *
 * Renders the server-minted ledger (`GET /api/medications/[id]/dose-history`):
 * every expected slot with its status (on time / late / skipped / missed /
 * open) even when never taken, plus every off-schedule intake. A day is one
 * row: the date, a column per dose time, a column for off-schedule takes, and
 * the day's menu. Most recent day first.
 *
 * Interactions:
 *   - a slot still in play (open, or missed today) keeps a visible take
 *     button in its cell; the mark is optimistic (the cached ledger and the
 *     headline rate move before the server write) with an undo toast;
 *   - everything else sits in the day's menu: open the day, backfill a past
 *     missed slot, skip, pin an off-schedule take onto its slot (behind a
 *     confirm that names the consequence) or release it, edit, the
 *     skipped/taken toggle, delete;
 *   - "Nachtragen" opens the add dialog for this medication (backdated or
 *     off-schedule, with the "assign to slot?" nudge).
 *
 * The summary above the table (rate, bar, counts) reads the same rows.
 */

import { useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { openDay } from "@/components/day/day-layer-controller";
import type { DateKey } from "@/lib/day/contract";
import { isOpenableDay } from "@/components/day/day-url";
import { useTodayKey } from "@/components/day/use-today-key";
import { LedgerAddDialog } from "@/components/medications/dose-history-add-dialog";
import { IntakeEditDialog } from "@/components/medications/intake-edit-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { formatDateWithWeekdaySmart } from "@/lib/date-format";
import {
  useDateFormatPreference,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";

import { PinConfirm } from "./dose-history/ledger-confirms";
import {
  LedgerDayMenu,
  LedgerDoseCell,
  type LedgerRowHandlers,
} from "./dose-history/ledger-row-item";
import { LedgerSummaryChart } from "./dose-history/ledger-summary-chart";
import { useDoseHistoryLedger } from "./dose-history/use-dose-history-ledger";
import type { LedgerDayGroup, LedgerRow } from "./dose-history-ledger-compute";

/** A schedule slot the add dialog offers for pinning. */
export interface LedgerSchedule {
  windowStart: string;
  label: string | null;
  dose: string | null;
  timesOfDay?: string[];
}

export interface DoseHistoryLedgerProps {
  medicationId: string;
  medicationName: string;
  /** The configured dose, the add form's starting dose. */
  medicationDose?: string;
  schedules: LedgerSchedule[];
  /** Trailing window in days the ledger renders. Defaults to 90. */
  windowDays?: number;
}

/** The dose times the window holds, as columns: "08:00" before "20:00". */
export function ledgerColumns(groups: LedgerDayGroup[]): string[] {
  const times = new Set<string>();
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.kind === "slot" && row.timeOfDay) times.add(row.timeOfDay);
    }
  }
  return [...times].sort();
}

export function DoseHistoryLedger({
  medicationId,
  medicationName,
  medicationDose,
  schedules,
  windowDays = 90,
}: DoseHistoryLedgerProps) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const dateFormatPref = useDateFormatPreference();
  // A delegate may record a dose, which is what "add" and the visible take
  // do. Editing, deleting, pinning and un-skipping an existing event are the
  // owner's, so the day menu is absent for them.
  const { canWriteDomain } = useRecordCapabilities();
  const canAddIntake = canWriteDomain("medications");
  const today = useTodayKey();
  const [addOpen, setAddOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<{
    id: string;
    takenAt: string | null;
    skipped: boolean;
    scheduledFor: string | null;
  } | null>(null);
  const {
    queryKey,
    data,
    isLoading,
    isError,
    error,
    refetch,
    compliance,
    groups,
    todayKey,
    marking,
    markSlot,
    toggleIntakeSkipped,
    setAttribution,
    deleteRow,
    pendingPin,
    setPendingPin,
  } = useDoseHistoryLedger({ medicationId, medicationName, windowDays });

  const columns = useMemo(() => ledgerColumns(groups), [groups]);
  const hasOffSchedule = groups.some((g) =>
    g.rows.some((row) => row.kind === "ad_hoc"),
  );

  const handlers: LedgerRowHandlers = {
    onMark: markSlot,
    onToggleSkipped: toggleIntakeSkipped,
    onEdit: (ev) => setEditingEvent(ev),
    onDelete: (intake) => void deleteRow(intake),
    onPin: (eventId, slotAt) => setPendingPin({ eventId, slotAt }),
    onUnpin: (eventId) => void setAttribution(eventId, null),
  };

  return (
    <div className="space-y-4" data-slot="dose-history-ledger">
      <div className="flex items-end justify-between gap-3">
        {compliance && compliance.denominator > 0 ? (
          <LedgerSummaryChart compliance={compliance} windowDays={windowDays} />
        ) : (
          <p className="text-muted-foreground text-sm">
            {t("medications.detail.verlauf.summaryEmpty")}
          </p>
        )}
        {canAddIntake && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAddOpen(true)}
            className="min-h-11 shrink-0 sm:min-h-9"
            data-slot="ledger-add"
          >
            <Plus aria-hidden="true" className="size-4" />
            {t("medications.detail.verlauf.backfill")}
          </Button>
        )}
      </div>

      {isLoading && (
        <div
          className="text-muted-foreground flex items-center gap-2 py-6 text-sm"
          role="status"
          aria-busy="true"
        >
          <Loader2
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
          {t("medications.detail.verlauf.loading")}
        </div>
      )}

      {isError && (
        <QueryErrorRow
          inset
          error={error}
          slot="dose-history-error"
          message={t("medications.detail.verlauf.loadError")}
          onRetry={() => void refetch()}
          className="py-6"
        />
      )}

      {data && !isLoading && groups.length === 0 && (
        <EmptyState
          variant="plain"
          size="compact"
          title={t("medications.detail.verlauf.empty")}
        />
      )}

      {data && groups.length > 0 && (
        <table className="w-full table-fixed text-sm" data-slot="ledger-table">
          <caption className="sr-only">
            {t("medications.detail.intake.title")}
          </caption>
          <thead>
            <tr className="border-border/60 text-muted-foreground border-b text-left text-xs">
              <th scope="col" className="w-[34%] py-2 pr-2 font-medium">
                {t("medications.detail.verlauf.dayColumn")}
              </th>
              {columns.map((time) => (
                <th
                  key={time}
                  scope="col"
                  className="px-2 py-2 font-medium tabular-nums"
                >
                  {fmt.wallTime(time)}
                </th>
              ))}
              {(hasOffSchedule || columns.length === 0) && (
                <th scope="col" className="px-2 py-2 font-medium">
                  {columns.length === 0
                    ? t("medications.detail.verlauf.takenColumn")
                    : t("medications.detail.verlauf.extraColumn")}
                </th>
              )}
              <th scope="col" className="w-11 py-2">
                <span className="sr-only">
                  {t("medications.detail.verlauf.actionsColumn")}
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-border/60 divide-y">
            {groups.map((group) => {
              const dayLabel = formatDateWithWeekdaySmart(
                group.dayKey,
                dateFormatPref,
                locale,
              );
              const isToday = group.dayKey === todayKey;
              const dayKey = group.dayKey;
              const openable = isOpenableDay(dayKey, today);
              const offSchedule = group.rows.filter(
                (row) => row.kind === "ad_hoc",
              );
              return (
                <tr
                  key={group.dayKey}
                  className="h-11 align-middle"
                  data-slot="ledger-day"
                  data-day={group.dayKey}
                >
                  <th
                    scope="row"
                    className="text-muted-foreground py-1.5 pr-2 text-left font-normal tabular-nums"
                  >
                    {dayLabel}
                  </th>
                  {columns.map((time) => (
                    <td key={time} className="px-2 py-1.5">
                      {group.rows
                        .filter(
                          (row) =>
                            row.kind === "slot" && row.timeOfDay === time,
                        )
                        .map((row, i) => (
                          <LedgerDoseCell
                            key={`${row.at}:${row.intake?.id ?? i}`}
                            row={row}
                            marking={marking}
                            isToday={isToday}
                            onMark={markSlot}
                          />
                        ))}
                    </td>
                  ))}
                  {(hasOffSchedule || columns.length === 0) && (
                    <td className="px-2 py-1.5">
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {offSchedule.map((row: LedgerRow, i) => (
                          <LedgerDoseCell
                            key={`${row.at}:${row.intake?.id ?? i}`}
                            row={row}
                            marking={marking}
                            isToday={isToday}
                            onMark={markSlot}
                          />
                        ))}
                      </div>
                    </td>
                  )}
                  <td className="py-1 text-right">
                    <LedgerDayMenu
                      dayLabel={dayLabel}
                      rows={group.rows}
                      isToday={isToday}
                      onOpenDay={
                        openable ? () => openDay(dayKey as DateKey) : undefined
                      }
                      handlers={handlers}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <IntakeEditDialog
        medicationId={medicationId}
        event={editingEvent}
        onClose={() => setEditingEvent(null)}
      />

      {addOpen && (
        <LedgerAddDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          medicationId={medicationId}
          medicationName={medicationName}
          medicationDose={medicationDose}
          schedules={schedules}
          ledgerKey={queryKey}
        />
      )}

      {pendingPin && (
        <PinConfirm
          slotLabel={fmt.time(new Date(pendingPin.slotAt))}
          onConfirm={() => {
            const pin = pendingPin;
            setPendingPin(null);
            void setAttribution(pin.eventId, pin.slotAt);
          }}
          onCancel={() => setPendingPin(null)}
        />
      )}
    </div>
  );
}
