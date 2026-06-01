/**
 * v1.8.2 — canonical slot-snap for intake writes.
 *
 * Closes the duplicate-intake-row bug: a twice-daily med ends up with a
 * pending REMINDER row AND a separate taken WEB/API row for the same
 * dose slot because the unique key carries `source` and the two
 * `scheduledFor` instants can drift by a minute between iOS and the
 * server's `localHmAsUtc`. The intake write paths use this helper to
 * snap an incoming write to the SAME canonical slot instant the
 * projector + reminder worker mint with, so the write resolves to one
 * row per slot regardless of `source` or sub-minute drift.
 *
 * Given a medication's schedules, the user's IANA timezone, and an
 * incoming instant (the write's `scheduledFor`, or `takenAt` as a
 * fallback), `resolveCanonicalSlotInstant` returns the canonical slot
 * instant for that dose — byte-identical to the projector's
 * `localHmAsUtc(day, userTz, h, m)` row — or `null` when the dose does
 * not map to a scheduled slot (PRN / as-needed / off-slot beyond
 * tolerance / cyclic off-week). A `null` result is the caller's signal
 * to keep the unmodified insert behaviour.
 *
 * Pure / synchronous: no DB access. The caller `select`s the schedule
 * columns the canonical engine consumes and threads `lastIntakeAt` in.
 */
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
  type WorkerMedicationRow,
  type WorkerScheduleRow,
} from "@/lib/medications/scheduling/worker-helpers";
import {
  occurrencesBetween,
  type CanonicalSchedule,
  type RecurrenceContext,
} from "@/lib/medications/scheduling/recurrence";
import { getLocalDateParts, localHmAsUtc } from "@/lib/timezone";

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/**
 * Default snap tolerance when a schedule has no usable window span. ±2h
 * is wide enough to absorb the iOS-vs-server `localHmAsUtc` minute drift
 * plus a reasonable "I took it a bit late" margin, while staying narrow
 * enough that a clearly off-slot manual log (e.g. a 13:00 entry against a
 * 07:00 / 19:00 schedule) is treated as unscheduled and keeps its own
 * row rather than colliding into the nearest slot.
 */
const DEFAULT_TOLERANCE_MS = 2 * ONE_HOUR_MS;

/**
 * The minimal medication projection the slot resolver needs. Matches the
 * worker/projector `select` shape — `oneShot`, the schedule rows, plus
 * the recurrence-context anchors.
 */
export interface SlotResolverMedication extends WorkerMedicationRow {
  schedules: WorkerScheduleRow[];
}

export interface ResolveSlotInput {
  medication: SlotResolverMedication;
  userTz: string;
  /**
   * The write's incoming `scheduledFor`, or `takenAt` as a fallback when
   * the client omitted `scheduledFor`. The day-in-tz of this instant
   * determines which calendar day's slots are enumerated.
   */
  incoming: Date;
  /**
   * Latest non-tombstoned `takenAt` for the medication. Only consulted by
   * rolling schedules; pass `null` when unknown / not loaded.
   */
  lastIntakeAt?: Date | null;
}

/**
 * Snap `incoming` to the nearest canonical scheduled-slot instant for the
 * dose's calendar day (in `userTz`), or return `null` when no slot lands
 * within tolerance (treat as unscheduled / PRN — keep insert behaviour).
 *
 * The returned instant is produced by `localHmAsUtc(day, userTz, h, m)` —
 * the exact function the projector (`project-today-intakes.ts`) and the
 * reminder worker mint pending rows with — so an existing pending row for
 * the slot dedupes on the canonical instant.
 */
