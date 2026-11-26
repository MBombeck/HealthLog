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
 * claim once per process, not on every request. Best effort and never
 * awaited by the request that noticed it.
 */
import type { MfaEnrollment } from "@/lib/auth/mfa-enrollment";
import { getEvent } from "@/lib/logging/context";

/** `notification_events.event_type` of the anchor. */
export const MFA_GRACE_NOTICE_EVENT_TYPE = "MFA_GRACE_NOTICE";

const decided = new Set<string>();

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
  if (decided.has(key)) return;
  decided.add(key);
  const event = getEvent();
  void send(userId, dueAt).catch((err: unknown) => {
    event?.addWarning(
      `mfa grace notice failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function send(userId: string, dueAt: Date): Promise<void> {
  const [{ prisma }, { claimNotificationEvent }, { sendSecurityAlert }] =
    await Promise.all([
      import("@/lib/db"),
      import("@/lib/notifications/reminder-dedup"),
      import("@/lib/auth/security-alert"),
    ]);
  const claimed = await claimNotificationEvent(prisma, {
    recordUserId: userId,
    eventType: MFA_GRACE_NOTICE_EVENT_TYPE,
    dedupKey: `mfa-due:${dueAt.toISOString()}`,
    since: new Date(0),
  });
  if (!claimed) return;
  await sendSecurityAlert(userId, "mfa_due", {}, dueAt);
}
