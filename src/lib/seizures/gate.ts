/**
 * Seizure-diary feature gate (#1368).
 *
 * The diary is an optional module, off by default (`optIn`), resolved through
 * the module foundation like every other: the per-record opt-in AND the
 * operator's server-wide availability. Every `/api/seizures/*` route gates
 * through `requireSeizuresEnabled` so the refusal is one stable envelope.
 */
import { apiError } from "@/lib/api-response";
import { isModuleEnabled, requireModuleEnabled } from "@/lib/modules/gate";

/** Wire `errorCode` a client branches on. */
export const SEIZURES_DISABLED_ERROR_CODE = "seizures.disabled";

export function isSeizuresEnabled(userId: string): Promise<boolean> {
  return isModuleEnabled(userId, "seizures");
}

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
