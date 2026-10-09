/**
 * `POST /api/auth/claim` — claim a managed profile through its handover link
 * (v1.42, #959). The person the profile describes sets a username, an email
 * and a password, and the profile becomes their own account. No data moves.
 *
 * Anonymous by design: the claimant has no credentials yet, and the one-time
 * `hlp_` token in the BODY is what authorises the request. The order of the
 * work is the registration route's, for the same reasons:
 *
 *   1. refusals that read no token (`claimGate`: SSO-only, live session, rate
 *      limit);
 *   2. the body, strictly parsed, and the link checked;
 *   3. the username and email collision probe, before any expensive work;
 *   4. password strength, the breach corpus, the Argon2id hash — outside the
 *      lock, because none of it depends on the profile;
 *   5. the claim itself, one transaction under the managed-profile lock
 *      (`claimManagedProfile`), where the token is consumed;
 *   6. after the commit: the session, the device record, and a notification
 *      to each former Guardian on their own channels.
 *
 * A closed registration does not block a claim: no account is created, the
 * link is the door.
 */
import { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { recordSignInDevice } from "@/lib/auth/login-alert";
import { checkPasswordStrength, hashPassword } from "@/lib/auth/password";
import { createSession, getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { annotate } from "@/lib/logging/context";
import { claimGate, claimInvalid } from "@/lib/managed-profiles/claim-gate";
import {
  claimManagedProfile,
  HandoverError,
  previewHandover,
} from "@/lib/managed-profiles/handover";
import { notifyGuardiansOfHandover } from "@/lib/managed-profiles/handover-notify";
import { checkPasswordBreachIfEnabled } from "@/lib/password-breach-check";
import { claimSchema } from "@/lib/validations/managed-profile-handover";

const taken = () =>
  apiError("Username or email already taken", 409, {
    errorCode: "profile_claim.taken",
  });

export const POST = apiHandler(async (request: NextRequest) => {
  // Refuses to claim over a live session — see `claimGate`.
  const gate = await claimGate(request, "claim", (await getSession()) !== null);
  if (gate.refusal) return gate.refusal;
  const ip = gate.ip ?? "unknown";

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;
  const parsed = claimSchema.safeParse(body);
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);
  const { token, username, email, password } = parsed.data;

  // The link first. Without this the collision probe below would answer 409
  // to anybody, token or not, and the claim route would be a username and
  // email oracle that registration being closed does not close. With it, only
  // the holder of a live link learns that a name is taken. The claim re-checks
  // everything under the lock; this read decides nothing on its own.
  if (!(await previewHandover(token))) return claimInvalid();

  // Before the strength check, the breach lookup and the hash, exactly as the
  // registration route orders it (its comment carries the timing argument).
  // The profile's own row never collides here: its username is the generated
  // `managed-…` one, which no chosen name may start with, and it has no email.
  const [existingEmail, existingUsername] = await Promise.all([
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
    prisma.user.findUnique({ where: { username }, select: { id: true } }),
  ]);
  if (existingEmail || existingUsername) return taken();

  const locale = await resolveServerLocale({ request });
  const strength = checkPasswordStrength(password, [username, email], locale);
  if (!strength.isAcceptable) {
    return apiError(
      strength.feedback[0] || "Password too weak (score < 3)",
      422,
    );
  }
  const breach = await checkPasswordBreachIfEnabled(password);
  if (breach?.breached) {
    return apiError(
      getServerTranslator(locale).t("auth.passwordBreached"),
      422,
    );
  }
  const passwordHash = await hashPassword(password);

  let claimed;
  try {
    claimed = await claimManagedProfile({
      rawToken: token,
      username,
      email,
      passwordHash,
      ipAddress: ip,
    });
  } catch (error) {
    if (error instanceof HandoverError) {
      annotate({
        action: { name: "profile_claim.refused" },
        meta: { reason: error.code },
      });
      return error.code === "taken" ? taken() : claimInvalid();
    }
    throw error;
  }

  // The new owner starts with onboarding owed: the claim reset it, because
  // the disclaimer and the setup were a Guardian's answers, not theirs.
  const ua = request.headers.get("user-agent");
  await createSession(claimed.profileId, true, ip, ua);
  void recordSignInDevice({
    userId: claimed.profileId,
    ip,
    userAgent: ua,
    alertOnNew: false,
  });
  await auditLog("auth.claim", {
    userId: claimed.profileId,
    actorUserId: null,
    ipAddress: ip,
    details: { method: "password" },
  });

  notifyGuardiansOfHandover("claimed", claimed.displayName, claimed.guardians);

  annotate({
    action: { name: "profile_claim.complete" },
    meta: { guardians: claimed.guardians.length },
  });
  return apiSuccess(
    { userId: claimed.profileId, username: claimed.username },
    201,
  );
});
