/**
 * v1.15.18 WE — pure helpers behind the Verlauf (dose-history) tab.
 *
 * The Verlauf tab renders the server-minted ledger
 * (`GET /api/medications/[id]/dose-history`) and lets the user flip a slot
 * Genommen / Übersprungen with INSTANT feedback. The instant feel comes from
 * an optimistic local rebuild: on a tap the cached `rows` array is mutated
 * synchronously and the headline compliance % is recomputed from those same
 * rows in the SAME paint — only then does the server write fire and the
 * authoritative refetch reconcile. The engines that mint the ledger are pure,
 * so the client can mirror their status accounting without re-running the band
 * minter it does not hold.
 *
 * Everything here is pure / synchronous / instant-free of React so it is unit-
 * testable without a render (the repo convention — no `renderHook`).
 */

import type { DoseHistoryStatus } from "@/lib/medications/scheduling/dose-history";

/** The serialised row shape the `dose-history` endpoint returns. */
export interface LedgerRow {
  kind: "slot" | "ad_hoc";
  /** Slot anchor (slot rows) or the ad-hoc take's own time, ISO. */
  at: string;
  /** The slot's "HH:mm" label, or null for an ad-hoc row. */
  timeOfDay: string | null;
  status: DoseHistoryStatus;
  /** v1.15.20 — slot served by a deliberate user pin ("zugeordnet"). */
  pinned?: boolean;
  /** v1.15.20 — due-context for an ad-hoc take: the nearest slot it could
   * belong to. `filled: false` unlocks the "Slot zuordnen" kebab action. */
  nearestSlot?: { at: string; timeOfDay: string; filled: boolean };
  intake: {
    id: string | null;
    scheduledFor: string;
    takenAt: string | null;
    skipped: boolean;
    autoMissed: boolean;
    /** v1.16.4 — per-intake dose override; null/absent = configured dose. */
    doseTaken?: string | null;
  } | null;
}

/**
 * v1.15.20 — human-compact signed offset between an ad-hoc take and the slot
 * it would have been due at ("+45 min", "-2 h", "+1 h 20 min"). Unit
 * abbreviations are locale-neutral (min / h); the sign reads "taken after
 * (+) / before (−) the slot". Sub-minute deltas collapse to "±0 min".
 */
