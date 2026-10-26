import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import {
  verifyPassword,
  hashPassword,
  checkPasswordStrength,
} from "@/lib/auth/password";
import { changePasswordSchema } from "@/lib/validations/auth";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import {
  recordReproofFailure,
  refundReproof,
  throttleReproof,
} from "@/lib/auth/existing-factor-proof";
import {
  apiHandler,
  requireFreshMfaIfEnrolled,
  MFA_STEP_UP_MAX_AGE_SECONDS,
} from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { destroyAllSessions, createSession } from "@/lib/auth/session";
import { revokeStepUpElevations } from "@/lib/auth/step-up";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { checkPasswordBreachIfEnabled } from "@/lib/password-breach-check";
import { getServerTranslator } from "@/lib/i18n/server-translator";

export const POST = apiHandler(async (request: NextRequest) => {
  // v1.25 — for an account with a second factor active a password change
  // requires a fresh step-up (within MFA_STEP_UP_MAX_AGE_SECONDS) in addition
  // to the current-password re-proof below, so a hijacked live session cannot
  // rotate the credential. Accounts without MFA keep the current-password-only
  // contract. Mirrors the step-up on MFA-disable + recovery-code regen.
  const { user } = await requireFreshMfaIfEnrolled(MFA_STEP_UP_MAX_AGE_SECONDS);

  // The current-password check below is a guessing oracle, so it draws on the
  // account's shared re-proof budget: a guess spent here is one the step-up
  // mint and the enrollment proofs cannot spend again.
  const ip = getClientIp(request);
  const limited = await throttleReproof(user.id, ip, "password_change");
  if (limited) return limited;

  const parsed = await parseJsonBody(request, changePasswordSchema, {
    maxBytes: 64 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  const { currentPassword, newPassword } = parsed.data;
  const credential = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!credential?.passwordHash) {
    return apiError("No password set for this account", 400);
  }

  const currentValid = await verifyPassword(
    credential.passwordHash,
    currentPassword,
  );
  if (!currentValid) {
    await recordReproofFailure(
      user.id,
      ip,
      "password_change",
      "password",
      "bad_password",
    );
    return apiError("Current password is incorrect", 401);
  }
  // The current password was right, so this attempt was not a guess. Give the
  // shared re-proof budget its slot back; otherwise a password change followed
  // by a few confirmations elsewhere runs the owner out of attempts.
  await refundReproof(user.id);

  if (currentPassword === newPassword) {
    return apiError("New password must differ from current password", 422);
  }

  const locale = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
  });
  const strength = checkPasswordStrength(
    newPassword,
    [user.username, user.email ?? ""],
    locale,
  );
  if (!strength.isAcceptable) {
    return apiError(
      strength.feedback[0] || "Password too weak (score < 3)",
      422,
    );
  }

  // v1.23 — reject a newly chosen password that appears in a known breach
  // corpus (HIBP k-anonymity). Fail-open: a null result (HIBP unreachable)
  // never blocks the change. Only the user's chosen NEW password is checked —
  // existing credentials are never retroactively blocked at login.
  const breach = await checkPasswordBreachIfEnabled(newPassword);
  if (breach?.breached) {
    return apiError(
      getServerTranslator(locale).t("auth.passwordBreached"),
      422,
    );
  }

  const newHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash },
  });

  // v1.30.34 — a step-up elevation is a statement about a credential that no
  // longer exists. Drop every one the account holds before the sessions go, so
  // an elevation minted moments before the rotation cannot outlive it.
  await revokeStepUpElevations(user.id);

  // Invalidate all existing sessions and create a fresh one.
  // v1.4.22 — `createSession` re-anchors the
  // `hl_onboarding` cookie itself.
  await destroyAllSessions(user.id);
  await createSession(
    user.id,
    user.onboardingCompletedAt == null,
    getClientIp(request),
    request.headers.get("user-agent"),
  );

  await auditLog("auth.password.change", {
    userId: user.id,
    ipAddress: getClientIp(request),
  });

  annotate({ action: { name: "auth.password.change" } });

  return apiSuccess({ changed: true });
});
