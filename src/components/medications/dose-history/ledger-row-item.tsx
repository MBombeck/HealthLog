"use client";

/**
 * The dose history's pieces: one list row per dose, and the sheet a row
 * opens with every action on that dose.
 *
 * A row is the shared `ListItem`: the day (and the dose time when the plan
 * has more than one a day) as its title, the state at the end, and a second
 * line only when what happened differs from the plan: the time it was taken,
 * a dose other than the planned one, a take pinned to its slot. A dose taken
 * on time is a check and nothing else, so the history reads as a record, not
 * as "planned 20:00, taken 20:00" sixty times.
 *
 * A tap opens the dose's sheet: take or skip a dose still open, pin an
 * off-schedule take to its slot or release it, edit, the skipped/taken
 * toggle, open the day, delete. A write delegate gets take and skip (one
 * admitted verb); editing, re-attribution and delete are the owner's. A row
 * with nothing to do opens nothing.
 */

import {
  CalendarDays,
  Check,
  Link2,
  Pencil,
  SkipForward,
  Trash2,
  Unlink,
  type LucideIcon,
} from "lucide-react";

import { ListGroup, ListItem } from "@/components/ui/list-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import {
  DOSE_STATE_LOOK,
  DoseStateLabel,
} from "@/components/medications/dose-state-label";
import type { DeletedIntakeSnapshot } from "@/components/medications/use-medication-intake";
import { intakeDeleteLabel } from "@/components/medications/intake-dose-label";
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

/** One dose as the list shows it, with what its sheet needs. */
export interface LedgerDose {
  row: LedgerRow;
  /** "Fri, 27 Nov" or "Fri, 27 Nov, 08:00". */
  title: string;
  /** Absent for a day that cannot be opened (a planned future day). */
  onOpenDay?: () => void;
}

export type LedgerDoseActionKind =
  "take" | "skip" | "pin" | "unpin" | "edit" | "toggle" | "openDay" | "delete";

/**
 * What the dose's sheet offers, in its order. Pure, so the capability split
 * is tested without a sheet: `write` may mark a dose taken or skipped,
 * `manage` may change and delete what is recorded.
 */
export function doseActionsOf(
  row: LedgerRow,
  can: { write: boolean; manage: boolean },
  openDay: boolean,
): LedgerDoseActionKind[] {
  const intake = row.intake;
  const actions: LedgerDoseActionKind[] = [];
  if (isSlotActionable(row) && (can.write || can.manage)) {
    actions.push("take", "skip");
  }
  if (!can.manage) return actions;
  if (
    row.kind === "ad_hoc" &&
    intake?.id &&
    intake.takenAt &&
    row.nearestSlot &&
    !row.nearestSlot.filled
  ) {
    actions.push("pin");
  }
  if (row.kind === "slot" && row.pinned && intake?.id) actions.push("unpin");
  if (intake?.id) actions.push("edit");
  if (
    intake?.id &&
    (row.status === "skipped" ||
      row.status === "taken_on_time" ||
      row.status === "taken_late")
  ) {
    actions.push("toggle");
  }
  if (openDay) actions.push("openDay");
  if (intake?.id) actions.push("delete");
  return actions;
}

/**
 * The row's second line: only what differs from the plan. The time a slot
 * was taken when it is not the planned time, the dose when it is not the
 * planned one, and that a take is pinned to its slot.
 */
