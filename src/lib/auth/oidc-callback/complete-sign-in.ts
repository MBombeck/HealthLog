/**
 * The three ways an SSO sign-in ends once its account is known
 * (`GET /api/auth/oidc/callback`): this app's own second factor, a native
 * handoff code, or a web session. The callback turns each into its
 * redirect.
 */
import { prisma } from "@/lib/db";
import type { User } from "@/generated/prisma/client";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { createSession } from "@/lib/auth/session";
import { recordSignInDevice } from "@/lib/auth/login-alert";
import { createMfaChallenge } from "@/lib/auth/mfa/challenge";
import { syncMfaEnrollCookie } from "@/lib/auth/mfa-enrollment";
import { mintNativeHandoff } from "@/lib/auth/oidc-native-handoff";

export type MfaMethod = "totp" | "recovery" | "webauthn";

/**
 * OIDC is a DELEGATED factor: it proves the IdP authenticated someone, but it
 * never substitutes for this app's own second factor. An account with a
 * confirmed TOTP secret or a registered security key gets the same MFA
 * challenge step password login gets: no session is minted, and the
 * single-use ticket goes to the login page (web) or the custom scheme
 * (native), which render the same challenge UI and complete at
 * `/api/auth/mfa/verify`. (The trusted-device skip cannot apply on this
 * path: its cookie is SameSite=Strict, which the browser withholds on an
 * IdP-initiated redirect chain.)
 *
 * Answers the challenge, or null when the account has no second factor.
 */
export async function startOidcSecondFactor(
  user: User,
  ip: string,
  native: boolean,
): Promise<{ ticket: string; methods: MfaMethod[] } | null> {
  const hasTotp = Boolean(user.totpConfirmedAt);
  const webauthnKeyCount = await prisma.webauthnMfaCredential.count({
    where: { userId: user.id },
  });
  const hasWebauthn = webauthnKeyCount > 0;
  if (!hasTotp && !hasWebauthn) return null;

  const challenge = await createMfaChallenge(user.id, "login");
  const methods: MfaMethod[] = [];
  if (hasTotp) methods.push("totp", "recovery");
  if (hasWebauthn) methods.push("webauthn");
  await auditLog("auth.mfa.challenge", {
    userId: user.id,
    ipAddress: ip,
    details: { source: native ? "login.oidc.native" : "login.oidc" },
  });
  annotate({
    action: { name: "auth.mfa.challenge" },
    meta: { mfa_required: true },
  });
  return { ticket: challenge.ticket, methods };
}

/**
 * Native, no MFA: a one-time handoff code for the app. NO session and NO
 * cookie are minted here: the app exchanges the code at
 * `POST /api/auth/oidc/native/token` for the native bundle. The app's S256
 * challenge (bound at login, tamper-authenticated in the state blob) locks
 * the code to the app instance that started the flow. The session and
 * device are recorded at the exchange via `finishLogin`, not here.
 */
export async function mintOidcNativeHandoff(input: {
  userId: string;
  appCodeChallenge: string;
  ip: string;
  userAgent: string | null;
}): Promise<string> {
  const { code } = await mintNativeHandoff({
    userId: input.userId,
    appCodeChallenge: input.appCodeChallenge,
    ipAddress: input.ip,
    userAgent: input.userAgent,
  });
  await auditLog("auth.oidc.native.handoff_minted", {
    userId: input.userId,
    ipAddress: input.ip,
  });
  annotate({ action: { name: "auth.oidc.native.handoff_minted" } });
  return code;
}

/** A web sign-in without a second factor: the session and its ledger row. */
export async function openOidcSession(
  user: User,
  ip: string,
  userAgent: string | null,
): Promise<void> {
  // Parity with password login: the admin-enforced-MFA hint cookie sends a
  // single-factor account into forced enrollment after sign-in.
  await syncMfaEnrollCookie(user.id, {
    totpConfirmedAt: user.totpConfirmedAt,
    mfaEnforced: user.mfaEnforced,
  });

  // The 5th argument stays null: OIDC is a delegated factor, so an SSO
  // session must never satisfy `requireFreshMfa` step-up (MFA disable,
  // encryption-key rotation, encrypted export, account deletion), the same
  // treatment a trusted-device login gets.
  await createSession(
    user.id,
    user.onboardingCompletedAt === null,
    ip,
    userAgent,
    null,
  );

  void recordSignInDevice({ userId: user.id, ip, userAgent });

  await auditLog("auth.oidc.login", { userId: user.id, ipAddress: ip });
}
