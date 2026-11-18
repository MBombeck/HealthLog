/**
 * Seizure-diary feature gate (#1368).
 *
 * The diary is an optional module, off by default (`optIn`), resolved through
 * the module foundation like every other: the per-record opt-in AND the
 * operator's server-wide availability. Every `/api/seizures/*` route gates
 * through `requireSeizuresEnabled` so the refusal is one stable envelope.
 */
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { requireModuleEnabled } from "@/lib/modules/gate";

/** Wire `errorCode` a client branches on. */
export const SEIZURES_DISABLED_ERROR_CODE = "seizures.disabled";

export type SeizuresGateResult =
  { enabled: true } | { enabled: false; response: Response };

/** 403 `seizures.disabled` while the record has the diary off. */
export async function requireSeizuresEnabled(
  userId: string,
): Promise<SeizuresGateResult> {
  const gate = await requireModuleEnabled(userId, "seizures");
  if (gate.enabled) return { enabled: true };
  return {
    enabled: false,
    response: apiError("Seizure diary is not enabled", 403, {
      errorCode: SEIZURES_DISABLED_ERROR_CODE,
      module: "seizures",
    }),
  };
}

/**
 * Whether the caller may reach the record's medications section: a rescue
 * dose that names a medication writes, or undoes, an intake on it, and a
 * type's rescue medication names it. The owner always may; a delegate only
 * when the grant covers `medications`, the section the medication's own
 * intake routes require. Fail closed on a grant that vanished.
 */
export async function seizureMedicationsReachable(
  grantId: string | null,
): Promise<boolean> {
  const visible = await actingDomainVisibility(prisma, grantId);
  return visible("medications");
}

/** 403 for a rescue-dose write the grant's sections do not reach. */
export function seizureMedicationsNotPermitted(): Response {
  return apiError(
    "Recording a rescue dose on a medication needs access to medications",
    403,
    { errorCode: "sharing.not_permitted" },
  );
}
