/**
 * v1.18.4 — server-authoritative count of a user's still-outstanding doses
 * for the current local day. Drives the PWA app badge (`navigator.setAppBadge`)
 * so the installed icon mirrors how many doses still need logging — the
 * free-tier equivalent of the iOS widget's pending count.
 *
 * Outstanding = a today-scheduled `MedicationIntakeEvent` that is neither
 * taken (`takenAt == null`) nor skipped (`skipped == false`) nor swept by the
 * miss cutoff (`autoMissed == false`). Pending rows are minted by
 * `projectTodayIntakesAndRecompute`; this is a read-only count over the same
 * window, so callers that have just projected today's rows get an accurate
 * total.
 */
import { prisma } from "@/lib/db";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";

/**
 * Count the user's outstanding (pending) doses for today in their timezone.
 * Best-effort: any failure returns 0 so a badge update never blocks a caller.
 */
export async function countOutstandingDosesToday(
  userId: string,
  tz: string,
): Promise<number> {
  try {
    const { start, end } = getUserTodayBounds(new Date(), tz);
    return await prisma.medicationIntakeEvent.count({
      where: {
        userId,
        scheduledFor: { gte: start, lte: end },
        takenAt: null,
        skipped: false,
        autoMissed: false,
        // A tombstoned placeholder is gone for every read surface; it must
        // not keep a badge count alive.
        deletedAt: null,
        // v1.39.1 (#1033) — nothing of a medication with intake tracking
        // off is outstanding.
        ...TRACKED_INTAKE_EVENT_WHERE,
      },
    });
  } catch {
    return 0;
  }
}
