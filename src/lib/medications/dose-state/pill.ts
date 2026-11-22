/**
 * The medication card's dose, read from the server-resolved open dose
 * (`complianceDisplay.currentDose`, see `./resolve.ts`). The card no longer
 * derives windows in the browser: the server names the slot and its three
 * instants, the card only compares them with the clock so a dose fetched a
 * few minutes ago still turns due, overdue or missed on time.
 *
 *   - `due`     -> pill `in_window`, showing the dose window;
 *   - `overdue` -> pill `late`, and `very_late` past the midpoint between the
 *                  end of the on-time window and the miss cutoff, naming
 *                  the slot's time instead of the closed window;
 *   - anything else -> no pill (the card body states missed / taken itself).
 *
 * While the compliance block is still loading there is no dose and no pill;
 * the card shows the list's next-due line meanwhile.
 *
 * Client-safe: no server imports. Instants may arrive as ISO strings (JSON).
 */
import { wallClockInTz } from "@/lib/tz/wall-clock";

import { openDoseStateAt, type DoseState } from "./resolve";
import { takeReach, type TakeBinding } from "./take-rule";
import { doseStateFromWire } from "./terms";

type Instant = Date | string | null;

/** The take-window tier a card pill shows, null for none. */
export type MedicationWindowStatus = "in_window" | "late" | "very_late" | null;

export interface ResolvedDoseWire {
  state: string | null;
  /** The slot the resolved dose is about (`currentDose.targetAt`). */
  targetAt?: Instant;
  /** With `state: taken`: taken after the on-time window. */
  takenLate?: boolean;
  dueAt: Instant;
  overdueSince: Instant;
  missedAfter: Instant;
}

export interface DosePill {
  status: Exclude<MedicationWindowStatus, null>;
  windowStart: string;
  windowEnd: string;
}

function ms(value: Instant | undefined): number | null {
  if (value == null) return null;
  const t = typeof value === "string" ? Date.parse(value) : value.getTime();
  return Number.isFinite(t) ? t : null;
}

function hhmm(t: number, tz: string): string {
  const p = wallClockInTz(new Date(t), tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

const OPEN = new Set(["upcoming", "due", "overdue"]);

/**
 * The resolved dose's state at `now`, in the resolver's own vocabulary
 * (`DoseState`). A dose that records nothing (`upcoming`, `due`, `overdue`
 * on the wire) moves along its own instants through the resolver's ladder
 * (`openDoseStateAt`), so the card and the server cannot disagree about a
 * boundary; a recorded or missed one keeps the server's state. Null for no
 * dose or an unknown state.
 */
export function liveDoseState(
  dose: ResolvedDoseWire | null | undefined,
  now: Date,
): DoseState | null {
  if (!dose || dose.state == null) return null;
  const resolved = doseStateFromWire(dose.state, dose.takenLate === true);
  if (!OPEN.has(dose.state)) return resolved;
  const dueAt = ms(dose.dueAt);
  const overdueSince = ms(dose.overdueSince);
  const missedAfter = ms(dose.missedAfter);
  if (dueAt === null || overdueSince === null || missedAfter === null) {
    return resolved;
  }
  return openDoseStateAt(
    {
      dueAt: new Date(dueAt),
      overdueSince: new Date(overdueSince),
      missedAfter: new Date(missedAfter),
    },
    now,
  );
}

/** The card's pill for the resolved open dose, or null for no pill. */
export function cardWindowPill(
  dose: ResolvedDoseWire | null | undefined,
  now: Date,
  tz: string,
): DosePill | null {
  const state = liveDoseState(dose, now);
  if (!dose || (state !== "due" && state !== "overdue")) return null;
  const dueAt = ms(dose.dueAt);
  const overdueSince = ms(dose.overdueSince);
  const missedAfter = ms(dose.missedAfter);
  if (dueAt === null || overdueSince === null || missedAfter === null) {
    return null;
  }
  const window = {
    windowStart: hhmm(dueAt, tz),
    windowEnd: hhmm(overdueSince, tz),
  };
  if (state === "due") return { status: "in_window", ...window };
  // Past its window an overdue dose names its own time ("Overdue — 08:00"),
  // not the window that has closed: one time, so a 12 h clock fits the row.
  const slot = ms(dose.targetAt);
  const veryLateFrom = overdueSince + (missedAfter - overdueSince) / 2;
  return {
    status: now.getTime() >= veryLateFrom ? "very_late" : "late",
    ...(slot === null
      ? window
      : { windowStart: hhmm(slot, tz), windowEnd: hhmm(slot, tz) }),
  };
}

/**
 * The slot the card's take and skip buttons record: the resolved dose's slot
 * while it is due, overdue or missed (a late take still counts for it), else
 * the list's next due slot. Null for a medication with neither (as needed):
 * the POST then names no slot and the server files the take.
 */
export function cardDisplayedSlot(
  dose: ResolvedDoseWire | null | undefined,
  nextDueAt: string | null | undefined,
  now: Date,
): Date | null {
  const state = liveDoseState(dose, now);
  const target = ms(dose?.targetAt);
  if (
    target !== null &&
    (state === "due" || state === "overdue" || state === "missed")
  ) {
    return new Date(target);
  }
  const next = ms(nextDueAt ?? null);
  return next === null ? null : new Date(next);
}

/**
 * The slot a take records, when the dose opens if that take is early, and
 * how the take binds to it by the one take rule (`./take-rule`).
 */
export interface TakeSlot {
  at: Date;
  /** When the dose's window opens, while a take now would be early. */
  earlyFrom: Date | null;
  /**
   * `slot` and `pinned` count the take for `at`; `extra` files it as an
   * extra dose, which the control says before the tap.
   */
  binding: TakeBinding;
}

/**
 * The take button's slot: {@link cardDisplayedSlot}, the opening of the dose
 * window while the resolved dose on that slot is still pending (so the button
 * can say the take would be early), and what a take now does for it. A dose
 * already due, overdue or missed counts by its named slot; a pending one is
 * measured by the take rule, so a tap at noon on an evening dose never says
 * "Take (07:00 PM)" and files an extra dose. Null without a slot.
 */
export function cardTakeSlot(
  dose: ResolvedDoseWire | null | undefined,
  nextDueAt: string | null | undefined,
  now: Date,
): TakeSlot | null {
  const at = cardDisplayedSlot(dose, nextDueAt, now);
  if (!at) return null;
  const state = liveDoseState(dose, now);
  const onThisSlot = ms(dose?.targetAt) === at.getTime();
  const dueAt = ms(dose?.dueAt);
  const early = state === "pending" && onThisSlot && dueAt !== null;
  const open =
    onThisSlot &&
    (state === "due" || state === "overdue" || state === "missed");
  return {
    at,
    earlyFrom: early ? new Date(dueAt) : null,
    binding: open ? "slot" : pendingBinding(at, now),
  };
}

/**
 * A take now on a slot that has not opened. The server does not bind a named
 * slot that lies ahead of the take, so within the near ceiling the take is
 * pinned to it (`forceSlotInstant`): it then counts for exactly the slot the
 * button names, and still reads on time when it falls inside the band's
 * early grace. Past the ceiling it is an extra dose.
 */
function pendingBinding(at: Date, now: Date): TakeBinding {
  return takeReach((at.getTime() - now.getTime()) / 60_000) === "extra"
    ? "extra"
    : "pinned";
}
