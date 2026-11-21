/**
 * The medication card's dose, read from the server-resolved open dose
 * (`complianceDisplay.currentDose`, see `./resolve.ts`). The card no longer
 * derives windows in the browser: the server names the slot and its three
 * instants, the card only compares them with the clock so a dose fetched a
 * few minutes ago still turns due, overdue or missed on time.
 *
 *   - `due`     -> pill `in_window`, showing the dose window;
 *   - `overdue` -> pill `late`, and `very_late` past the midpoint between the
 *                  end of the on-time window and the miss cutoff;
 *   - anything else -> no pill (the card body states missed / taken itself).
 *
 * While the compliance block is still loading there is no dose and no pill;
 * the card shows the list's next-due line meanwhile.
 *
 * Client-safe: no server imports. Instants may arrive as ISO strings (JSON).
 */
import type { DoseStatus } from "@/lib/analytics/compliance/dose-status";
import { wallClockInTz } from "@/lib/tz/wall-clock";

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
 * The resolved state at `now`. A dose that records nothing (`upcoming`,
 * `due`, `overdue`) moves along its own instants; a recorded or missed one
 * keeps the server's state.
 */
export function liveDoseState(
  dose: ResolvedDoseWire | null | undefined,
  now: Date,
): string | null {
  if (!dose || dose.state == null) return null;
  if (!OPEN.has(dose.state)) return dose.state;
  const dueAt = ms(dose.dueAt);
  const overdueSince = ms(dose.overdueSince);
  const missedAfter = ms(dose.missedAfter);
  if (dueAt === null || overdueSince === null || missedAfter === null) {
    return dose.state;
  }
  const t = now.getTime();
  if (t < dueAt) return "upcoming";
  if (t <= overdueSince) return "due";
  if (t <= missedAfter) return "overdue";
  return "missed";
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
  const veryLateFrom = overdueSince + (missedAfter - overdueSince) / 2;
  return {
    status: now.getTime() >= veryLateFrom ? "very_late" : "late",
    ...window,
  };
}

/**
 * The resolved dose in the older `currentDose.status` vocabulary the card
 * body's escalation reads, at `now`. `upcoming` while nothing is resolved.
 */
export function cardDoseStatus(
  dose: ResolvedDoseWire | null | undefined,
  now: Date,
): DoseStatus {
  switch (liveDoseState(dose, now)) {
    case "due":
      return "on_time_window";
    case "overdue":
      return "overdue";
    case "missed":
      return "missed";
    case "skipped":
      return "skipped";
    case "taken":
      return dose?.takenLate ? "taken_late" : "taken_on_time";
    default:
      return "upcoming";
  }
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
