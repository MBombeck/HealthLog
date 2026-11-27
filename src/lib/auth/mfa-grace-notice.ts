/**
 * The one notice an account gets when a second-factor policy starts its
 * grace period: a SECURITY_ALERT (`mfa_due`) with the date, sent through the
 * dispatcher to every channel of the account, its iPhones included.
 *
 * The web shows a banner for the whole grace period; the shipped iPhone
 * builds read nothing of it, and a sign-in token stays usable past the date
 * in 1.50. Without this notice a person who only uses the app learns of the
 * policy when a new sign-in is refused.
 *
 * Once per account and due date: the durable anchor is a
 * `notification_events` claim keyed on the date, so a restart sends nothing
 * again, and a policy switched off and on again (a new date) sends anew. The
 * process remembers what it already decided, so a covered account pays the
 * claim once per process, not on every request. A send whose channels all
 * failed gives the claim back and is tried again after an hour. Best effort
 * and never awaited by the request that noticed it.
 */
import type { MfaEnrollment } from "@/lib/auth/mfa-enrollment";
import { getEvent } from "@/lib/logging/context";

/** `notification_events.event_type` of the anchor. */
export const MFA_GRACE_NOTICE_EVENT_TYPE = "MFA_GRACE_NOTICE";

/** How long a failed notice waits before a request tries it again. */
export const MFA_GRACE_NOTICE_RETRY_MS = 60 * 60 * 1000;

/** Per account and date: until when this process leaves it alone. */
const decided = new Map<string, number>();

/** Test hook: forget what this process already decided. */
export function __resetMfaGraceNoticeForTests(): void {
  decided.clear();
}

/**
 * Send the grace notice for this account once, when its state is `grace`.
 * Returns at once; the claim and the send run in the background.
 */
export function noticeMfaGrace(
  userId: string,
  enrollment: MfaEnrollment,
): void {
  if (enrollment.state !== "grace" || !enrollment.dueAt) return;
  const dueAt = enrollment.dueAt;
  const key = `${userId}:${dueAt.toISOString()}`;
  if ((decided.get(key) ?? 0) > Date.now()) return;
  decided.set(key, Infinity);
  const event = getEvent();
  const retryLater = () =>
    decided.set(key, Date.now() + MFA_GRACE_NOTICE_RETRY_MS);
  void send(userId, dueAt).then(
    (settled) => {
      if (!settled) retryLater();
    },
    (err: unknown) => {
      retryLater();
      event?.addWarning(
        `mfa grace notice failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  );
}

/** True once the notice is settled: sent, unwanted, or another process's. */
async function send(userId: string, dueAt: Date): Promise<boolean> {
  const [{ prisma }, { claimNotificationEvent }, { sendSecurityAlert }] =
    await Promise.all([
      import("@/lib/db"),
      import("@/lib/notifications/reminder-dedup"),
      import("@/lib/auth/security-alert"),
    ]);
  const claim = {
    recordUserId: userId,
    eventType: MFA_GRACE_NOTICE_EVENT_TYPE,
    dedupKey: `mfa-due:${dueAt.toISOString()}`,
  };
  const claimed = await claimNotificationEvent(prisma, {
    ...claim,
    since: new Date(0),
  });
  if (!claimed) return true;
  let sent = false;
  try {
    sent = await sendSecurityAlert(userId, "mfa_due", {}, dueAt);
  } finally {
    // Scoped to this account: every account shares the date's key.
    if (!sent) await prisma.notificationEvent.deleteMany({ where: claim });
  }
  return sent;
}
