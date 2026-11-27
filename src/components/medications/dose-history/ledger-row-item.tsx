"use client";

/**
 * The dose history's pieces: one cell per dose of a day, and the one menu
 * per day that holds every action on that day's doses.
 *
 * A day is one table row: the date, a column per dose time, the off-schedule
 * takes, the menu. A taken dose shows the time it was taken, which is the
 * one time the planned column does not already say; a dose that waits shows
 * its state in the shared dose vocabulary. A dose still in play today keeps
 * its visible take button in the cell (and a delegate, who has no menu, the
 * skip beside it); everything else (backfill, re-attribution, edit, the
 * skipped/taken toggle, delete, opening the day) lives in the day's menu, so
 * the history reads as a record, not a wall of buttons.
 */

import {
  CalendarDays,
  Check,
  Link2,
  Loader2,
  MoreVertical,
  Pencil,
  SkipForward,
  Trash2,
  Unlink,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import {
  DOSE_STATE_LOOK,
  DoseStateLabel,
} from "@/components/medications/dose-state-label";
import type { DeletedIntakeSnapshot } from "@/components/medications/use-medication-intake";
import { intakeDeleteLabel } from "@/components/medications/intake-dose-label";
import type { DoseState } from "@/lib/medications/dose-state/resolve";
import {
  DOSE_ACTION_TERM,
  DOSE_STATE_TERM,
  doseStateOfHistoryRow,
} from "@/lib/medications/dose-state/terms";

import {
  isSlotActionable,
  type LedgerRow,
} from "../dose-history-ledger-compute";

export interface LedgerRowHandlers {
  onMark: (row: LedgerRow, action: "taken" | "skipped") => void;
  onToggleSkipped: (intake: {
    id: string;
    skipped: boolean;
    scheduledFor: string | null;
  }) => void;
  onEdit: (event: {
    id: string;
    takenAt: string | null;
    skipped: boolean;
    scheduledFor: string | null;
  }) => void;
  /** Delete the row's intake at once; the toast carries the undo. */
  onDelete: (intake: DeletedIntakeSnapshot) => void;
  /** Open the pin confirm for an ad-hoc take onto the named slot (ISO). */
  onPin: (eventId: string, slotAt: string) => void;
  /** Release a pinned binding (server re-attributes by band). */
  onUnpin: (eventId: string) => void;
}

/** A dose still in play: a visible take button rather than a menu entry. */
function inPlay(row: LedgerRow, isToday: boolean): boolean {
  return isSlotActionable(row) && (row.status === "upcoming" || isToday);
}

/**
 * One dose in the day row. Exported for the delegated-affordance suite: the
 * capability gating is the interesting part.
 */
export function LedgerDoseCell({
  row,
  marking,
  isToday,
  onMark,
}: {
  row: LedgerRow;
  marking: string | null;
  isToday: boolean;
  onMark: LedgerRowHandlers["onMark"];
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { canWriteDomain, canManageDomain } = useRecordCapabilities();
  const canAddIntake = canWriteDomain("medications");
  const canManageMedications = canManageDomain("medications");
  const state = doseStateOfHistoryRow(row);
  const intake = row.intake;
  const takeBusy = marking === `${row.at}:taken`;
  const skipBusy = marking === `${row.at}:skipped`;
  const showTake = inPlay(row, isToday) && canAddIntake;

  // A taken dose (or an off-schedule take): the time it was taken, in the
  // tone of its state, with the state's word for a screen reader. Every
  // other dose: the state's glyph and word.
  const takenTime =
    (state === "taken" || state === "taken_late" || row.kind === "ad_hoc") &&
    intake?.takenAt
      ? fmt.time(new Date(intake.takenAt))
      : null;

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
      data-slot="ledger-row"
      data-status={row.status}
      data-kind={row.kind}
    >
      {takenTime ? (
        <TakenTime
          state={state ?? "taken"}
          time={takenTime}
          pinned={row.kind === "slot" && row.pinned === true}
        />
      ) : state ? (
        <DoseStateLabel
          state={state}
          className="text-sm"
          slot="ledger-status"
        />
      ) : null}
      {intake?.doseTaken && (
        <span
          className="text-muted-foreground text-xs"
          data-slot="ledger-dose-taken"
        >
          {t("medications.detail.verlauf.doseTaken", {
            dose: intake.doseTaken,
          })}
        </span>
      )}
      {showTake && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onMark(row, "taken")}
          disabled={takeBusy || skipBusy}
          aria-busy={takeBusy || undefined}
          className="min-h-9"
          data-slot="ledger-mark-taken"
        >
          {takeBusy ? (
            <Loader2
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          ) : (
            <Check aria-hidden="true" className="size-4" />
          )}
          {t(DOSE_ACTION_TERM.take)}
        </Button>
      )}
      {/* Marking a dose taken OR skipped is one admitted verb. A delegate
          has no day menu (it also holds edit, re-attribution and delete,
          which are the owner's), so skip stands beside take for them. */}
      {showTake && !canManageMedications && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onMark(row, "skipped")}
          disabled={takeBusy || skipBusy}
          aria-busy={skipBusy || undefined}
          className="min-h-9"
          data-slot="ledger-mark-skipped"
        >
          {skipBusy ? (
            <Loader2
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          ) : (
            <SkipForward aria-hidden="true" className="size-4" />
          )}
          {t(DOSE_ACTION_TERM.skip)}
        </Button>
      )}
    </div>
  );
}

