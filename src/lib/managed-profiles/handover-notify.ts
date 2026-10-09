/**
 * v1.42 (#959) — telling each former Guardian what a handover did to their
 * access.
 *
 * Addressed to the Guardian's OWN account and channels. The managed-record
 * fan-out (`delivery-identity.ts`) is closed to this event on purpose, and it
 * no longer applies anyway: the record stopped being managed in the claim.
 *
 * Fire-and-forget after the commit. A notification that cannot be delivered
 * must never undo a handover that already happened, and nothing here waits on
 * a provider.
 */
import { getEvent } from "@/lib/logging/context";
import type { HandoverAccess } from "@/lib/managed-profiles/handover-access";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";

/** The sentence for an access level, as literal keys the i18n guards can see. */
function accessMessageKey(
  kind: "claimed" | "changed",
  access: HandoverAccess,
  named: boolean,
): string {
  if (kind === "claimed") {
    switch (access) {
      case "end":
        return named
          ? "notifications.handover.claimedEnd"
          : "notifications.handover.unnamed.claimedEnd";
      case "read":
        return named
          ? "notifications.handover.claimedRead"
          : "notifications.handover.unnamed.claimedRead";
      case "manage":
        return named
          ? "notifications.handover.claimedManage"
          : "notifications.handover.unnamed.claimedManage";
    }
  }
  switch (access) {
    case "end":
      return named
        ? "notifications.handover.changedEnd"
        : "notifications.handover.unnamed.changedEnd";
    case "read":
      return named
        ? "notifications.handover.changedRead"
        : "notifications.handover.unnamed.changedRead";
    case "manage":
      return named
        ? "notifications.handover.changedManage"
        : "notifications.handover.unnamed.changedManage";
  }
}

function titleKey(kind: "claimed" | "changed", named: boolean): string {
  if (kind === "claimed") {
    return named
      ? "notifications.handover.claimedTitle"
      : "notifications.handover.unnamed.claimedTitle";
  }
  return named
    ? "notifications.handover.changedTitle"
    : "notifications.handover.unnamed.changedTitle";
}

/**
 * `recordName` is the display name the Guardians knew the record by, or null.
 * Never the login name: the new owner chose it to sign in with, and a
 * notification to somebody else is no place for it. Without a display name
 * the sentences speak of "the person you looked after".
 */
export function notifyGuardiansOfHandover(
  kind: "claimed" | "changed",
  recordName: string | null,
  guardians: { guardianId: string; access: HandoverAccess }[],
): void {
  const name = recordName?.trim() || null;
  for (const guardian of guardians) {
    void dispatchLocalisedNotification({
      userId: guardian.guardianId,
      titleKey: titleKey(kind, name !== null),
      messageKey: accessMessageKey(kind, guardian.access, name !== null),
      ...(name ? { params: { name } } : {}),
    }).catch((err: unknown) => {
      getEvent()?.addWarning(
        `handover notification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
