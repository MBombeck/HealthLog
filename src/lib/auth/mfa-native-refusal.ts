/**
 * The native half of the second-factor policy (`@/lib/auth/mfa-enrollment`).
 * Its own module, imported by the sign-in tail only, so the audit action it
 * files stays off the import graph of every other route.
 */
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { resolveMfaEnrollment } from "@/lib/auth/mfa-enrollment";

/**
 * The native half: a Bearer sign-in (password, the native web hand-off, the
 * SSO native token exchange) for an account past its due date is refused, so
 * the app shows the reason and the person enrols in a browser. During the
 * grace period the sign-in goes through. A passkey sign-in never gets here
 * without a factor: the passkey is one.
 */
export async function refuseNativeSignInWithoutFactor(
  userId: string,
  ip: string,
  source: string,
): Promise<Response | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, totpConfirmedAt: true, mfaEnforced: true },
  });
  if (!user) return null;
  const enrollment = await resolveMfaEnrollment(userId, user);
  if (enrollment.state !== "required") return null;
  await auditLog("auth.login.mfa_enrollment_required", {
    userId,
    ipAddress: ip,
    details: { source },
  });
  annotate({ action: { name: "auth.login.mfa_enrollment_required" } });
  return apiError(
    "This account needs two-factor sign-in. Set it up in the web app under Settings > Security, then sign in here again.",
    403,
    { errorCode: "auth.mfa.enrollment_required" },
  );
}
