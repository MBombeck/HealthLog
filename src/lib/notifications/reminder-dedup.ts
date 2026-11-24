/**
 * Reminder dedup anchor — "this slot already went out today".
 *
 * The medication-reminder tick runs every 15 minutes and re-derives the
 * same overdue slot on every pass, so it needs a durable record of what it
 * already sent. That record used to be the Telegram message ledger, which
 * only exists when a Telegram send succeeded: a user on email, APNs or
 * ntfy had no row, so the tick re-sent the same overdue notice on every
 * pass for the rest of the local day.
 *
 * The anchor now lives in `notification_events`, a record-scoped event ledger
 * rather than a channel delivery record. Three properties matter and all are
 * deliberate:
 *
 *  - **Written per dispatched slot, not per successful send.** Anchoring
 *    on a delivered push would re-open the flood the moment a channel
 *    starts failing, which is the original defect wearing a new key.
 *  - **Written before the dispatch.** A crash mid-dispatch burns the slot
 *    for that phase rather than risking a repeat; the next phase still
 *    escalates, and the next local day starts clean.
 *  - **Claimed atomically.** A transaction-scoped advisory lock serializes
 *    same-key workers through the window check and append, while provider
 *    egress remains outside that short transaction.
 *
 */
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * How far back the anchor lookup reads. The key already carries the local
 * date, so anything older than this cannot match; the bound exists to keep
 * the read on the record/event/key index. Two days covers every timezone
 * offset plus a DST shift.
 */
export const REMINDER_DEDUP_LOOKBACK_MS = 48 * 60 * 60 * 1000;

/**
 * Event type for state-scoped admin configuration notices ("offline geo is
 * not configured" and its future siblings). These anchors are not windowed:
 * they hold for as long as the configuration state itself holds — days or
 * years — and are released explicitly when the state exits, so the notice
 * can fire again on re-entry and never in between. The retention prune in
 * `cleanup-handlers.ts` excludes this event type for exactly that reason; a
 * horizon delete would re-open the once-per-state notice every 90 days
 * (issue #851 wearing a new clock).
 */
export const CONFIG_NOTICE_EVENT_TYPE = "ADMIN_CONFIG_NOTICE";

/**
 * Dedup key for one medication dose slot in one phase on one local day.
 *
 * `scheduleId` and the slot's real `HH:mm` are BOTH in the key. Dropping
 * either one silently merges slots that must stay separate: two legacy
 * single-window schedules on the same medication share the empty
 * first-class time-of-day, and two schedules can name the same time with
 * different doses. Over-suppression is the failure mode this whole change
 * risks introducing, so the key stays at least as fine as the ledger it
 * replaces.
 */
export function medicationReminderDedupKey(input: {
  medicationId: string;
  scheduleId: string;
  slotTime: string;
  phase: string;
  localDate: string;
}): string {
  return [
    "med",
    input.medicationId,
    input.scheduleId,
    input.slotTime,
    input.phase,
    input.localDate,
  ].join(":");
}

/**
 * Atomically claim a record-scoped notification event within one rolling
 * window. A `true` result is the sole permission to continue to provider
 * egress; `false` means another worker already claimed it or the database
 * could not establish the claim. The advisory lock, lookup, and append stay
 * inside the short transaction. Callers always perform delivery afterward.
 */
export async function claimNotificationEvent(
  prisma: PrismaClient,
  input: {
    recordUserId: string;
    eventType: string;
    dedupKey: string;
    since: Date;
    /**
     * The instant the claim is recorded at; the database's clock when
     * omitted. A pass that judges against an injected `now` passes it, so
     * its `since` and the claim read the same clock.
     */
    at?: Date;
  },
): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      const lockKey = [
        "notification-event",
        input.recordUserId,
        input.eventType,
        input.dedupKey,
      ].join(":");
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
      `;

      const existing = await tx.notificationEvent.findFirst({
        where: {
          recordUserId: input.recordUserId,
          eventType: input.eventType,
          dedupKey: input.dedupKey,
          createdAt: { gte: input.since },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (existing) return false;

      await tx.notificationEvent.create({
        data: {
          recordUserId: input.recordUserId,
          eventType: input.eventType,
          dedupKey: input.dedupKey,
          ...(input.at ? { createdAt: input.at } : {}),
        },
      });
      return true;
    });
  } catch {
    // Fail closed: a worker that cannot durably claim the event must not
    // contact a provider. A later tick may retry after the transaction rolls
    // back, so an outage delays rather than duplicates a notification.
    return false;
  }
}

/**
 * Release every claim on one event across all record users. The counterpart
 * to `claimNotificationEvent` for state-scoped anchors: when the condition a
 * notice describes stops holding, its anchors are deleted so the next entry
 * into the condition sends a fresh notice. Deliberately not scoped to a
 * single `recordUserId` — the state is host-wide, so its exit releases the
 * anchor for every admin at once.
 *
 * Never throws. A failed release leaves the anchors standing, which
 * suppresses a future notice rather than duplicating one — the safe side of
 * this particular trade, and the next state exit retries it.
 */
export async function releaseNotificationEvent(
  prisma: PrismaClient,
  input: {
    eventType: string;
    dedupKey: string;
  },
): Promise<void> {
  try {
    await prisma.notificationEvent.deleteMany({
      where: {
        eventType: input.eventType,
        dedupKey: input.dedupKey,
      },
    });
  } catch {
    // Swallowed by design; see above.
  }
}
