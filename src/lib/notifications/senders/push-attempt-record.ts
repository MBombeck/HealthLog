import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";

/**
 * v1.4.49 — fire-and-forget push-attempt ledger write.
 *
 * Every sender (APNS, WEB_PUSH, TELEGRAM, NTFY) calls this helper
 * once per dispatch so the admin diagnostic endpoint
 * (`/api/admin/notifications/diagnostic`) can surface the trailing
 * 20 attempts per user without DB shell access.
 *
 * Contract:
 *   * NEVER throws. A DB hiccup on the insert must not break the
 *     actual push delivery, so we swallow the error and emit a
 *     wide-event warning the operator can correlate with the
 *     primary sender's outcome.
 *   * Single insert per call. No retry, no batching — a missing row
 *     is a strictly worse outcome than a duplicate one, but we
 *     accept it rather than amplify a DB blip into a retry storm.
 *   * Synchronous return is `void`. Callers must use
 *     `void recordPushAttempt(...)` so the sender's hot path doesn't
 *     await the ledger write. The pg connection pool is shared with
 *     the dispatcher's read queries; awaiting here would block the
 *     next channel in the cascade for no operational benefit.
 *
 * Result discriminator:
 *   * `"ok"`       — the sender returned a successful `SendOutcome`.
 *   * `"error"`    — the sender returned `ok: false` with a
 *                    classified failure (hard or soft reject).
 *   * `"skipped"`  — soft "no recipient" / "config missing" cases
 *                    the sender contracts surface without contacting
 *                    the upstream provider.
 */
export interface PushAttemptRecord {
  userId: string;
  channel: "APNS" | "WEB_PUSH" | "TELEGRAM" | "NTFY";
  eventType: string;
  result: "ok" | "error" | "skipped";
  reason?: string | null;
}

export function recordPushAttempt(record: PushAttemptRecord): void {
  // The `void` here is the doubly-explicit form: we want neither the
  // caller nor a linter to wait on this promise. The `.catch` traps
  // a rejected promise without surfacing it to the caller.
  void prisma.pushAttempt
    .create({
      data: {
        userId: record.userId,
        channel: record.channel,
        eventType: record.eventType,
        result: record.result,
        reason: record.reason ?? null,
      },
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "unknown_error";
      getEvent()?.addWarning(
        `push_attempt_ledger_write_failed channel=${record.channel} reason=${message}`,
      );
    });
}
