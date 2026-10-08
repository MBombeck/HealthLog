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
): string {
  if (kind === "claimed") {
    switch (access) {
      case "end":
        return "notifications.handover.claimedEnd";
      case "read":
        return "notifications.handover.claimedRead";
      case "manage":
        return "notifications.handover.claimedManage";
    }
  }
  switch (access) {
    case "end":
      return "notifications.handover.changedEnd";
    case "read":
      return "notifications.handover.changedRead";
    case "manage":
      return "notifications.handover.changedManage";
  }
}

export function notifyGuardiansOfHandover(
  kind: "claimed" | "changed",
  recordName: string,
  guardians: { guardianId: string; access: HandoverAccess }[],
): void {
  for (const guardian of guardians) {
    void dispatchLocalisedNotification({
      userId: guardian.guardianId,
      titleKey:
        kind === "claimed"
          ? "notifications.handover.claimedTitle"
          : "notifications.handover.changedTitle",
      messageKey: accessMessageKey(kind, guardian.access),
      params: { name: recordName },
    }).catch((err: unknown) => {
      getEvent()?.addWarning(
        `handover notification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