function useDeviation(row: LedgerRow): string | null {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const intake = row.intake;
  const parts: string[] = [];
  if (intake?.takenAt && !intake.skipped) {
    const taken = fmt.time(new Date(intake.takenAt));
    const planned =
      row.kind === "slot" && row.timeOfDay ? fmt.wallTime(row.timeOfDay) : null;
    if (taken !== planned) {
      parts.push(t("medications.detail.verlauf.takenAt", { time: taken }));
    }
  }
  if (intake?.doseTaken) {
    parts.push(
      t("medications.detail.verlauf.doseTaken", { dose: intake.doseTaken }),
    );
  }
  if (row.kind === "slot" && row.pinned) {
    parts.push(t("medications.detail.verlauf.pin.pinnedTag"));
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/** One dose in its group. */
export function LedgerDoseRow({
  dose,
  onOpen,
}: {
  dose: LedgerDose;
  /** Absent when the dose's sheet would offer nothing. */
  onOpen?: () => void;
}) {
  const { t } = useTranslations();
  const { row } = dose;
  const state = doseStateOfHistoryRow(row);
  const meta = useDeviation(row);
  // On time is the rule: a check, its word for a screen reader only. Every
  // other state is the exception and says its word.
  const onTime =
    state === "taken" ||
    (row.kind === "ad_hoc" && Boolean(row.intake?.takenAt));
  const takenLook = DOSE_STATE_LOOK.taken;
  const trailing = onTime ? (
    <span className="inline-flex items-center" data-slot="ledger-status">
      <takenLook.icon
        aria-hidden="true"
        className={cn("size-4", takenLook.tone)}
      />
      <span className="sr-only">{t(DOSE_STATE_TERM.taken)}</span>
    </span>
  ) : state ? (
    <DoseStateLabel state={state} className="text-sm" slot="ledger-status" />
  ) : null;
  return (
    <ListItem
      data-slot="ledger-row"
      data-status={row.status}
      data-kind={row.kind}
      title={<span className="tabular-nums">{dose.title}</span>}
      meta={meta ?? undefined}
      trailing={trailing ?? undefined}
      onSelect={onOpen}
      actionLabel={
        onOpen
          ? t("medications.detail.verlauf.rowActionsLabel", {
              time: dose.title,
            })
          : undefined
      }
    />
  );
}

interface DoseAction {
  label: string;
  slot: string;
  icon: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
  actionLabel?: string;
}

/**
 * The dose's actions as rows. Exported for the delegated-affordance suite:
 * the capability gating is the interesting part.
 */
export function LedgerDoseActions({
  dose,
  handlers,
  marking,
  onDone,
}: {
  dose: LedgerDose;
  handlers: LedgerRowHandlers;
  marking: string | null;
  /** Close the sheet once an action ran. */
  onDone: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { canWriteDomain, canManageDomain } = useRecordCapabilities();
  const { row } = dose;
  const intake = row.intake;
  const kinds = doseActionsOf(
    row,
    {
      write: canWriteDomain("medications"),
      manage: canManageDomain("medications"),
    },
    Boolean(dose.onOpenDay),
  );
  if (kinds.length === 0) return null;
  const busy = marking !== null && marking.startsWith(`${row.at}:`);

  const run = (fn: () => void) => () => {
    fn();
    onDone();
  };
  const ownIntake = intake?.id ? { ...intake, id: intake.id } : null;

  const actionOf = (kind: LedgerDoseActionKind): DoseAction | null => {
    if (kind === "take") {
      return {
        label: t(DOSE_ACTION_TERM.take),
        slot: "ledger-mark-taken",
        icon: Check,
        onSelect: run(() => handlers.onMark(row, "taken")),
      };
    }
    if (kind === "skip") {
      return {
        label: t(DOSE_ACTION_TERM.skip),
        slot: "ledger-mark-skipped",
        icon: SkipForward,
        onSelect: run(() => handlers.onMark(row, "skipped")),
      };
    }
    if (kind === "openDay") {
      return {
        label: t("day.openDay"),
        slot: "ledger-open-day",
        icon: CalendarDays,
        onSelect: run(() => dose.onOpenDay?.()),
      };
    }
    if (!ownIntake) return null;
    if (kind === "pin" && row.nearestSlot) {
      const slotAt = row.nearestSlot.at;
      return {
        label: t("medications.detail.verlauf.pin.action", {
          time: fmt.time(new Date(slotAt)),
        }),
        slot: "ledger-pin",
        icon: Link2,
        onSelect: run(() => handlers.onPin(ownIntake.id, slotAt)),
      };
    }
    if (kind === "unpin") {
      return {
        label: t("medications.detail.verlauf.pin.release"),
        slot: "ledger-unpin",
        icon: Unlink,
        onSelect: run(() => handlers.onUnpin(ownIntake.id)),
      };
    }
    if (kind === "edit") {
      return {
        label: t("medications.detail.intake.rowActions.edit"),
        slot: "ledger-edit",
        icon: Pencil,
        onSelect: run(() =>
          handlers.onEdit({
            id: ownIntake.id,
            takenAt: ownIntake.takenAt,
            skipped: ownIntake.skipped,
            scheduledFor: ownIntake.scheduledFor,
          }),
        ),
      };
    }
    if (kind === "toggle") {
      return {
        label: ownIntake.skipped
          ? t("medications.detail.verlauf.markAsTaken")
          : t("medications.detail.verlauf.markAsSkipped"),
        slot: "ledger-toggle-skipped",
        icon: ownIntake.skipped ? Check : SkipForward,
        onSelect: run(() =>
          handlers.onToggleSkipped({
            id: ownIntake.id,
            skipped: ownIntake.skipped,
            scheduledFor: ownIntake.scheduledFor,
          }),
        ),
      };
    }
    if (kind === "delete") {
      const deleted: DeletedIntakeSnapshot = {
        id: ownIntake.id,
        takenAt: ownIntake.takenAt,
        skipped: ownIntake.skipped,
        scheduledFor: row.kind === "slot" ? ownIntake.scheduledFor : null,
        slotTime: row.kind === "slot" ? row.timeOfDay : null,
        doseTaken: ownIntake.doseTaken ?? null,
        autoMissed: ownIntake.autoMissed,
      };
      return {
        label: t("medications.detail.intake.rowActions.delete"),
        slot: "ledger-delete",
        icon: Trash2,
        destructive: true,
        actionLabel: intakeDeleteLabel(
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
        ),
        onSelect: run(() => handlers.onDelete(deleted)),
      };
    }
    return null;
  };

  return (
    <ListGroup data-slot="ledger-dose-actions" aria-busy={busy || undefined}>
      {kinds.map((kind) => {
        const action = actionOf(kind);
        if (!action) return null;
        const Icon = action.icon;
        return (
          <ListItem
            key={kind}
            data-slot={action.slot}
            icon={
              <span
                className={cn(
                  "bg-muted flex size-8 items-center justify-center rounded-lg",
                  action.destructive && "text-destructive",
                )}
              >
                <Icon className="size-4" aria-hidden />
              </span>
            }
            title={
              <span className={cn(action.destructive && "text-destructive")}>
                {action.label}
              </span>
            }
            actionLabel={action.actionLabel}
            onSelect={busy ? undefined : action.onSelect}
            chevron={false}
          />
        );
      })}
    </ListGroup>
  );
}

/** The sheet a dose row opens. */
export function LedgerDoseSheet({
  dose,
  onClose,
  handlers,
  marking,
}: {
  dose: LedgerDose | null;
  onClose: () => void;
  handlers: LedgerRowHandlers;
  marking: string | null;
}) {
  return (
    <ResponsiveSheet
      open={dose !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={dose?.title ?? ""}
      contentWidth="md"
    >
      {dose ? (
        <div data-slot="ledger-dose-sheet">
          <LedgerDoseActions
            dose={dose}
            handlers={handlers}
            marking={marking}
            onDone={onClose}
          />
        </div>
      ) : null}
    </ResponsiveSheet>
  );
}
