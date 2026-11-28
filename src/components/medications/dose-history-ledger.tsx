"use client";

/**
 * The History tab's dose history: one row per dose, one card per week.
 *
 * Renders the server-minted ledger (`GET /api/medications/[id]/dose-history`):
 * every expected slot with its status (on time / late / skipped / missed /
 * open) even when never taken, plus every off-schedule take. Each week is a
 * `ListGroup` under its heading, newest first; each dose is a `ListItem`
 * (`ledger-row-item.tsx`) whose second line appears only when what happened
 * differs from the plan. The two most recent weeks show first; older weeks
 * come in on request, so ninety days of a twice-daily plan never land on the
 * page at once.
 *
 * Above the weeks: the window's rate with the counts that are not zero, and
 * "Log past dose". The rate's bar lives once, on the overview.
 *
 * A row opens the dose's sheet (take, skip, pin, release, edit, toggle, open
 * the day, delete); a take or skip is optimistic, with an undo toast.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Loader2, Plus } from "lucide-react";

import { openDay } from "@/components/day/day-layer-controller";
import type { DateKey } from "@/lib/day/contract";
import { isOpenableDay } from "@/components/day/day-url";
import { useTodayKey } from "@/components/day/use-today-key";
import { LedgerAddDialog } from "@/components/medications/dose-history-add-dialog";
import { IntakeEditDialog } from "@/components/medications/intake-edit-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListGroup } from "@/components/ui/list-row";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { formatDateWithWeekdaySmart } from "@/lib/date-format";
import {
  useDateFormatPreference,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";
import { dateOnlyAtNoonUtc, dateOnlyKey } from "@/lib/tz/date-only";

import { PinConfirm } from "./dose-history/ledger-confirms";
import {
  doseActionsOf,
  LedgerDoseRow,
  LedgerDoseSheet,
  type LedgerDose,
  type LedgerRowHandlers,
} from "./dose-history/ledger-row-item";
import { useDoseHistoryLedger } from "./dose-history/use-dose-history-ledger";
import type {
  LedgerCompliance,
  LedgerDayGroup,
} from "./dose-history-ledger-compute";

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

/** Weeks shown at first, and added per "Show earlier weeks". */
const WEEKS_FIRST = 2;
const WEEKS_MORE = 4;

/** The Monday that starts a day key's week, as a day key. */
export function weekStartKey(dayKey: string): string {
  const noon = dateOnlyAtNoonUtc(dayKey);
  const back = (noon.getUTCDay() + 6) % 7;
  return dateOnlyKey(new Date(noon.getTime() - back * 24 * 60 * 60 * 1000));
}

/** Day groups (newest first) folded into weeks, newest first. */
export function ledgerWeeks(
  groups: LedgerDayGroup[],
): { weekKey: string; days: LedgerDayGroup[] }[] {
  const weeks: { weekKey: string; days: LedgerDayGroup[] }[] = [];
  for (const group of groups) {
    const weekKey = weekStartKey(group.dayKey);
    const last = weeks[weeks.length - 1];
    if (last && last.weekKey === weekKey) last.days.push(group);
    else weeks.push({ weekKey, days: [group] });
  }
  return weeks;
}

