/**
 * The words for a dose, one set for every surface.
 *
 * A dose is in one of seven states (`./resolve.ts`) and a person can do four
 * things to it. Each has exactly one message key here, and every surface
 * names a state or an action through this table: the medication card and
 * table, the detail page, the dose history, the forms, the toasts, Telegram.
 * Before this the same dose read "Take now" on the card, "upcoming" in the
 * history and "Due soon" in Telegram, and the buttons were labelled with the
 * participles the history used as states ("Taken" / "Skipped").
 *
 * Actions are verbs (take, skip, snooze, undo); states are participles or
 * adjectives (pending, due, overdue, taken, taken late, skipped, missed).
 *
 * Client-safe: no server imports.
 */
import type { DoseState, WireDoseState } from "./resolve";

export const DOSE_STATE_TERM: Record<DoseState, string> = {
  pending: "medications.dose.state.pending",
  due: "medications.dose.state.due",
  overdue: "medications.dose.state.overdue",
  missed: "medications.dose.state.missed",
  taken: "medications.dose.state.taken",
  taken_late: "medications.dose.state.takenLate",
  skipped: "medications.dose.state.skipped",
};

export const DOSE_ACTION_TERM = {
  take: "medications.dose.action.take",
  skip: "medications.dose.action.skip",
  snooze: "medications.dose.action.snooze",
  undo: "medications.dose.action.undo",
} as const;

/**
 * A wire state (`upcoming|due|overdue|taken|skipped|missed` plus `takenLate`)
 * back in the resolver's vocabulary. Null for an unknown or absent state.
 */
export function doseStateFromWire(
  state: WireDoseState | string | null | undefined,
  takenLate = false,
): DoseState | null {
  switch (state) {
    case "upcoming":
      return "pending";
    case "taken":
      return takenLate ? "taken_late" : "taken";
    case "due":
    case "overdue":
    case "missed":
    case "skipped":
      return state;
    default:
      return null;
  }
}

/**
 * The state a dose-history row shows. A slot row still open ("upcoming" in
 * the ledger's own accounting) takes the resolved state the server sends with
 * it (pending, due or overdue); an off-schedule take has no state of its own.
 */
export function doseStateOfHistoryRow(row: {
  status:
    | "taken_on_time"
    | "taken_late"
    | "skipped"
    | "missed"
    | "upcoming"
    | "ad_hoc";
  state?: WireDoseState | null;
  takenLate?: boolean;
}): DoseState | null {
  switch (row.status) {
    case "taken_on_time":
      return "taken";
    case "taken_late":
      return "taken_late";
    case "skipped":
    case "missed":
      return row.status;
    case "upcoming": {
      const resolved = doseStateFromWire(row.state, row.takenLate);
      return resolved === "due" || resolved === "overdue"
        ? resolved
        : "pending";
    }
    default:
      return null;
  }
}

/** Whether a dose in this state still waits for a take or a skip. */
export function isOpenDoseState(state: DoseState | null): boolean {
  return state === "pending" || state === "due" || state === "overdue";
}
