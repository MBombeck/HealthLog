/**
 * What a treatment series is, read off its sessions.
 *
 * Pure, and the one place it is decided. Nothing about progress is stored on
 * the series: done, booked and remaining sessions, the first and the last one,
 * the next one and the status are derived from the visits that point at it on
 * every read, so filing, moving or cancelling a visit corrects the series with
 * it. A client renders these values; it never recomputes them.
 */

export const TREATMENT_SERIES_STATUSES = [
  "PLANNED",
  "ACTIVE",
  "COMPLETED",
  "EXPIRED",
] as const;

export type TreatmentSeriesStatus = (typeof TREATMENT_SERIES_STATUSES)[number];

/** The facts about one session the derivation needs. */
export interface SeriesSessionFact {
  id: string;
  occurredAt: Date;
  status: "PLANNED" | "DONE" | "CANCELLED" | "NO_SHOW";
}

export interface SeriesSessionSummary {
  /** Sessions that took place. */
  done: number;
  /** Booked sessions still ahead. */
  booked: number;
  /** Cancelled or missed. Kept apart: neither used up a session. */
  cancelled: number;
  firstSessionAt: Date | null;
  lastSessionAt: Date | null;
  nextSessionAt: Date | null;
}

export function summarizeSessions(
  sessions: readonly SeriesSessionFact[],
  now: Date,
): SeriesSessionSummary {
  let done = 0;
  let booked = 0;
  let cancelled = 0;
  let first: Date | null = null;
  let last: Date | null = null;
  let next: Date | null = null;
  for (const s of sessions) {
    if (s.status === "DONE") {
      done += 1;
      if (!first || s.occurredAt < first) first = s.occurredAt;
      if (!last || s.occurredAt > last) last = s.occurredAt;
    } else if (s.status === "PLANNED") {
      if (s.occurredAt.getTime() > now.getTime()) {
        booked += 1;
        if (!next || s.occurredAt < next) next = s.occurredAt;
      }
    } else {
      cancelled += 1;
    }
  }
  return {
    done,
    booked,
    cancelled,
    firstSessionAt: first,
    lastSessionAt: last,
    nextSessionAt: next,
  };
}

/**
 * The status, first match wins:
 *
 *  - COMPLETED once the person ended it (on or before today), or once every
 *    planned session took place;
 *  - EXPIRED when its last valid day has passed with sessions left, the way a
 *    prescription runs out;
 *  - PLANNED while no session has taken place yet;
 *  - ACTIVE otherwise.
 *
 * `today` is the record owner's calendar day (`YYYY-MM-DD`), so a series does
 * not expire at the server's midnight.
 */
export function deriveSeriesStatus(
  series: {
    plannedSessions: number | null;
    validUntil: string | null;
    endedOn: string | null;
  },
  done: number,
  today: string,
): TreatmentSeriesStatus {
  if (series.endedOn !== null && series.endedOn <= today) return "COMPLETED";
  if (series.plannedSessions !== null && done >= series.plannedSessions) {
    return "COMPLETED";
  }
  if (series.validUntil !== null && series.validUntil < today) return "EXPIRED";
  if (done === 0) return "PLANNED";
  return "ACTIVE";
}

/**
 * Each session's place in its series, 1-based, in time order.
 *
 * Only sessions that took place or are booked count: a cancelled or missed
 * appointment used up nothing, so "session 3 of 6" stays true after one was
 * called off. Ties on the instant fall back to the id, so the numbering is
 * stable across reads.
 */
export function sessionNumbers(
  sessions: readonly SeriesSessionFact[],
): Map<string, number> {
  const counted = sessions
    .filter((s) => s.status === "DONE" || s.status === "PLANNED")
    .sort(
      (a, b) =>
        a.occurredAt.getTime() - b.occurredAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return new Map(counted.map((s, index) => [s.id, index + 1]));
}
