/**
 * v1.43 (#959) — the callback's half of claiming a managed profile through
 * single sign-on: the identity provider has authenticated somebody, the
 * sealed claim cookie names the link and the chosen username, and this binds
 * the one to the other.
 *
 * The refusals, in order, each one before anything about any account changes:
 *
 *   1. `claim_expired` — the link is no longer usable (used, withdrawn,
 *      replaced, expired, its creator gone, the profile no longer managed).
 *   2. `claim_sso_subject_bound` — the provider's `(issuer, sub)` already
 *      signs in to an account here. One subject, one account: binding it a
 *      second time would make the sign-in ambiguous, and re-pointing it would
 *      hand the existing account's sign-in to the claimed profile.
 *   3. `claim_email_taken` — the provider vouches (`email_verified: true`) for
 *      an address another account holds. An unverified address is not used at
 *      all: the account is created without one rather than with a claim
 *      nobody checked.
 *   4. `claim_username_taken` — the username chosen at the start was taken in
 *      the ten minutes since.
 *
 * Then `claimManagedProfile` — the password claim's own transaction, under
 * the managed-profile lock, with every link check repeated — sets the
 * username, the address, no password and the subject; applies each Guardian's
 * proposed access; resets disclaimer, onboarding and AI consent. A race lost
 * at the unique indexes is re-read and answered as the refusal it turned out
 * to be. The session is minted only after that commit.
 */
import { auditLog } from "@/lib/auth/audit";
import { recordSignInDevice } from "@/lib/auth/login-alert";
import { createSession } from "@/lib/auth/session";
import {
  findUserIdByEmail,
  findUserIdByUsername,
} from "@/lib/auth/identity-lookup";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  claimManagedProfile,
  HandoverError,
  isHandoverUsable,
} from "@/lib/managed-profiles/handover";
import { notifyGuardiansOfHandover } from "@/lib/managed-profiles/handover-notify";

export type SsoClaimRefusal =
  | "claim_expired"
  | "claim_sso_subject_bound"
  | "claim_email_taken"
  | "claim_username_taken";

export type SsoClaimOutcome =
  { ok: true; profileId: string } | { ok: false; reason: SsoClaimRefusal };

/** Where the new owner lands: the decision about each former Guardian. */
export const SSO_CLAIM_LANDING = "/onboarding/handover";

interface SsoClaimInput {
  handoverId: string;
  username: string;
  issuer: string;
  sub: string;
  email: string | null;
  emailVerified: boolean | undefined;
  ipAddress: string;
  userAgent: string | null;
}

/** Which of the three unique values is held by an account already. */
async function collision(input: {
  issuer: string;
  sub: string;
  email: string | null;
  username: string;
}): Promise<SsoClaimRefusal | null> {
  const bound = await prisma.user.findFirst({
    where: { oidcIssuer: input.issuer, oidcSub: input.sub },
    select: { id: true },
  });
  if (bound) {
    // Under the account that holds the subject, so its owner's history shows
    // that somebody tried to bind their sign-in to a second record.
    await auditLog("auth.oidc.claim_conflict", {
      userId: bound.id,
      actorUserId: null,
    });
    return "claim_sso_subject_bound";
  }
  if (input.email) {
    if ((await findUserIdByEmail(input.email)) !== null) {
      return "claim_email_taken";
    }
  }
  // Case-blind like the unique key it answers for (migration 0517).
  return (await findUserIdByUsername(input.username)) !== null
    ? "claim_username_taken"
    : null;
}

export async function completeSsoClaim(
  input: SsoClaimInput,
): Promise<SsoClaimOutcome> {
  const refuse = (reason: SsoClaimRefusal): SsoClaimOutcome => {
    annotate({
      action: { name: "profile_claim.sso.refused" },
      meta: { reason },
    });
    return { ok: false, reason };
  };

  if (!(await isHandoverUsable(input.handoverId))) {
    return refuse("claim_expired");
  }

  const email =
    input.email && input.emailVerified === true
      ? input.email.toLowerCase()
      : null;
  const identity = {
    issuer: input.issuer,
    sub: input.sub,
    email,
    username: input.username,
  };

  const early = await collision(identity);
  if (early) return refuse(early);

  let claimed;
  try {
    claimed = await claimManagedProfile({
      link: { handoverId: input.handoverId },
      username: input.username,
      email,
      passwordHash: null,
      oidc: { issuer: input.issuer, sub: input.sub },
      ipAddress: input.ipAddress,
    });
  } catch (error) {
    if (error instanceof HandoverError) {
      if (error.code === "taken") {
        // Lost a race at a unique index: say which one.
        return refuse((await collision(identity)) ?? "claim_username_taken");
      }
      return refuse("claim_expired");
    }
    throw error;
  }

  // The new owner starts with onboarding owed, as after the password claim.
  // The fifth argument stays null: single sign-on is a delegated factor and
  // must never satisfy a step-up (the OIDC login's rule).
  await createSession(
    claimed.profileId,
    true,
    input.ipAddress,
    input.userAgent,
    null,
  );
  void recordSignInDevice({
    userId: claimed.profileId,
    ip: input.ipAddress,
    userAgent: input.userAgent,
    alertOnNew: false,
  });
  await auditLog("auth.claim", {
    userId: claimed.profileId,
    actorUserId: null,
    ipAddress: input.ipAddress,
    details: { method: "sso" },
  });

  notifyGuardiansOfHandover("claimed", claimed.displayName, claimed.guardians);

  annotate({
    action: { name: "profile_claim.complete" },
    meta: { guardians: claimed.guardians.length, method: "sso" },
  });
  return { ok: true, profileId: claimed.profileId };
}
