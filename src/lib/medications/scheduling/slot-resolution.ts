/**
 * Which occurrence a resolved intake row (taken / deliberately skipped /
 * cron-auto-missed) stands for.
 *
 * The intake write paths snap a slot-anchored row's `scheduledFor` to the
 * engine's canonical occurrence instant, so row and occurrence normally meet
 * exactly. The tolerance beyond an exact match exists for a row whose anchor
 * drifted off the canonical instant: a row written before the snap, or an
 * instant that moved under it through a DST or schedule-time shift. From
 * v1.15.10 that tolerance was a flat ±6 h radius, sized for the twice-daily
 * 12 h gap. On any cadence whose neighbouring slots are closer than twelve
 * hours (19:49 + 23:59, 08:00 + 12:00, every four hours) the radius reached
 * the sibling: the first dose's row resolved the second occurrence too, the
 * next-due walk jumped to tomorrow, the card offered tomorrow's slot, and the
 * second dose could never be logged from the card.
 *
 * Rule: a row resolves exactly ONE occurrence, the one nearest to its anchor,
 * and only when that occurrence lies within the row's radius. An exact match
 * short-circuits; a drifted row is measured against every occurrence the
 * schedule emits within the radius around the anchor, and resolves the slot
 * under test only when no other occurrence is nearer (an exact tie goes to
 * the earlier occurrence). So the effective reach is `min(radius, half the
 * gap to the neighbouring occurrence)`, and a sibling can never be swallowed.
 * The neighbours are every schedule's occurrences, not only the schedule
 * under test: a medication composed of sibling schedules (08:00 daily plus
 * 12:00 daily) is one cadence to the person taking it. Rolling cadences emit
 * at most one occurrence per interval day, which is farther than any radius
 * here, so the nearest test is skipped for them.
 */
import {
  occurrencesBetween,
  type CanonicalSchedule,
  type RecurrenceContext,
} from "@/lib/medications/scheduling/recurrence";

/**
 * Drift a slot-anchored row may sit from a slot's canonical instant and
 * still count as resolving it, provided the slot is the row's nearest
 * occurrence.
 */
export const RESOLVE_RADIUS_MS = 6 * 60 * 60 * 1000;

/**
 * v1.16.9 — exact-match slop for an AD-HOC row. An ad-hoc take anchors
 * `scheduledFor = takenAt` on its own instant, so it can only resolve a
 * slot it actually sits on (sub-minute drift absorbed); letting it use
 * the drift radius hid genuinely-due slots — a 14:30 ad-hoc take resolved
 * tonight's 20:00 dose while the ledger still counted that slot missed.
 */
export const ADHOC_RESOLVE_EPSILON_MS = 60 * 1000;

/**
 * Nearest occurrence to `anchor` within `radiusMs`, across EVERY schedule
 * of the medication: `at` and its distance, or null when no schedule emits
 * inside the window. On an exact tie the earlier occurrence wins. Memoised
 * per anchor in `cache` when one is passed, because the set depends on the
 * row alone and a predicate asks about many slots per row.
 */
function nearestOccurrenceWithin(input: {
  anchor: number;
  radiusMs: number;
  schedules: CanonicalSchedule[];
  ctx: RecurrenceContext;
  cache?: NearestOccurrenceCache;
}): { at: number; distance: number } | null {
  const key = `${input.anchor}:${input.radiusMs}`;
  const cached = input.cache?.get(key);
  if (cached !== undefined) return cached;
  let nearest: { at: number; distance: number } | null = null;
  const from = new Date(input.anchor - input.radiusMs);
  const to = new Date(input.anchor + input.radiusMs);
  for (const schedule of input.schedules) {
    for (const occurrence of occurrencesBetween(
      schedule,
      from,
      to,
      input.ctx,
    )) {
      const at = occurrence.at.getTime();
      const distance = Math.abs(input.anchor - at);
      if (
        nearest === null ||
        distance < nearest.distance ||
        (distance === nearest.distance && at < nearest.at)
      ) {
        nearest = { at, distance };
      }
    }
  }
  input.cache?.set(key, nearest);
  return nearest;
}

export type NearestOccurrenceCache = Map<
  string,
  { at: number; distance: number } | null
>;

export function anchorResolvesOccurrence(input: {
  /** The resolved row's anchor (`scheduledFor`, or the take instant). */
  anchor: Date;
  /** The canonical occurrence instant under test. */
  occurrenceAt: Date;
  /** Reach of this row: the drift radius, or the ad-hoc epsilon. */
  radiusMs: number;
  /** The schedule that emitted `occurrenceAt`. */
  schedule: CanonicalSchedule;
  /**
   * Every schedule of the medication. The nearest test enumerates all of
   * them: production rows carry no schedule identity, so a row on sibling
   * A's 08:00 is also asked about sibling B's 12:00, and B's own
   * occurrences alone would never show that A's 08:00 is nearer.
   */
  schedules: CanonicalSchedule[];
  ctx: RecurrenceContext;
  /** Optional per-predicate memo for the nearest-occurrence enumeration. */
  cache?: NearestOccurrenceCache;
}): boolean {
  const anchor = input.anchor.getTime();
  const slot = input.occurrenceAt.getTime();
  const distance = Math.abs(anchor - slot);
  if (distance === 0) return true;
  if (distance > input.radiusMs) return false;
  if (input.schedule.rollingIntervalDays !== null) return true;

  // Drifted: the row stands for its nearest occurrence only. Any occurrence
  // strictly nearer than the slot under test, or equally near but earlier,
  // claims the row instead.
  const nearest = nearestOccurrenceWithin({
    anchor,
    radiusMs: input.radiusMs,
    schedules: input.schedules,
    ctx: input.ctx,
    cache: input.cache,
  });
  if (nearest === null || nearest.at === slot) return true;
  return !(
    nearest.distance < distance ||
    (nearest.distance === distance && nearest.at < slot)
  );
}