export function formatSlotDelta(takenAtIso: string, slotAtIso: string): string {
  const deltaMs =
    new Date(takenAtIso).getTime() - new Date(slotAtIso).getTime();
  const sign = deltaMs < 0 ? "-" : "+";
  const totalMinutes = Math.round(Math.abs(deltaMs) / 60_000);
  if (totalMinutes < 60) return `${sign}${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0
    ? `${sign}${hours} h`
    : `${sign}${hours} h ${minutes} min`;
}

/** The full `data` envelope the endpoint returns. */
export interface LedgerPayload {
  from: string;
  to: string;
  family: "daily" | "weekly" | "one_shot" | "none";
  hasExpectedSlots: boolean;
  rows: LedgerRow[];
}

/**
 * Headline compliance derived from the ledger — the SAME accounting the
 * server-side unification uses (audit CRITICAL-2): taken = on-time + late;
 * denominator = taken + missed; skipped + ad-hoc + upcoming are excluded.
 * Surfacing one rate from the ledger the user is looking at means the history
 * view and the percentage can never contradict.
 */
export interface LedgerCompliance {
  /** Whole-percent adherence (0–100), capped. `null` when nothing counts yet. */
  rate: number | null;
  takenOnTime: number;
  takenLate: number;
  missed: number;
  /** taken + missed — the doses that count toward the rate. */
  denominator: number;
}

/**
 * Compute the headline adherence from the ledger rows. Ad-hoc rows, skips,
 * and still-takeable upcoming slots never enter the denominator, so a forward-
 * looking window does not depress the rate.
 */
export function complianceFromLedger(rows: LedgerRow[]): LedgerCompliance {
  let takenOnTime = 0;
  let takenLate = 0;
  let missed = 0;
  for (const row of rows) {
    if (row.status === "taken_on_time") takenOnTime += 1;
    else if (row.status === "taken_late") takenLate += 1;
    else if (row.status === "missed") missed += 1;
  }
  const taken = takenOnTime + takenLate;
  const denominator = taken + missed;
  const rate =
    denominator > 0
      ? Math.min(100, Math.round((taken / denominator) * 100))
      : null;
  return { rate, takenOnTime, takenLate, missed, denominator };
}

/** A day-grouped view of the ledger, most-recent day first. */
export interface LedgerDayGroup {
  /** `YYYY-MM-DD` in the user's locale day, for the heading + key. */
  dayKey: string;
  /** Rows for that day, chronological (morning first). */
  rows: LedgerRow[];
}

/**
 * Group rows by their local calendar day (most-recent day first; rows inside a
 * day stay chronological so the morning slot leads). The day key is derived in
 * the user's timezone via `Intl` so a 23:30 dose does not bleed into the next
 * UTC day.
 */
export function groupLedgerByDay(
  rows: LedgerRow[],
  timeZone: string,
): LedgerDayGroup[] {
  const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const byDay = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const dayKey = dayKeyFmt.format(new Date(row.at));
    const bucket = byDay.get(dayKey);
    if (bucket) bucket.push(row);
    else byDay.set(dayKey, [row]);
  }
  const groups: LedgerDayGroup[] = Array.from(byDay.entries()).map(
    ([dayKey, dayRows]) => ({
      dayKey,
      rows: dayRows
        .slice()
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()),
    }),
  );
  // Most-recent day first; chronological within the day above.
  groups.sort((a, b) =>
    a.dayKey < b.dayKey ? 1 : a.dayKey > b.dayKey ? -1 : 0,
  );
  return groups;
}

/**
 * Whether a slot row exposes a Genommen / Übersprungen quick action. A slot is
 * actionable when it has no confirmed intake yet (`upcoming` / `missed`) — the
 * user is filling in a pending or forgotten dose. A row that already carries a
 * take / skip is edited via the row's Bearbeiten dialog, not the quick toggle.
 */
export function isSlotActionable(row: LedgerRow): boolean {
  return (
    row.kind === "slot" &&
    (row.status === "upcoming" || row.status === "missed")
  );
}

/**
 * Optimistically apply a Genommen / Übersprungen tap to the cached payload so
 * the row status + the headline % flip before the server round-trip. The
 * matched slot (by `at`) gets a synthetic intake and the matching status; an
 * already-claimed or non-slot row is returned untouched. The server write +
 * the authoritative refetch reconcile afterwards, so any divergence (e.g. the
 * take landing late rather than on-time) self-heals on the next read.
 *
 * The optimistic take is recorded now, the time it is reported: a dose
 * marked taken on a slot that already reads missed paints late, never on
 * time, and the server's resolved state replaces it on the refetch.
 */
export function applyOptimisticSlotMark(
  payload: LedgerPayload,
  slotAt: string,
  action: "taken" | "skipped",
  nowIso: string = new Date().toISOString(),
): LedgerPayload {
  const rows = payload.rows.map((row) => {
    if (row.kind !== "slot" || row.at !== slotAt) return row;
    if (!isSlotActionable(row)) return row;
    const status: DoseHistoryStatus =
      action === "skipped"
        ? "skipped"
        : row.status === "missed"
          ? "taken_late"
          : "taken_on_time";
    return {
      ...row,
      status,
      intake: {
        // Optimistic placeholder id; replaced by the server row on refetch.
        id: row.intake?.id ?? null,
        scheduledFor: row.at,
        takenAt: action === "taken" ? nowIso : null,
        skipped: action === "skipped",
        autoMissed: false,
      },
    };
  });
  return { ...payload, rows };
}

/**
 * Request body for marking a ledger slot from the Verlauf. The taken arm
 * names the slot and records the take at the time it is reported (no
 * `takenAt`, so the server stamps now). Stamping the slot's own instant
 * filed a missed dose marked days later as taken on time, which flattered
 * the adherence rate; a take reported late reads late. A dose taken at a
 * known earlier time is entered with that time through "Add intake".
 */
export function slotMarkRequestBody(
  row: Pick<LedgerRow, "at">,
  action: "taken" | "skipped",
): Record<string, unknown> {
  return action === "skipped"
    ? { skipped: true, scheduledFor: row.at }
    : { skipped: false, scheduledFor: row.at };
}
