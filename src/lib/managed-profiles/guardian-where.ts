/**
 * Which `AccountGrant` rows are a managed profile's Guardians. Apart from
 * `lifecycle.ts` so the account-deletion undo, which `lifecycle.ts` itself
 * imports, can read the same rule.
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";

export const activeGuardianWhere = (now: Date) => ({
  access: "MANAGE" as const,
  acceptedAt: { not: null },
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

/**
 * The Guardians the "last Guardian" rule counts: active grants whose holder
 * is not pending deletion. A Guardian pending deletion cannot sign in, acts
 * for nobody, and is erased when the window ends, so counting them let a
 * second Guardian leave on the strength of the first, and left the profile
 * with nobody once both windows ended.
 */
export const remainingGuardianWhere = (now: Date) => ({
  ...activeGuardianWhere(now),
  grantee: ACTIVE_ACCOUNT,
});
