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
 * Rolling cadences emit at most one occurrence per interval day, which is
 * farther than any radius here, so the nearest test is skipped for them.
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

export function anchorResolvesOccurrence(input: {
  /** The resolved row's anchor (`scheduledFor`, or the take instant). */
  anchor: Date;
  /** The canonical occurrence instant under test. */
  occurrenceAt: Date;
  /** Reach of this row: the drift radius, or the ad-hoc epsilon. */
  radiusMs: number;
  schedule: CanonicalSchedule;
  ctx: RecurrenceContext;
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
  const neighbours = occurrencesBetween(
    input.schedule,
    new Date(anchor - input.radiusMs),
    new Date(anchor + input.radiusMs),
    input.ctx,
  );
  for (const occurrence of neighbours) {
    const at = occurrence.at.getTime();
    if (at === slot) continue;
    const other = Math.abs(anchor - at);
    if (other < distance || (other === distance && at < slot)) return false;
  }
  return true;
}