export function DoseHistoryLedger({
  medicationId,
  medicationName,
  medicationDose,
  schedules,
  windowDays = 90,
  controls,
}: DoseHistoryLedgerProps & {
  /** The range switch, at the right of the summary line. */
  controls?: ReactNode;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // A delegate may record a dose, which is what "add" and take/skip do.
  // Editing, deleting, pinning and un-skipping are the owner's.
  const { canWriteDomain } = useRecordCapabilities();
  const canAddIntake = canWriteDomain("medications");
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

  const handlers: LedgerRowHandlers = {
    onMark: markSlot,
    onToggleSkipped: toggleIntakeSkipped,
    onEdit: (ev) => setEditingEvent(ev),
    onDelete: (intake) => void deleteRow(intake),
    onPin: (eventId, slotAt) => setPendingPin({ eventId, slotAt }),
    onUnpin: (eventId) => void setAttribution(eventId, null),
  };

  return (
    <div className="space-y-6" data-slot="dose-history-ledger">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <LedgerSummary compliance={compliance} windowDays={windowDays} />
        <div className="ml-auto flex items-center gap-2">
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
          {controls}
        </div>
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
        <LedgerWeeks
          groups={groups}
          todayKey={todayKey}
          marking={marking}
          handlers={handlers}
        />
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

/**
 * The window's rate and the counts behind it, a zero count left out: one
 * line, no bar (the overview carries the picture).
 */
function LedgerSummary({
  compliance,
  windowDays,
}: {
  compliance: LedgerCompliance | null;
  windowDays: number;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  if (!compliance || compliance.denominator === 0) {
    return (
      <p className="text-muted-foreground text-sm" data-slot="ledger-summary">
        {t("medications.detail.verlauf.summaryEmpty")}
      </p>
    );
  }
  const { takenOnTime, takenLate, missed, rate } = compliance;
  const counts = [
    t("medications.detail.overview.legend.taken", { count: takenOnTime }),
    takenLate > 0
      ? t("medications.detail.overview.legend.late", { count: takenLate })
      : null,
    missed > 0
      ? t("medications.detail.overview.legend.missed", { count: missed })
      : null,
  ].filter(Boolean);
  return (
    <div className="min-w-0" data-slot="ledger-summary">
      <p className="text-sm">
        <span className="text-foreground font-semibold tabular-nums">
          {rate !== null ? fmt.percent(rate / 100) : "—"}
        </span>{" "}
        <span className="text-muted-foreground">
          {t("medications.complianceWindow", { days: windowDays })}
        </span>
      </p>
      <p className="text-muted-foreground text-xs">{counts.join(", ")}</p>
    </div>
  );
}

/** The weeks, newest first, each one card of doses. */
function LedgerWeeks({
  groups,
  todayKey,
  marking,
  handlers,
}: {
  groups: LedgerDayGroup[];
  todayKey: string;
  marking: string | null;
  handlers: LedgerRowHandlers;
}) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const dateFormatPref = useDateFormatPreference();
  const today = useTodayKey();
  const { canWriteDomain, canManageDomain } = useRecordCapabilities();
  const can = {
    write: canWriteDomain("medications"),
    manage: canManageDomain("medications"),
  };
  const [shownWeeks, setShownWeeks] = useState(WEEKS_FIRST);
  const [open, setOpen] = useState<LedgerDose | null>(null);
  const weeks = useMemo(() => ledgerWeeks(groups), [groups]);
  // The dose time joins the day only when a day has more than one dose.
  const multiSlot = ledgerColumns(groups).length > 1;

  const doseOf = (
    group: LedgerDayGroup,
    row: LedgerDayGroup["rows"][number],
  ) => {
    const day = formatDateWithWeekdaySmart(
      group.dayKey,
      dateFormatPref,
      locale,
    );
    const suffix =
      row.kind === "ad_hoc"
        ? t("medications.detail.verlauf.extraColumn")
        : multiSlot && row.timeOfDay
          ? fmt.wallTime(row.timeOfDay)
          : null;
    const dayKey = group.dayKey;
    const dose: LedgerDose = {
      row,
      title: suffix ? `${day}, ${suffix}` : day,
      onOpenDay: isOpenableDay(dayKey, today)
        ? () => openDay(dayKey as DateKey)
        : undefined,
    };
    return dose;
  };

  return (
    <div className="space-y-6" data-slot="ledger-weeks">
      {weeks.slice(0, shownWeeks).map((week) => (
        <section
          key={week.weekKey}
          className="space-y-2"
          data-slot="ledger-week"
          data-week={week.weekKey}
        >
          <h3 className="text-sm font-semibold">
            {week.weekKey === weekStartKey(todayKey)
              ? t("medications.detail.verlauf.thisWeek")
              : t("medications.detail.verlauf.weekOf", {
                  date: fmt.dateShortSmartCalendar(week.weekKey),
                })}
          </h3>
          <ListGroup>
            {week.days.flatMap((group) =>
              [...group.rows].reverse().map((row, i) => {
                const dose = doseOf(group, row);
                const actionable =
                  doseActionsOf(row, can, Boolean(dose.onOpenDay)).length > 0;
                return (
                  <LedgerDoseRow
                    key={`${group.dayKey}:${row.at}:${row.intake?.id ?? i}`}
                    dose={dose}
                    onOpen={actionable ? () => setOpen(dose) : undefined}
                  />
                );
              }),
            )}
          </ListGroup>
        </section>
      ))}
      {weeks.length > shownWeeks && (
        <Button
          variant="outline"
          className="min-h-11 w-full sm:min-h-9"
          onClick={() => setShownWeeks((n) => n + WEEKS_MORE)}
          data-slot="ledger-more"
        >
          {t("medications.detail.verlauf.showEarlier")}
        </Button>
      )}
      <LedgerDoseSheet
        dose={open}
        onClose={() => setOpen(null)}
        handlers={handlers}
        marking={marking}
      />
    </div>
  );
}
