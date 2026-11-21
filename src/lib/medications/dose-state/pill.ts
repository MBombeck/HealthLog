/**
 * The medication card's take-window pill, read from the server-resolved open
 * dose (`complianceDisplay.currentDose`, see `./resolve.ts`) instead of the
 * card re-deriving windows in the browser with fixed late/missed minutes.
 *
 *   - `due`     -> `in_window`, the pill shows the dose window;
 *   - `overdue` -> `late`, and `very_late` past the midpoint between the end
 *                  of the on-time window and the miss cutoff;
 *   - anything else -> no pill (the card body states missed / taken itself).
 *
 * Client-safe: no server imports. Instants may arrive as ISO strings (JSON).
 */
import { wallClockInTz } from "@/lib/tz/wall-clock";

type Instant = Date | string | null;

export interface ResolvedDoseWire {
  state: string | null;
  dueAt: Instant;
  overdueSince: Instant;
  missedAfter: Instant;
}

export interface DosePill {
  status: "in_window" | "late" | "very_late";
  windowStart: string;
  windowEnd: string;
}

function ms(value: Instant): number | null {
  if (value === null) return null;
  const t = typeof value === "string" ? Date.parse(value) : value.getTime();
  return Number.isFinite(t) ? t : null;
}

function hhmm(t: number, tz: string): string {
  const p = wallClockInTz(new Date(t), tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/**
 * The pill of the resolved open dose, or null for no pill. `undefined` when
 * the dose carries no resolved state (an older payload): the caller keeps
 * its own fallback while the compliance block loads.
 */
export function dosePillFromResolved(
  dose: ResolvedDoseWire | null | undefined,
  now: Date,
  tz: string,
): DosePill | null | undefined {
  if (!dose || dose.state == null) return undefined;
  const dueAt = ms(dose.dueAt);
  const overdueSince = ms(dose.overdueSince);
  const missedAfter = ms(dose.missedAfter);
  if (dueAt === null || overdueSince === null || missedAfter === null) {
    return undefined;
  }
  const window = {
    windowStart: hhmm(dueAt, tz),
    windowEnd: hhmm(overdueSince, tz),
  };
  if (dose.state === "due") return { status: "in_window", ...window };
  if (dose.state === "overdue") {
    const veryLateFrom = overdueSince + (missedAfter - overdueSince) / 2;
    return {
      status: now.getTime() >= veryLateFrom ? "very_late" : "late",
      ...window,
    };
  }
  return null;
}

/**
 * The card's pill props: the server-resolved pill when the open dose carries
 * a resolved state, else the card's own band reading while the compliance
 * block is still loading. A day-scale "taken N days ago" context from that
 * reading keeps priority: it suppresses a take prompt for a dose on board.
 */
export function cardWindowPill(
  dose: ResolvedDoseWire | null | undefined,
  fallback: {
    status: "in_window" | "late" | "very_late" | null;
    window: { start: string; end: string } | null;
    takenEarlyDaysAgo: number | null;
  },
  now: Date,
  tz: string,
): (DosePill & { takenEarlyDaysAgo: number | null }) | null {
  const fromFallback =
    fallback.status && fallback.window
      ? {
          status: fallback.status,
          windowStart: fallback.window.start,
          windowEnd: fallback.window.end,
          takenEarlyDaysAgo: fallback.takenEarlyDaysAgo,
        }
      : null;
  if (fromFallback?.takenEarlyDaysAgo != null) return fromFallback;
  const server = dosePillFromResolved(dose, now, tz);
  if (server === undefined) return fromFallback;
  return server ? { ...server, takenEarlyDaysAgo: null } : null;
}
