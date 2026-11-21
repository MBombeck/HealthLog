/**
 * The state of one scheduled dose, resolved once on the server.
 *
 * Every surface that says whether a dose is open, due, late, done or missed
 * reads it from here: the today list (and through it the iOS card, widget,
 * Live Activity and reminders), the medication card's current dose, the
 * Telegram reminder, the MCP schedule tool and the Coach snapshot. The input
 * is a slot of the dose ledger (`./ledger.ts`), which carries the slot's band
 * from the shared band minter, so the windows are the ones the dose history,
 * the compliance rate and the reminder worker use, including a medication's
 * own stored dose windows. Nothing here knows a fixed number of minutes.
 *
 * States, in the order a dose moves through them:
 *
 *   - `pending`    the dose window has not opened (`now < dueAt`);
 *   - `due`        inside the on-time window (`dueAt <= now <= overdueSince`);
 *   - `overdue`    past the on-time window, before the miss cutoff
 *                  (`overdueSince < now <= missedAfter`); a take now counts
 *                  for this dose, late;
 *   - `missed`     past the miss cutoff with nothing recorded, or closed by
 *                  the auto-miss pass. A take recorded for THIS dose (the
 *                  history's "taken", or a take within six hours that the
 *                  server binds to it) still counts, as `taken_late`;
 *                  `lateTakeCounts` says so, and every surface that shows
 *                  "missed" with a take action must say it too;
 *   - `taken`      taken inside the on-time window or its early grace;
 *   - `taken_late` taken after the on-time window;
 *   - `skipped`    deliberately skipped (left out of the adherence rate).
 *
 * Pure: no clock, no database.
 */
import type { SlotBand } from "@/lib/medications/scheduling/attribution";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";

export const DOSE_STATES = [
  "pending",
  "due",
  "overdue",
  "missed",
  "taken",
  "taken_late",
  "skipped",
] as const;

export type DoseState = (typeof DOSE_STATES)[number];

export type DoseTakenVia =
  | "WEB"
  | "APP"
  | "INTEGRATION"
  | "TELEGRAM"
  | "APPLE_HEALTH"
  | "IMPORT"
  | "AUTO";

export interface ResolvedDose {
  state: DoseState;
  /** The slot's anchor: the scheduled time of the dose. */
  slotInstant: Date;
  /** The dose window opens (the on-time window's start). */
  dueAt: Date;
  /** Past this the dose is overdue (the on-time window's end). */
  overdueSince: Date;
  /** Past this an unanswered dose is missed (the band's miss cutoff). */
  missedAfter: Date;
  /** When the dose was taken, or null. */
  takenAt: Date | null;
  /** Where the take came from, when known. */
  takenVia: DoseTakenVia | null;
  /**
   * A take recorded for this dose now still counts for it (as
   * `taken_late` after the on-time window): true while `due`, `overdue`
   * and `missed`.
   */
  lateTakeCounts: boolean;
}

/** What the ledger knows of the row on a slot. */
export interface SlotOutcome {
  takenAt: Date | null;
  skipped: boolean;
  autoMissed?: boolean;
  takenVia?: DoseTakenVia | null;
}

/** Resolve one dose from its band, what is recorded on it, and the time. */
export function resolveDoseState(
  band: Pick<
    SlotBand,
    "at" | "onTimeStart" | "onTimeEnd" | "overdueEnd" | "earlyStart"
  >,
  outcome: SlotOutcome | null,
  now: Date,
): ResolvedDose {
  const base = {
    slotInstant: band.at,
    dueAt: band.onTimeStart,
    overdueSince: band.onTimeEnd,
    missedAfter: band.overdueEnd,
    takenAt: outcome?.skipped ? null : (outcome?.takenAt ?? null),
    takenVia: outcome?.takenAt ? (outcome.takenVia ?? null) : null,
  };
  if (outcome?.skipped) {
    return { ...base, state: "skipped", lateTakeCounts: false };
  }
  if (outcome?.takenAt) {
    const late = outcome.takenAt.getTime() > band.onTimeEnd.getTime();
    return {
      ...base,
      state: late ? "taken_late" : "taken",
      lateTakeCounts: false,
    };
  }
  const t = now.getTime();
  const state: DoseState =
    outcome?.autoMissed || t > band.overdueEnd.getTime()
      ? "missed"
      : t < band.onTimeStart.getTime()
        ? "pending"
        : t <= band.onTimeEnd.getTime()
          ? "due"
          : "overdue";
  return { ...base, state, lateTakeCounts: state !== "pending" };
}

/**
 * The resolved state of a ledger slot row. Null for an ad-hoc row or a slot
 * row without its band (a caller that did not read it from the ledger).
 * A take the ledger attributed to the slot by band carries the ledger's own
 * on-time verdict, which honours the early grace and a pinned take.
 */
export function resolveLedgerSlot(
  row: DoseHistoryRow,
  now: Date,
  takenVia: DoseTakenVia | null = null,
): ResolvedDose | null {
  if (row.kind !== "slot" || !row.band) return null;
  const intake = row.intake;
  const resolved = resolveDoseState(
    row.band,
    intake
      ? {
          takenAt: intake.takenAt,
          skipped: intake.skipped,
          autoMissed: intake.autoMissed,
          takenVia,
        }
      : null,
    now,
  );
  if (row.status === "taken_on_time") return { ...resolved, state: "taken" };
  if (row.status === "taken_late") return { ...resolved, state: "taken_late" };
  return resolved;
}

/**
 * The pre-resolver wire value of `complianceDisplay.currentDose.status`,
 * kept for the clients that read it.
 */
export function legacyDoseStatus(
  state: DoseState,
):
  | "upcoming"
  | "on_time_window"
  | "overdue"
  | "missed"
  | "taken_on_time"
  | "taken_late"
  | "skipped" {
  switch (state) {
    case "pending":
      return "upcoming";
    case "due":
      return "on_time_window";
    case "taken":
      return "taken_on_time";
    default:
      return state;
  }
}

/** ISO form of a resolved dose for the wire. */
export function serializeResolvedDose(dose: ResolvedDose) {
  return {
    state: dose.state,
    slotInstant: dose.slotInstant.toISOString(),
    dueAt: dose.dueAt.toISOString(),
    overdueSince: dose.overdueSince.toISOString(),
    missedAfter: dose.missedAfter.toISOString(),
    takenAt: dose.takenAt?.toISOString() ?? null,
    takenVia: dose.takenVia,
    lateTakeCounts: dose.lateTakeCounts,
  };
}

/** The dose-state vocabulary on the wire (today rows, currentDose, MCP). */
export const WIRE_DOSE_STATES = [
  "upcoming",
  "due",
  "overdue",
  "taken",
  "skipped",
  "missed",
] as const;

export type WireDoseState = (typeof WIRE_DOSE_STATES)[number];

/**
 * A resolved dose in the published vocabulary: `pending` reads `upcoming`,
 * and a late take reads `taken` with `takenLate: true`.
 */
export function wireDoseState(state: DoseState): {
  state: WireDoseState;
  takenLate: boolean;
} {
  if (state === "pending") return { state: "upcoming", takenLate: false };
  if (state === "taken_late") return { state: "taken", takenLate: true };
  return { state, takenLate: false };
}