/** The take time in its state's tone, the state named for a screen reader. */
function TakenTime({
  state,
  time,
  pinned,
}: {
  state: DoseState;
  time: string;
  pinned: boolean;
}) {
  const { t } = useTranslations();
  const look = DOSE_STATE_LOOK[state];
  const Icon = look.icon;
  return (
    <span
      className="text-foreground inline-flex items-center gap-1.5 text-sm tabular-nums"
      data-slot="ledger-status"
    >
      <Icon aria-hidden="true" className={cn("size-4 shrink-0", look.tone)} />
      <span className="sr-only">{t(DOSE_STATE_TERM[state])}</span>
      {time}
      {pinned && (
        <Link2
          role="img"
          aria-label={t("medications.detail.verlauf.pin.pinnedTag")}
          className="text-muted-foreground size-3.5"
          data-slot="ledger-pinned-badge"
        />
      )}
    </span>
  );
}

/**
 * The day's menu: open the day, then per dose the backfill marks, pin and
 * release, edit, the skipped/taken toggle and delete. The owner's (and a
 * manager's); a write delegate marks today's doses from the cells.
 */
export function LedgerDayMenu({
  dayLabel,
  rows,
  isToday,
  onOpenDay,
  handlers,
}: {
  dayLabel: string;
  rows: LedgerRow[];
  isToday: boolean;
  /** Absent for a day that cannot be opened (a planned future day). */
  onOpenDay?: () => void;
  handlers: LedgerRowHandlers;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { canManageDomain } = useRecordCapabilities();
  if (!canManageDomain("medications")) return null;

  const withItems = rows.filter(
    (row) => isSlotActionable(row) || Boolean(row.intake?.id),
  );
  if (!onOpenDay && withItems.length === 0) return null;

  const rowTime = (row: LedgerRow) =>
    row.timeOfDay
      ? fmt.wallTime(row.timeOfDay)
      : fmt.time(new Date(row.intake?.takenAt ?? row.at));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
          aria-label={t("medications.detail.verlauf.rowActionsLabel", {
            time: dayLabel,
          })}
          data-slot="ledger-row-menu"
        >
          <MoreVertical aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-slot="ledger-row-menu-content">
        {onOpenDay && (
          <DropdownMenuItem
            onClick={() => onOpenDay()}
            data-slot="ledger-open-day"
          >
            <CalendarDays aria-hidden="true" className="mr-2 size-4" />
            {t("day.openDay")}
          </DropdownMenuItem>
        )}
        {withItems.map((row, index) => (
          <DropdownMenuGroup key={`${row.kind}:${row.at}:${index}`}>
            {(index > 0 || onOpenDay) && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-muted-foreground text-xs font-medium tabular-nums">
              {rowTime(row)}
            </DropdownMenuLabel>
            <DoseItems row={row} isToday={isToday} handlers={handlers} />
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DoseItems({
  row,
  isToday,
  handlers,
}: {
  row: LedgerRow;
  isToday: boolean;
  handlers: LedgerRowHandlers;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { onMark, onToggleSkipped, onEdit, onDelete, onPin, onUnpin } =
    handlers;
  const intake = row.intake;
  const actionable = isSlotActionable(row);
  const visibleTake = inPlay(row, isToday);
  const dueContext =
    row.kind === "ad_hoc" && intake?.takenAt && row.nearestSlot
      ? row.nearestSlot
      : null;
  const canPin = Boolean(dueContext && !dueContext.filled && intake?.id);
  const canUnpin = Boolean(row.kind === "slot" && row.pinned && intake?.id);
  const deleted: DeletedIntakeSnapshot | null = intake?.id
    ? {
        id: intake.id,
        takenAt: intake.takenAt,
        skipped: intake.skipped,
        scheduledFor: row.kind === "slot" ? intake.scheduledFor : null,
        slotTime: row.kind === "slot" ? row.timeOfDay : null,
        doseTaken: intake.doseTaken ?? null,
        autoMissed: intake.autoMissed,
      }
    : null;

  return (
    <>
      {actionable && !visibleTake && (
        <DropdownMenuItem
          onClick={() => onMark(row, "taken")}
          data-slot="ledger-menu-taken"
        >
          <Check aria-hidden="true" className="mr-2 size-4" />
          {t(DOSE_ACTION_TERM.take)}
        </DropdownMenuItem>
      )}
      {actionable && (
        <DropdownMenuItem
          onClick={() => onMark(row, "skipped")}
          data-slot="ledger-menu-skipped"
        >
          <SkipForward aria-hidden="true" className="mr-2 size-4" />
          {t(DOSE_ACTION_TERM.skip)}
        </DropdownMenuItem>
      )}
      {canPin && (
        <DropdownMenuItem
          onClick={() => onPin(intake!.id as string, dueContext!.at)}
          data-slot="ledger-pin"
        >
          <Link2 aria-hidden="true" className="mr-2 size-4" />
          {t("medications.detail.verlauf.pin.action", {
            time: fmt.time(new Date(dueContext!.at)),
          })}
        </DropdownMenuItem>
      )}
      {canUnpin && (
        <DropdownMenuItem
          onClick={() => onUnpin(intake!.id as string)}
          data-slot="ledger-unpin"
        >
          <Unlink aria-hidden="true" className="mr-2 size-4" />
          {t("medications.detail.verlauf.pin.release")}
        </DropdownMenuItem>
      )}
      {intake?.id && (
        <DropdownMenuItem
          onClick={() =>
            onEdit({
              id: intake.id as string,
              takenAt: intake.takenAt,
              skipped: intake.skipped,
              scheduledFor: intake.scheduledFor,
            })
          }
          data-slot="ledger-edit"
        >
          <Pencil aria-hidden="true" className="mr-2 size-4" />
          {t("medications.detail.intake.rowActions.edit")}
        </DropdownMenuItem>
      )}
      {intake?.id &&
        (row.status === "skipped" ||
          row.status === "taken_on_time" ||
          row.status === "taken_late") && (
          <DropdownMenuItem
            onClick={() =>
              onToggleSkipped({
                id: intake.id as string,
                skipped: intake.skipped,
                scheduledFor: intake.scheduledFor,
              })
            }
            data-slot="ledger-toggle-skipped"
          >
            {intake.skipped ? (
              <Check aria-hidden="true" className="mr-2 size-4" />
            ) : (
              <SkipForward aria-hidden="true" className="mr-2 size-4" />
            )}
            {intake.skipped
              ? t("medications.detail.verlauf.markAsTaken")
              : t("medications.detail.verlauf.markAsSkipped")}
          </DropdownMenuItem>
        )}
      {deleted && (
        <DropdownMenuItem
          onClick={() => onDelete(deleted)}
          aria-label={intakeDeleteLabel(
            {
              slotAt: deleted.scheduledFor,
              slotTime: deleted.slotTime,
              takenAt: deleted.takenAt,
              skipped: deleted.skipped,
            },
            {
              t,
              formatTime: (at) => fmt.time(at),
              wallTime: fmt.wallTime,
            },
          )}
          data-slot="ledger-delete"
        >
          <Trash2 aria-hidden="true" className="mr-2 size-4" />
          {t("medications.detail.intake.rowActions.delete")}
        </DropdownMenuItem>
      )}
    </>
  );
}