export function resolveCanonicalSlotInstant(
  input: ResolveSlotInput,
): Date | null {
  const { medication, userTz, incoming } = input;
  const schedules = medication.schedules ?? [];
  if (schedules.length === 0) return null;

  const ctx: RecurrenceContext = buildRecurrenceContext({
    medication,
    userTz,
    lastIntakeAt: input.lastIntakeAt ?? null,
  });

  // The day in userTz implied by the incoming instant. Enumerate that
  // day's slots over a window padded by a day on each side so a
  // time-of-day near the local-midnight boundary (and any DST shift) is
  // still captured — the projector + worker apply the time-of-day to the
  // local day, which can land just outside a naive same-UTC-day window.
  const parts = getLocalDateParts(incoming, userTz);
  const localDayMidnightUtc = localHmAsUtc(incoming, userTz, 0, 0);
  const windowStart = new Date(localDayMidnightUtc.getTime() - ONE_DAY_MS);
  const windowEnd = new Date(localDayMidnightUtc.getTime() + 2 * ONE_DAY_MS);

  let best: { at: Date; toleranceMs: number; deltaMs: number } | null = null;

  for (const scheduleRow of schedules) {
    const canonical: CanonicalSchedule = buildCanonicalSchedule(scheduleRow);
    const occurrences = occurrencesBetween(
      canonical,
      windowStart,
      windowEnd,
      ctx,
    );
    const tolerance = snapToleranceMs(canonical);

    for (const occ of occurrences) {
      // Only consider slots that land on the SAME local calendar day as
      // the incoming instant — a slot on the padded neighbouring day must
      // not capture a write meant for a different day.
      const occParts = getLocalDateParts(occ.at, userTz);
      if (
        occParts.year !== parts.year ||
        occParts.month !== parts.month ||
        occParts.day !== parts.day
      ) {
        continue;
      }

      // v1.8.2 DST-robustness — re-mint the snapped instant via
      // `localHmAsUtc` from the occurrence's local day + time-of-day rather
      // than passing `occ.at` through. The recurrence engine derives
      // `occ.at` from `wallClockInTz`, while the projector
      // (`project-today-intakes.ts`) and the reminder worker mint their
      // pending rows with `localHmAsUtc(day, tz, h, m)`. The two agree on
      // ordinary days but can diverge by an hour inside a DST gap /
      // ambiguity window. The intake write must collapse onto the row the
      // projector/worker actually minted, so use `localHmAsUtc` for the
      // final instant — byte-identical to those mints by construction —
      // and keep the canonical engine only for DECIDING which slots exist
      // (PRN / cyclic / rrule / rolling gating).
      const slotInstant = canonicalSlotInstant(occ.at, occ.timeOfDay, userTz);
      const deltaMs = Math.abs(slotInstant.getTime() - incoming.getTime());
      if (deltaMs > tolerance) continue;
      if (best === null || deltaMs < best.deltaMs) {
        best = { at: slotInstant, toleranceMs: tolerance, deltaMs };
      }
    }
  }

  return best ? best.at : null;
}

/**
 * Re-mint an occurrence's instant via `localHmAsUtc` so it is
 * byte-identical to the projector / reminder-worker mint. Falls back to
 * the engine's `occ.at` when the occurrence's `timeOfDay` is not a
 * parseable `HH:mm` (defensive — the engine always sets it, but a
 * malformed value must never crash the write path).
 */
function canonicalSlotInstant(
  occAt: Date,
  timeOfDay: string,
  userTz: string,
): Date {
  const minutes = hhmmToMinutes(timeOfDay);
  if (minutes === null) return occAt;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  // `localHmAsUtc` keys off the LOCAL calendar day of its first argument;
  // `occ.at` is the engine's instant for this slot, so its local day is
  // the day the slot belongs to (even across the local-midnight boundary).
  return localHmAsUtc(occAt, userTz, h, m);
}

/**
 * Tolerance = ± half the schedule's window span (so two adjacent slots
 * never overlap their capture zones), falling back to ±2h when the
 * window is degenerate (`windowStart === windowEnd`) or unparseable.
 */
function snapToleranceMs(schedule: CanonicalSchedule): number {
  const startMin = hhmmToMinutes(schedule.windowStart);
  const endMin = hhmmToMinutes(schedule.windowEnd);
  if (startMin === null || endMin === null) return DEFAULT_TOLERANCE_MS;
  let span = endMin - startMin;
  if (span < 0) span += 24 * 60; // overnight window
  if (span === 0) return DEFAULT_TOLERANCE_MS;
  const halfSpanMs = (span / 2) * ONE_MINUTE_MS;
  // Never go below the minute-drift floor: even a tight 30-minute window
  // must absorb the iOS-vs-server sub-minute `scheduledFor` drift.
  return Math.max(halfSpanMs, ONE_MINUTE_MS);
}

function hhmmToMinutes(hhmm: string): number | null {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}
